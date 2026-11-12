import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, newRecord } from "./state.js";
import { captureTree, processState, spawnCommand, stopTree } from "./process.js";
import { collectEvidence } from "./evidence.js";
import { keys, object, reviewInput, text } from "./validation.js";
import { worker } from "./worker.js";
import type { Operation, WorkflowRecord } from "./types.js";

const entry = fileURLToPath(import.meta.url);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const settingsKeys = ["plannerModel", "reviewerModel", "plannerEffort", "reviewerEffort", "turnTimeoutMs", "transientRetryBudgetMs", "maxReviewCycles", "maxNoChangeReviewRounds"];
interface Args { command: string; flags: Record<string, string | boolean> }
function args(values: string[]): Args {
  const command = values.shift() ?? "help", flags: Record<string, string | boolean> = {};
  const bools = new Set(["--stdin", "--offline", "--help"]);
  const allowed = new Set(["--cwd", "--input", "--workflow", "--home", "--wait-ms", "--codex-command", "--operation", ...bools]);
  while (values.length) {
    const name = values.shift()!;
    if (!allowed.has(name) || Object.hasOwn(flags, name)) throw new Error(`Unknown or duplicate option: ${name}`);
    const value = bools.has(name) ? true : values.shift();
    if (value === undefined || (typeof value === "string" && value.startsWith("--"))) throw new Error(`Missing value for ${name}`);
    flags[name] = value;
  }
  return { command, flags };
}
function option(parsed: Args, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}
async function input(parsed: Args): Promise<Record<string, unknown>> {
  if (Boolean(parsed.flags["--stdin"]) === Boolean(parsed.flags["--input"])) throw new Error("Choose exactly one of --stdin or --input");
  let contents = "";
  if (parsed.flags["--stdin"]) {
    for await (const chunk of process.stdin) {
      contents += String(chunk);
      if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("Input exceeds 1 MiB");
    }
  } else contents = await readFile(resolve(option(parsed, "--input")!), "utf8");
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("Input exceeds 1 MiB");
  return object(JSON.parse(contents));
}
async function cwd(parsed: Args): Promise<string> {
  const value = text(option(parsed, "--cwd"), "--cwd");
  if (!isAbsolute(value)) throw new Error("--cwd must be an absolute path");
  return realpath(value);
}
function codexArgs(): string[] {
  const value: unknown = JSON.parse(process.env.CODEX_WORKFLOW_CODEX_ARGS ?? "[]");
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("CODEX_WORKFLOW_CODEX_ARGS must be a JSON string array");
  return value as string[];
}
function launch(home: string, record: WorkflowRecord, store: StateStore): void {
  const folder = join(home, "workflows", record.id, record.operation!.id);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const fd = openSync(join(folder, "worker.log"), "a", 0o600);
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("CODEX_WORKFLOW_TEST_RECEIPT")) delete env[key];
    const child = spawn(process.execPath, [entry, "_worker", "--home", home, "--workflow", record.id, "--operation", record.operation!.id], {
      detached: true, windowsHide: true, stdio: ["ignore", fd, fd], env,
    });
    child.on("error", (error) => {
      try { store.update(record.id, (value) => {
        if (value.operation?.id !== record.operation!.id || value.phase === "cancelled") return;
        value.phase = "failed"; value.processState = "failed"; value.error = error.message;
        value.operation.finished = true; value.operation.cleanupConfirmed = true;
      }); } catch { /* The original command may already have closed its store. Status retains the queued operation. */ }
    });
    child.unref();
  } finally { closeSync(fd); }
}
function operation(stage: Operation["stage"], payload: Record<string, unknown>, threadId?: string): Operation {
  return { id: randomUUID(), stage, input: payload, ...(threadId ? { threadId } : {}), startedAt: Date.now(), finished: false, spawnRequested: false };
}
async function continuation(record: WorkflowRecord): Promise<{ available: boolean; reason: string }> {
  const op = record.operation;
  if (record.phase === "cancelled") return { available: false, reason: op?.spawnRequested && !op.cleanupConfirmed ? "cleanup_unconfirmed" : "cancelled" };
  if (!op) return { available: false, reason: "not_waiting" };
  if (!op.finished) {
    if (!op.worker && Date.now() - op.startedAt < 10000) return { available: false, reason: "running" };
    if (op.worker) {
      const state = await processState(op.worker);
      if (state === "alive") return { available: false, reason: "running" };
      if (state === "unknown") return { available: false, reason: "cleanup_unconfirmed" };
    }
  }
  if (record.phase === "waiting_input") return { available: false, reason: "waiting_input" };
  if (op.finished && !op.recoverable) return { available: false, reason: op.failureReason ?? "not_waiting" };
  if (!op.threadId) return { available: false, reason: "start_receipt_missing" };
  if (op.stage === "reviewing") {
    const evidence = await collectEvidence({ cwd: record.cwd, maxDiffBytes: 65536, changedFiles: record.reviewInput?.changedFiles });
    if (evidence.insufficient) return { available: false, reason: "evidence_unavailable" };
    if (evidence.fingerprint !== op.evidence?.fingerprint) return { available: false, reason: "workspace_changed" };
  }
  if (op.spawnRequested && !op.cleanupConfirmed) return { available: false, reason: "cleanup_unconfirmed" };
  return { available: true, reason: "available" };
}
async function envelope(home: string, record: WorkflowRecord, refreshes = 2): Promise<Record<string, unknown>> {
  let capability = await continuation(record);
  {
    const snapshot = new StateStore(home, true);
    try {
      const latest = snapshot.get(record.id);
      if (latest && latest.revision !== record.revision) {
        if (refreshes > 0) return envelope(home, latest, refreshes - 1);
        record = latest;
        capability = { available: false, reason: record.processState === "running" ? "running" : "state_changed" };
      }
    } finally { snapshot.close(); }
  }
  let phase = record.phase, state = record.processState, invalidated = false;
  if (state === "running" && capability.reason !== "running" && capability.reason !== "cleanup_unconfirmed") state = "waiting";
  if (record.evidence && ["passed", "waiting_review_decision"].includes(record.phase)) {
    const current = await collectEvidence({ cwd: record.cwd, maxDiffBytes: 65536, changedFiles: record.reviewInput?.changedFiles });
    if (current.insufficient || current.fingerprint !== record.evidence.fingerprint) {
      capability = { available: false, reason: "workspace_changed" }; phase = "blocked"; state = "waiting"; invalidated = true;
    }
  }
  const instructions: Record<string, string> = {
    planning: capability.reason === "running" ? "Wait for the original Planner; query status." : "Inspect continuation before resuming the original Planner.",
    waiting_input: "Ask the user the Planner questions, then submit their answers with continue.",
    executing: "The host agent implements the plan and runs relevant checks, then submits review.",
    reviewing: capability.reason === "running" ? "Wait for the original Reviewer; query status." : "Inspect continuation before resuming the original Reviewer.",
    fixing: record.mode === "review_only" ? "Report the findings. Implement fixes only if the user authorizes them, then submit review." : "The host agent fixes blocking findings, runs relevant checks, then submits review.",
    waiting_review_decision: "Present nonblocking findings to the user; decide accept or fix using their choice.",
    passed: "Report the verified result and actual test evidence to the user.", blocked: "Stop automatic repair and report remaining findings or invalidated evidence.",
    failed: "Report the exact failure. Do not fabricate a replacement thread or a passing result.", cancelled: "Workflow cancelled; report any unconfirmed process cleanup.",
  };
  return { workflowId: record.id, phase, processState: state, continuation: capability, nextAction: instructions[phase],
    result: { plan: record.plan ?? null, review: invalidated ? null : record.review ?? null, reviewValid: Boolean(record.review) && !invalidated },
    artifactPaths: { directory: join(home, "workflows", record.id), ...(record.operation ? { operation: join(home, "workflows", record.id, record.operation.id) } : {}) },
    cwd: record.cwd, mode: record.mode, reviewCycles: record.reviewCycles, plannerThreadId: record.plannerThreadId ?? null,
    reviewerThreadId: record.reviewerThreadId ?? null, error: record.error ?? null };
}
function selected(store: StateStore, parsed: Args, workspace?: string): WorkflowRecord {
  const id = option(parsed, "--workflow");
  if (id && parsed.flags["--cwd"]) throw new Error("Choose --workflow or --cwd, not both");
  const record = id ? store.get(id) : workspace ? store.activeForCwd(workspace) ?? store.latestForCwd(workspace) : undefined;
  if (!record) throw new Error("No matching workflow; specify --workflow or --cwd");
  return record;
}
async function cleanup(record: WorkflowRecord): Promise<boolean> {
  const op = record.operation;
  if (!op?.spawnRequested || op.cleanupConfirmed) return true;
  if (op.worker && await processState(op.worker) !== "dead") return false;
  return op.tree ? stopTree(op.tree) : false;
}
async function prepareReview(store: StateStore, seed: WorkflowRecord, payload: Record<string, unknown>): Promise<WorkflowRecord> {
  const material = reviewInput(payload);
  const evidence = await collectEvidence({ cwd: seed.cwd, maxDiffBytes: 65536, changedFiles: material.changedFiles });
  return store.update(seed.id, (record) => {
    if (record.revision !== seed.revision || (record.operation && !record.operation.finished)) throw new Error("Workflow is busy or ownership changed");
    if (!["executing", "fixing", "reviewing"].includes(record.phase)) throw new Error(`Cannot review phase ${record.phase}`);
    if (record.operation?.spawnRequested && !record.operation.cleanupConfirmed) throw new Error("Original process cleanup is unconfirmed");
    if (record.phase === "reviewing" && record.operation?.evidence?.fingerprint === evidence.fingerprint) throw new Error("Unchanged failed review must resume its original Reviewer");
    record.reviewInput = material;
    record.error = undefined;
    if (evidence.insufficient || evidence.rejectedPaths.length) {
      record.phase = "blocked"; record.processState = "waiting"; record.error = "Review evidence is insufficient or includes paths outside the workspace"; return;
    }
    record.phase = "reviewing"; record.processState = "running";
    record.operation = { ...operation("reviewing", payload), evidence };
    record.reviewerThreadId = undefined;
  });
}
async function commandText(command: string, arguments_: string[]): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawnCommand(command, arguments_, { cwd: process.cwd() });
    let output = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Codex capability check timeout")); }, 5000);
    child.stdout?.on("data", (data) => { output = (output + String(data)).slice(-65536); });
    child.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(-2048); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? accept(output.trim()) : reject(new Error(stderr || "Codex capability check failed")); });
    child.stdin?.on("error", () => undefined); child.stdin?.end();
  });
}
async function main(): Promise<void> {
  const parsed = args(process.argv.slice(2));
  const home = resolve(option(parsed, "--home") ?? process.env.CODEX_WORKFLOW_HOME ?? join(homedir(), ".codex-workflow"));
  if (parsed.command === "_worker") { await worker(home, text(option(parsed, "--workflow"), "--workflow"), text(option(parsed, "--operation"), "--operation")); return; }
  if (parsed.command === "help" || parsed.flags["--help"]) {
    process.stdout.write(JSON.stringify({ commands: ["doctor", "start", "continue", "review", "review-only", "resume", "status", "decide", "cancel"], input: "Mutations accept JSON via --stdin or --input <file>; start/review-only require --cwd <absolute>; other workflow operations require --workflow <id>; status also accepts --cwd.", stateHome: home }) + "\n"); return;
  }
  if (parsed.command === "doctor") {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (!(major! >= 24 || major === 22 && minor! >= 19)) throw new Error("Node.js ^22.19.0 or >=24 is required");
    let result: Record<string, unknown> = { node: process.version, platform: process.platform, modelCall: false, codex: "NOT RUN (offline)" };
    if (!parsed.flags["--offline"]) {
      const command = option(parsed, "--codex-command") ?? "codex", prefix = codexArgs();
      const version = await commandText(command, [...prefix, "--version"]);
      const help = await commandText(command, [...prefix, "exec", "--help"]);
      const resume = await commandText(command, [...prefix, "exec", "resume", "--help"]);
      if (!["--json", "--output-schema", "--sandbox"].every((flag) => help.includes(flag)) || !resume.includes("SESSION_ID")) throw new Error("Codex CLI lacks required exec/schema/resume capabilities");
      result = { ...result, codex: version, capabilities: "exec/json/schema/read-only/resume", authentication: "NOT RUN; model smoke is separate" };
    }
    process.stdout.write(JSON.stringify({ workflowId: null, phase: "doctor", processState: "completed", continuation: { available: false, reason: "not_waiting" }, nextAction: "Load the Skill and start a workflow in an authorized workspace.", result, artifactPaths: {} }) + "\n"); return;
  }
  if (!["start", "review-only", "status", "continue", "review", "resume", "decide", "cancel"].includes(parsed.command)) throw new Error(`Unknown command: ${parsed.command}`);
  const workspace = parsed.flags["--cwd"] ? await cwd(parsed) : undefined;
  const create = parsed.command === "start" || parsed.command === "review-only";
  if (create && !workspace) throw new Error("--cwd is required");
  if (workspace && create) {
    const path = relative(workspace, home);
    if (!path || (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep))) throw new Error("Workflow state home must be outside the reviewed workspace");
  }
  const readOnly = parsed.command === "status";
  if (readOnly && !existsSync(join(home, "coord.sqlite"))) throw new Error("No workflow state exists in this home");
  const store = new StateStore(home, readOnly);
  try {
    let record: WorkflowRecord;
    if (create) {
      const payload = await input(parsed);
      keys(payload, ["task", ...settingsKeys, ...(parsed.command === "review-only" ? ["implementationSummary", "changedFiles", "testResults"] : [])]);
      if (parsed.command === "review-only" && payload.task === undefined) payload.task = "Review the current workspace without implementing changes";
      text(payload.task, "task");
      if (parsed.command === "review-only") reviewInput(payload);
      const candidate = newRecord(workspace!, payload, option(parsed, "--codex-command") ?? "codex", codexArgs());
      candidate.mode = parsed.command === "review-only" ? "review_only" : "planned";
      const existing = store.activeForCwd(workspace!);
      if (existing) {
        if (existing.requestKey !== candidate.requestKey || existing.mode !== candidate.mode) throw new Error(`Workspace conflict: active workflow ${existing.id}`);
        record = existing;
      } else {
        candidate.operation = create && parsed.command === "start" ? operation("planning", payload) : undefined;
        if (candidate.mode === "review_only") { candidate.phase = "executing"; candidate.processState = "waiting"; }
        try { store.insert(candidate); }
        catch (error) {
          const winner = store.activeForCwd(workspace!);
          if (!winner || winner.requestKey !== candidate.requestKey || winner.mode !== candidate.mode) throw error;
          process.stdout.write(JSON.stringify(await envelope(home, winner)) + "\n"); return;
        }
        record = candidate.mode === "review_only" ? await prepareReview(store, candidate, payload) : candidate;
        if (record.processState === "running") launch(home, record, store);
      }
    } else {
      record = selected(store, parsed, workspace);
      if (parsed.command === "status") {
        const raw = option(parsed, "--wait-ms") ?? "0";
        if (!/^\d+$/.test(raw) || Number(raw) > 30000) throw new Error("--wait-ms must be between 0 and 30000");
        const end = performance.now() + Number(raw);
        while (record.processState === "running" && performance.now() < end) {
          await pause(Math.min(100, Math.max(0, end - performance.now()))); record = store.get(record.id)!;
        }
      } else if (parsed.command === "cancel") {
        record = store.update(record.id, (value) => { if (value.phase === "passed") throw new Error("Completed passed workflow cannot be cancelled"); value.phase = "cancelled"; value.processState = "cancelled"; });
        const cancelledOperation = record.operation?.id;
        const end = performance.now() + 9000;
        while (record.operation?.worker && !record.operation.finished && performance.now() < end) { await pause(150); record = store.get(record.id)!; }
        if (await cleanup(record)) record = store.update(record.id, (value) => { if (value.phase === "cancelled" && value.operation?.id === cancelledOperation) { value.operation!.cleanupConfirmed = true; value.operation!.finished = true; } });
      } else if (parsed.command === "review") {
        const payload = await input(parsed); keys(payload, ["implementationSummary", "changedFiles", "testResults"]);
        record = await prepareReview(store, record, payload);
        if (record.processState === "running") launch(home, record, store);
      } else if (parsed.command === "decide") {
        const payload = await input(parsed); keys(payload, ["decision", "note"]);
        if (!["accept", "fix"].includes(String(payload.decision))) throw new Error("decision must be accept or fix");
        const evidence = await collectEvidence({ cwd: record.cwd, maxDiffBytes: 65536, changedFiles: record.reviewInput?.changedFiles });
        record = store.update(record.id, (value) => {
          if (value.phase !== "waiting_review_decision") throw new Error("Workflow is not waiting for a review decision");
          if (evidence.insufficient || evidence.fingerprint !== value.evidence?.fingerprint) throw new Error("Workspace evidence changed before the review decision");
          value.decision = payload.decision as "accept" | "fix";
          value.phase = value.decision === "accept" ? "passed" : "fixing";
          value.processState = value.decision === "accept" ? "completed" : "waiting";
        });
      } else if (parsed.command === "continue") {
        const payload = await input(parsed); keys(payload, ["answers"]);
        const answers = object(payload.answers);
        if (record.phase !== "waiting_input" || !record.plannerThreadId) throw new Error("Original Planner is not waiting for clarification");
        const questions = record.plan!.questions.map((q) => q.id);
        if (Object.keys(answers).length !== questions.length || questions.some((key) => !Array.isArray(answers[key]) || !(answers[key] as unknown[]).length || (answers[key] as unknown[]).some((v) => typeof v !== "string" || !v.trim()))) throw new Error("Provide non-empty answer arrays for exactly the original question ids");
        record = store.update(record.id, (value) => {
          if (value.phase !== "waiting_input" || value.operation?.id !== record.operation?.id) throw new Error("Original Planner ownership changed");
          value.operation = operation("planning", { answers }, value.plannerThreadId); value.phase = "planning"; value.processState = "running"; value.error = undefined;
        });
        launch(home, record, store);
      } else if (parsed.command === "resume") {
        const originalOperation = record.operation?.id;
        const capability = await continuation(record);
        if (capability.reason === "running") { process.stdout.write(JSON.stringify(await envelope(home, record)) + "\n"); return; }
        if (capability.reason === "cleanup_unconfirmed" && await cleanup(record)) {
          record = store.update(record.id, (value) => { if (!value.operation || value.operation.id !== originalOperation) throw new Error("Original cleanup operation ownership changed"); value.operation.cleanupConfirmed = true; });
        }
        const allowed = await continuation(record);
        if (!allowed.available) throw new Error(`Original continuation unavailable: ${allowed.reason}`);
        const previous = record.operation!;
        record = store.update(record.id, (value) => {
          if (value.operation?.id !== previous.id || value.phase === "cancelled" || value.operation.finished && !value.operation.recoverable) throw new Error("Original continuation ownership changed");
          value.operation = { ...operation(previous.stage, previous.input, previous.threadId), ...(previous.evidence ? { evidence: previous.evidence } : {}) };
          value.processState = "running"; value.error = undefined;
        });
        launch(home, record, store);
      }
    }
    process.stdout.write(JSON.stringify(await envelope(home, record)) + "\n");
  } finally { store.close(); }
}
main().catch((error) => {
  process.stdout.write(JSON.stringify({ workflowId: null, phase: "error", processState: "failed", continuation: { available: false, reason: "command_failed" }, nextAction: "Read the error and correct the input or environment before retrying.", result: null, artifactPaths: {}, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
});
