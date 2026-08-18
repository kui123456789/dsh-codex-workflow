#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { encodeBridgeCommand, newRequestId, parseReviewResult, type DispatchPlanCommand, type SubmitVerdictCommand } from "./bridge-protocol.js";
import { BridgeStore } from "./bridge-store.js";

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

interface ParsedArgs {
  command: string;
  cwd?: string;
  dshSession?: string;
  codexThread?: string;
  workflow?: string;
  submission?: string;
  request?: string;
  json: boolean;
  stdin: boolean;
  storageDir: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: argv[0] ?? "",
    json: false,
    stdin: false,
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
  const store = new BridgeStore(args.storageDir, resolveMaxPayloadBytes());
  const requestId = await store.enqueue(command);
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
  const store = new BridgeStore(args.storageDir, resolveMaxPayloadBytes());
  await store.init();
  // Route the verdict to the runtime owning the workflow: resolve the session
  // from the shared workflow record (fall back to legacy when unavailable).
  const workflowSession = store.coordinationHandle.workflowSessionOf(args.workflow);
  const command: SubmitVerdictCommand = {
    version: 1,
    kind: "submit_verdict",
    requestId: newRequestId(),
    createdAt: new Date().toISOString(),
    workflowId: args.workflow,
    codexThreadId: threadId,
    ...(args.submission ? { submissionId: args.submission } : {}),
    ...(workflowSession ? { dshSessionId: workflowSession } : {}),
    verdict,
  };
  encodeBridgeCommand(command, resolveMaxPayloadBytes()); // enforce the payload size bound before queueing
  const requestId = await store.enqueue(command);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId, workflowId: args.workflow }, null, 2)}\n`);
  } else {
    process.stdout.write(`verdict queued as ${requestId} for workflow ${args.workflow}\n`);
  }
}

async function commandStatus(args: ParsedArgs): Promise<void> {
  if (!args.request) fail("status requires --request <uuid>");
  const store = new BridgeStore(args.storageDir);
  const receipt = await store.receipt(args.request);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ requestId: args.request, receipt: receipt ?? null }, null, 2)}\n`);
  } else if (receipt) {
    process.stdout.write(`${receipt.status}${receipt.error ? `: ${receipt.error}` : ""}\n`);
  } else {
    process.stdout.write("no receipt for this request\n");
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "sessions": await commandSessions(args); break;
    case "dispatch": await commandDispatch(args); break;
    case "respond": await commandRespond(args); break;
    case "status": await commandStatus(args); break;
    default: fail(`unknown command ${args.command || "(missing)"}; expected sessions|dispatch|respond|status`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dsh-codex-workflow: ${message}\n`);
  process.exitCode = 1;
});
