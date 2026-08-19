#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodeBridgeCommand, newRequestId, parseReviewResult, type DispatchPlanCommand, type SubmitVerdictCommand } from "./bridge-protocol.js";
import { BridgeStore } from "./bridge-store.js";
import { PLUGIN_VERSION } from "./version.js";

const WORKFLOW_PHASES = new Set([
  "planning", "waiting_input", "executing", "reviewing", "fixing",
  "waiting_review_decision", "passed", "blocked", "failed", "cancelled",
]);
const QUEUE_STATUSES = ["inbox", "retry", "processing", "done", "dead-letter", "failed"] as const;

function fail(message: string): never {
  throw new Error(message);
}

function resolveStorageDir(): string {
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
  return join(dshHome, "storages", "dsh-codex-workflow");
}

function resolveMaxPayloadBytes(): number {
  const raw = Number(process.env.DSH_CODEX_WORKFLOW_MAX_PAYLOAD_BYTES);
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return 1024 * 1024;
}

/**
 * Read the LIVE sessions from the shared SQLite registry: only rows whose
 * lease is still valid count; crashed/stopped runtimes expire via TTL and are
 * never reported to the CLI.
 */
async function readLiveSessions(directory: string): Promise<Array<{ id: string; cwd: string; updatedAt: string }>> {
  try {
    const store = new BridgeStore(directory, resolveMaxPayloadBytes());
    await store.init();
    const live = store.coordinationHandle.listLiveSessions();
    store.close();
    return live.map((row) => ({ id: row.sessionId, cwd: row.cwd, updatedAt: new Date(row.updatedAt).toISOString() }));
  } catch {
    return [];
  }
}

function sameCwd(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

async function withStore<T>(directory: string, operation: (store: BridgeStore) => Promise<T>, maxPayloadBytes = resolveMaxPayloadBytes()): Promise<T> {
  const store = new BridgeStore(directory, maxPayloadBytes);
  try {
    await store.init();
    return await operation(store);
  } finally {
    store.close();
  }
}

interface ParsedArgs {
  command: string;
  cwd?: string;
  dshSession?: string;
  codexThread?: string;
  workflow?: string;
  submission?: string;
  request?: string;
  phase?: string;
  status?: string;
  olderThanMs?: number;
  dryRun: boolean;
  commit: boolean;
  json: boolean;
  stdin: boolean;
  storageDir: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: argv[0] ?? "",
    json: false,
    stdin: false,
    dryRun: true,
    commit: false,
    storageDir: resolveStorageDir(),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--cwd": args.cwd = argv[++index] ?? fail("--cwd requires a value"); break;
      case "--dsh-session": args.dshSession = argv[++index] ?? fail("--dsh-session requires a value"); break;
      case "--codex-thread": args.codexThread = argv[++index] ?? fail("--codex-thread requires a value"); break;
      case "--workflow": args.workflow = argv[++index] ?? fail("--workflow requires a value"); break;
      case "--submission": args.submission = argv[++index] ?? fail("--submission requires a value"); break;
      case "--request": args.request = argv[++index] ?? fail("--request requires a value"); break;
      case "--phase": args.phase = argv[++index] ?? fail("--phase requires a value"); break;
      case "--status": args.status = argv[++index] ?? fail("--status requires a value"); break;
      case "--older-than": {
        const raw = Number(argv[++index] ?? fail("--older-than requires a millisecond value"));
        if (!Number.isFinite(raw) || raw < 0) fail("--older-than must be a non-negative millisecond value");
        args.olderThanMs = Math.trunc(raw);
        break;
      }
      case "--dry-run": args.dryRun = true; args.commit = false; break;
      case "--commit": args.commit = true; args.dryRun = false; break;
      case "--json": args.json = true; break;
      case "--stdin": args.stdin = true; break;
      case "--storage-dir": args.storageDir = resolve(argv[++index] ?? fail("--storage-dir requires a value")); break;
      default: fail(`unknown argument ${token}`);
    }
  }
  return args;
}

async function readStdin(maxBytes = resolveMaxPayloadBytes()): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      // Stop reading immediately instead of buffering the whole payload.
      process.stdin.destroy();
      throw new Error(`stdin payload exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function commandSessions(args: ParsedArgs): Promise<void> {
  if (!args.cwd) fail("sessions requires --cwd <absolute-path>");
  const sessions = await readLiveSessions(args.storageDir);
  const matches = sessions.filter((entry) => sameCwd(entry.cwd, args.cwd!));
  const output = matches.map(({ id, cwd, updatedAt }) => ({ id, cwd, updatedAt }));
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    if (output.length === 0) process.stdout.write("no live sessions match this cwd\n");
    for (const session of output) process.stdout.write(`${session.id}\t${session.cwd}\n`);
  }
}

function effectiveThread(args: ParsedArgs): string {
  if (args.codexThread) return args.codexThread;
  const fromEnv = process.env.CODEX_THREAD_ID;
  if (fromEnv) return fromEnv;
  fail("missing --codex-thread: set CODEX_THREAD_ID or pass --codex-thread <uuid>; the bridge never invents a thread id");
}

async function commandDispatch(args: ParsedArgs): Promise<void> {
  if (!args.cwd) fail("dispatch requires --cwd <absolute-path>");
  if (!args.stdin) fail("dispatch requires --stdin: the plan payload must enter through stdin, never command arguments");
  const threadId = effectiveThread(args);
  const payload = JSON.parse(await readStdin()) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("stdin must be a JSON object { task, planMarkdown, assumptions? }");
  const record = payload as Record<string, unknown>;
  if (typeof record.task !== "string" || record.task.trim().length === 0) fail("stdin payload requires a non-empty task");
  if (typeof record.planMarkdown !== "string" || record.planMarkdown.trim().length === 0) fail("stdin payload requires a non-empty planMarkdown");
  const assumptions = Array.isArray(record.assumptions)
    ? record.assumptions.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of Object.keys(record)) {
    if (!["task", "planMarkdown", "assumptions"].includes(key)) fail(`unknown stdin payload field ${key}`);
  }
  // Resolve the exact target session: explicit id wins; otherwise the cwd must
  // match exactly one live session, otherwise the dispatch fails loudly.
  let dshSessionId: string | undefined;
  if (args.dshSession) {
    dshSessionId = args.dshSession;
  } else {
    const matches = (await readLiveSessions(args.storageDir)).filter((entry) => sameCwd(entry.cwd, args.cwd!));
    if (matches.length === 0) fail(`no live DSH session matches cwd ${args.cwd}`);
    if (matches.length > 1) fail(`multiple live DSH sessions match cwd ${args.cwd}; pass --dsh-session <id>`);
    dshSessionId = matches[0]!.id;
  }
  const command: DispatchPlanCommand = {
    version: 1,
    kind: "dispatch_plan",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    codexThreadId: threadId,
    target: { cwd: resolve(args.cwd), ...(dshSessionId ? { dshSessionId } : {}) },
    task: record.task,
    planMarkdown: record.planMarkdown,
    assumptions,
  };
  encodeBridgeCommand(command, resolveMaxPayloadBytes()); // enforce the payload size bound before queueing
  const requestId = await withStore(args.storageDir, (store) => store.enqueue(command));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId, dshSessionId }, null, 2)}\n`);
  } else {
    process.stdout.write(`dispatched ${requestId} to session ${dshSessionId ?? "(unresolved)"}\n`);
  }
}

async function commandRespond(args: ParsedArgs): Promise<void> {
  if (!args.workflow) fail("respond requires --workflow <uuid>");
  if (!args.stdin) fail("respond requires --stdin: the verdict must enter through stdin, never command arguments");
  const threadId = effectiveThread(args);
  const verdict = parseReviewResult(JSON.parse(await readStdin()));
  const requestId = await withStore(args.storageDir, async (store) => {
    // Route the verdict to the runtime owning the workflow: resolve the session
    // from the shared workflow record (fall back to legacy when unavailable).
    const workflowSession = store.coordinationHandle.workflowSessionOf(args.workflow!);
    const command: SubmitVerdictCommand = {
      version: 1,
      kind: "submit_verdict",
      requestId: newRequestId(),
      createdAt: new Date().toISOString(),
      workflowId: args.workflow!,
      codexThreadId: threadId,
      ...(args.submission ? { submissionId: args.submission } : {}),
      ...(workflowSession ? { dshSessionId: workflowSession } : {}),
      verdict,
    };
    encodeBridgeCommand(command, resolveMaxPayloadBytes());
    return store.enqueue(command);
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId, workflowId: args.workflow }, null, 2)}\n`);
  } else {
    process.stdout.write(`verdict queued as ${requestId} for workflow ${args.workflow}\n`);
  }
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  if (!args.request) fail("status requires --request <uuid>");
  const receipt = await withStore(args.storageDir, (store) => store.receipt(args.request!));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId: args.request, receipt: receipt ?? null }, null, 2)}\n`);
  } else if (receipt) {
    process.stdout.write(`${receipt.status}${receipt.error ? `: ${receipt.error}` : ""}\n`);
  } else {
    process.stdout.write("no receipt for this request\n");
    process.exitCode = 1;
  }
}

interface WorkflowSummary {
  id: string;
  phase: string;
  dshSessionId?: string;
  cwd?: string;
  origin?: string;
  reviewCycles: number;
  submissionState?: string;
  error?: string;
  updatedAt: string;
}

async function loadWorkflowSummaries(storageDir: string): Promise<WorkflowSummary[]> {
  return withStore(storageDir, async (store) => {
    const rows = store.coordinationHandle.listWorkflows();
    const summaries: WorkflowSummary[] = [];
    for (const row of rows) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(row.recordJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const optional = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
      summaries.push({
        id: row.id,
        phase: typeof record.phase === "string" ? record.phase : "unknown",
        dshSessionId: optional(record.dshSessionId),
        cwd: optional(record.cwd),
        origin: optional(record.origin),
        reviewCycles: typeof record.reviewCycles === "number" ? record.reviewCycles : 0,
        submissionState: optional(record.submissionState),
        error: optional(record.error),
        updatedAt: new Date(row.updatedAt).toISOString(),
      });
    }
    return summaries;
  });
}

async function commandWorkflows(args: ParsedArgs): Promise<void> {
  if (args.phase && !WORKFLOW_PHASES.has(args.phase)) fail(`unknown workflow phase ${args.phase}`);
  const summaries = (await loadWorkflowSummaries(args.storageDir)).filter((entry) => {
    if (args.cwd && !sameCwd(entry.cwd ?? "", args.cwd)) return false;
    if (args.dshSession && entry.dshSessionId !== args.dshSession) return false;
    if (args.phase && entry.phase !== args.phase) return false;
    return true;
  });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
  } else {
    if (summaries.length === 0) process.stdout.write("no workflows match the filters\n");
    for (const entry of summaries) {
      process.stdout.write(`${entry.id}\t${entry.phase}\t${entry.dshSessionId ?? "-"}\tcycle=${entry.reviewCycles}${entry.error ? `\terror=${entry.error}` : ""}\n`);
    }
  }
}

async function commandShow(args: ParsedArgs): Promise<void> {
  if (!args.workflow) fail("show requires --workflow <uuid>");
  const row = await withStore(args.storageDir, async (store) => store.coordinationHandle.loadWorkflow(args.workflow!));
  if (!row) {
    process.stdout.write(`no workflow ${args.workflow}\n`);
    process.exitCode = 1;
    return;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(row.recordJson) as Record<string, unknown>;
  } catch {
    record = {};
  }
  const optional = (key: string) => (typeof record[key] === "string" && String(record[key]).length > 0 ? String(record[key]) : undefined);
  const summary: Record<string, unknown> = {
    pluginVersion: PLUGIN_VERSION,
    id: row.id,
    revision: row.revision,
    phase: record.phase ?? "unknown",
    origin: optional("origin"),
    dshSessionId: optional("dshSessionId"),
    cwd: optional("cwd"),
    originatingCodexTaskId: optional("codexThreadId"),
    reviewerCodexTaskId: optional("reviewerThreadId"),
    reviewerTurnId: optional("reviewerTurnId"),
    reviewCycles: record.reviewCycles ?? 0,
    noChangeReviewRounds: record.noChangeReviewRounds ?? 0,
    submission: optional("submissionId")
      ? {
        submissionId: optional("submissionId"),
        state: optional("submissionState"),
        error: optional("submissionError"),
        callbackState: optional("callbackState"),
      }
      : null,
    error: optional("error"),
    latestReview: record.latestReview
      ? (() => {
        const review = record.latestReview as Record<string, unknown>;
        const findings = Array.isArray(review.findings) ? (review.findings as unknown[]) : [];
        return {
          verdict: review.verdict ?? null,
          findings: findings.length,
          blockingFindings: findings.filter((item) => (item as Record<string, unknown>).blocking === true).length,
        };
      })()
      : null,
    evidence: record.latestReviewEvidence
      ? (() => {
        const evidence = record.latestReviewEvidence as Record<string, unknown>;
        return {
          kind: evidence.kind ?? null,
          insufficient: evidence.insufficient === true,
          fingerprint: Boolean(evidence.fingerprint),
          diffBytes: evidence.diffBytes ?? null,
        };
      })()
      : null,
    stagedVerdict: record.stagedVerdict
      ? {
        requestId: (record.stagedVerdict as Record<string, unknown>).command
          ? ((record.stagedVerdict as Record<string, unknown>).command as Record<string, unknown>).requestId ?? null
          : null,
      }
      : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    for (const [key, value] of Object.entries(summary)) {
      if (value === null || value === undefined) continue;
      process.stdout.write(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    }
  }
}

async function commandQueue(args: ParsedArgs): Promise<void> {
  if (args.status && !QUEUE_STATUSES.includes(args.status as typeof QUEUE_STATUSES[number])) fail(`unknown queue status ${args.status}`);
  const rows = await withStore(args.storageDir, async (store) => QUEUE_STATUSES.flatMap((status) => store.coordinationHandle.queueRowsByStatus(status)));
  const filtered = args.status ? rows.filter((row) => row.status === args.status) : rows;
  const payload = filtered
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row) => ({
      requestId: row.requestId,
      status: row.status,
      attempts: row.attempts,
      claimOwner: row.claimOwner || undefined,
      claimEpoch: row.claimEpoch,
      nextAttemptAt: row.nextAttemptAt ?? undefined,
      lastError: row.lastError ?? undefined,
      deadLetterAt: row.deadLetterAt ?? undefined,
      receipt: parseReceiptStatus(row.receiptJson),
    }));
  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    if (payload.length === 0) process.stdout.write("no queue rows match\n");
    for (const entry of payload) {
      process.stdout.write(
        `${entry.requestId}\t${entry.status}\tattempts=${entry.attempts}\tnext=${entry.nextAttemptAt ? new Date(entry.nextAttemptAt).toISOString() : "-"}${entry.lastError ? `\terror=${entry.lastError}` : ""}\n`,
      );
    }
  }
}

async function commandRetry(args: ParsedArgs): Promise<void> {
  if (!args.request) fail("retry requires --request <uuid>");
  const result = await withStore(args.storageDir, (store) => store.requeue(args.request!));
  const missing = !result.changed && !result.from;
  if (missing) process.exitCode = 1;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId: args.request, changed: result.changed, from: result.from ?? null, missing }, null, 2)}\n`);
  } else if (result.changed) {
    process.stdout.write(`requeued ${args.request} (was ${result.from})\n`);
  } else if (result.from) {
    process.stdout.write(`already queued: ${args.request} (${result.from})\n`);
  } else {
    process.stdout.write(`no request ${args.request}\n`);
  }
}

async function commandPrune(args: ParsedArgs): Promise<void> {
  const retentionMs = args.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const dryRun = args.dryRun || !args.commit;
  const result = await withStore(args.storageDir, async (store) => {
    const candidates = await store.pruneCandidates(retentionMs);
    const applied = dryRun
      ? undefined
      : await store.pruneApply(
        candidates.requests,
        candidates.workflows,
        retentionMs,
      );
    return { candidates, applied };
  });
  const { candidates, applied } = result;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      dryRun,
      olderThanMs: retentionMs,
      requests: candidates.requests.map((row) => ({ requestId: row.requestId, status: row.status, terminalAt: new Date(row.terminalAt).toISOString() })),
      workflows: candidates.workflows,
      ...(applied ? { removedRequests: applied.removedRequests, removedWorkflows: applied.removedWorkflows } : {}),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`prune ${dryRun ? "(dry-run; pass --commit to apply)" : ""} older than ${retentionMs}ms\n`);
    for (const row of candidates.requests) process.stdout.write(`  request ${row.requestId} (${row.status})\n`);
    for (const workflow of candidates.workflows) process.stdout.write(`  workflow ${workflow.id} (${workflow.phase})\n`);
    if (candidates.requests.length === 0 && candidates.workflows.length === 0) process.stdout.write("  nothing eligible\n");
  }
  if (applied) {
    if (!args.json) {
      process.stdout.write(`pruned ${applied.removedRequests} requests, ${applied.removedWorkflows} workflows\n`);
    }
  }
}

function parseReceiptStatus(receiptJson: string | undefined): string | undefined {
  if (!receiptJson) return undefined;
  try {
    const parsed = JSON.parse(receiptJson) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return "invalid-json";
  }
}

function commandHelp(): void {
  process.stdout.write(`dsh-codex-workflow CLI

usage: dsh-codex-workflow <command> [options]

  sessions  --cwd <absolute-path>           list live DSH sessions for a cwd
  dispatch  --cwd <path> --stdin [--dsh-session]  queue a plan for a session
  respond   --workflow <uuid> --stdin [--codex-thread|CODEX_THREAD_ID]
                                            queue a manually-authored verdict
  status    --request <uuid>                receipt for one request
  workflows [--cwd] [--dsh-session] [--phase] [--json]
                                            list workflows with filters
  show      --workflow <uuid> [--json]      one workflow's stage/submission/review
  queue     [--status <status>] [--json]    queue rows w/o payloads (no secrets)
  retry     --request <uuid> [--json]       requeue a dead-letter/failed request
  prune     [--older-than <ms>] [--dry-run|--commit] [--json]
                                            remove only terminal receipts/records
common: --storage-dir <dir>, --json
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.command === "--help" || args.command === "-h" || args.command === "") {
    commandHelp();
    return;
  }
  switch (args.command) {
    case "sessions": await commandSessions(args); break;
    case "dispatch": await commandDispatch(args); break;
    case "respond": await commandRespond(args); break;
    case "status": await commandStatus(args); break;
    case "workflows": await commandWorkflows(args); break;
    case "show": await commandShow(args); break;
    case "queue": await commandQueue(args); break;
    case "retry": await commandRetry(args); break;
    case "prune": await commandPrune(args); break;
    default: fail(`unknown command ${args.command || "(missing)"}; run 'help' for usage`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dsh-codex-workflow: ${message}\n`);
  process.exitCode = 1;
});
