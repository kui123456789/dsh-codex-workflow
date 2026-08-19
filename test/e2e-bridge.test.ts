import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CodexAppServerClient } from "../src/app-server.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { newRequestId } from "../src/bridge-protocol.js";
import { BridgeStore } from "../src/bridge-store.js";
import { BridgeRuntime, type AgentRegistryLike } from "../src/bridge-runtime.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig } from "../src/types.js";
import { WorkflowManager, type CodexGateway } from "../src/workflow.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const cli = join(fileURLToPath(new URL("..", import.meta.url)), "src", "bridge-cli.ts");
const fakeCodexAppServer = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "fake-codex-app-server.mjs");

async function rmClosed(path: string): Promise<void> {
  // Close only this tree's coordination connections first (Windows locks an
  // open SQLite file); other directories stay untouched. The e2e harness keeps
  // its workflow store under workflows/ and the bridge store under
  // dsh-home/storages/dsh-codex-workflow/.
  closeCoordinationStoresForDirectory(join(path, "workflows"));
  closeCoordinationStoresForDirectory(join(path, "dsh-home", "storages", "dsh-codex-workflow"));
  closeCoordinationStoresForDirectory(path);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await rm(path, { recursive: true, force: true });
}

const config: WorkflowConfig = {
  codexCommand: "codex",
  plannerModel: "",
  reviewerModel: "",
  plannerEffort: "high",
  reviewerEffort: "high",
  maxReviewCycles: 3,
  maxNoChangeReviewRounds: 1,
  reviewDiffMaxBytes: 65536,
  bridgePollMs: 1000,
  bridgeMaxPayloadBytes: 1048576,
  callbackTimeoutMs: 10_000,
  callbackMaxAttempts: 3,
  callbackRetryBaseMs: 200,
  turnTimeoutMs: 10_000,
  idleProcessMs: 0,
  storageDir: "",
};

class NoopGateway implements CodexGateway {
  async startThread(): Promise<string> { throw new Error("planner must not run for bridge workflows"); }
  async resumeThread(): Promise<void> { throw new Error("not used"); }
  async startTurn(): Promise<never> { throw new Error("not used"); }
  async continueTurn(): Promise<never> { throw new Error("not used"); }
  async startReview(): Promise<never> { throw new Error("not used"); }
  async interrupt(): Promise<void> { throw new Error("not used"); }
}

function makeAgent(id: string, cwd: string): { agent: Agent; followups: Array<{ text: string }> } {
  const followups: Array<{ text: string }> = [];
  const events: Array<Record<string, unknown>> = [];
  const agent = {
    id,
    session: { header: { cwd }, events },
    followup: (message: { id: string; content: Array<{ type: string; text?: string }> }) => {
      followups.push({ text: message.content[0]?.text ?? "" });
      events.push({
        type: "agent/inbox/spliced",
        seq: events.length,
        time: Date.now(),
        data: { target: "next-turn", start: 0, deleteCount: 0, inserted: [message] },
      });
    },
  } as unknown as Agent;
  return { agent, followups };
}

function runCli(args: string[], stdin: string, dshHome: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [tsxCli, cli, ...args], {
      env: { ...process.env, DSH_HOME: dshHome, CODEX_THREAD_ID: "" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("end-to-end: CLI dispatch -> followup -> submit -> forked Reviewer -> final followup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-e2e-bridge-"));
  const dshHome = join(directory, "dsh-home");
  const storageDir = join(dshHome, "storages", "dsh-codex-workflow");
  await mkdir(join(storageDir, "bridge"), { recursive: true });
  try {
    const cwd = join(directory, "workspace with 空格");
    await mkdir(cwd, { recursive: true });
    // The non-git workspace needs an observable changed file for submit.
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "search.ts"), "export function search() { return 1; }\n", "utf8");

    const store = new BridgeStore(storageDir);
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const codexThreadId = newRequestId();
    const callsFile = join(directory, "app-server-calls.jsonl");
    const codex = new CodexAppServerClient({
      command: process.execPath,
      args: [fakeCodexAppServer],
      requestTimeoutMs: 10_000,
      idleProcessMs: 0,
      env: {
        ...process.env,
        FAKE_CODEX_THREAD_PARAMS_MARKER: callsFile,
        FAKE_CODEX_REVIEW_VERDICT: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "通过" }),
      },
    });
    const callback = new AppServerCodexCallbackDispatcher(codex);
    const manager = new WorkflowManager(workflowStore, codex, { ...config, storageDir }, callback, store);
    const { agent, followups } = makeAgent("session-e2e", cwd);
    const registry: AgentRegistryLike = { get: () => agent, list: () => [agent] };
    const runtime = new BridgeRuntime(store, registry, {
      pollMs: 20,
      storageDir,
      manager,
      workflowStore,
    });
    runtime.start();

    try {
      // 1) Real CLI dispatch of a Chinese plan to the unique cwd session.
      const payload = JSON.stringify({
        task: "实现搜索功能",
        planMarkdown: "<proposed_plan>\n修改 src/search.ts\n</proposed_plan>",
        assumptions: ["测试可用"],
      });
      const dispatch = await runCli(
        ["dispatch", "--cwd", cwd, "--codex-thread", codexThreadId, "--stdin", "--json"],
        payload,
        dshHome,
      );
      assert.equal(dispatch.code, 0, dispatch.stderr);
      const dispatched = JSON.parse(dispatch.stdout) as { requestId: string; dshSessionId: string };
      assert.equal(dispatched.dshSessionId, "session-e2e");

      // 2) Exactly one direct followup with the plan.
      await waitFor(async () => followups.length === 1);
      assert.match(followups[0]!.text, /proposed_plan/);
      const workflow = (await workflowStore.byBridgeRequest(dispatched.requestId))!;
      assert.equal(workflow.origin, "codex_bridge");

      // 3) DSH submits implementation; the callback forks the originating task
      //    into a separately owned read-only Reviewer and starts a schema turn.
      const submitted = await manager.submit(workflow.id, {
        implementationSummary: "实现完成",
        changedFiles: ["src/search.ts"],
        testResults: "全部通过",
      }, {
        agent,
        signal: new AbortController().signal,
        deferContext: () => undefined,
      } as never);
      assert.equal(submitted.submissionState, "received", submitted.submissionError);
      assert.ok(submitted.submissionId);
      assert.ok(submitted.reviewerThreadId);
      assert.notEqual(submitted.reviewerThreadId, codexThreadId);
      const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
        method: string;
        params: Record<string, any>;
      });
      const fork = calls.find((call) => call.method === "thread/fork");
      const settings = calls.find((call) => call.method === "thread/settings/update");
      const turn = calls.find((call) => call.method === "turn/start");
      assert.equal(fork?.params.threadId, codexThreadId);
      assert.equal(fork?.params.cwd, cwd);
      assert.equal(fork?.params.sandbox, "read-only");
      assert.equal(settings?.params.threadId, submitted.reviewerThreadId);
      assert.deepEqual(settings?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(turn?.params.threadId, submitted.reviewerThreadId);
      assert.match(turn?.params.input?.[0]?.text ?? "", /实现完成/);
      assert.match(turn?.params.input?.[0]?.text ?? "", /SUBMISSION:/);

      // 4) The automatic callback enqueued the structured verdict itself and
      //    committed `received`; the staged identity is KEPT in the record.
      assert.ok(submitted.stagedVerdict?.command.requestId, "received keeps the expected staged identity");
      const autoRequestId = submitted.stagedVerdict!.command.requestId;
      assert.equal(submitted.stagedVerdict!.command.submissionId, submitted.submissionId!);

      // 5) The automatic verdict is applied, delivered, and the workflow passes.
      await waitFor(async () => (await store.receipt(autoRequestId))?.status === "delivered");
      await waitFor(async () => followups.length === 2);
      assert.match(followups[1]!.text, /Codex review passed workflow/);
      const receipt = await store.receipt(autoRequestId);
      assert.equal(receipt?.status, "delivered");
      const final = await workflowStore.load(workflow.id);
      assert.equal(final?.phase, "passed");
      assert.equal(final?.submissionState, "delivered");

      // 6) NEGATIVE case: a manual `respond` for the SAME submission with a
      //    DIFFERENT request id is refused terminally (duplicate) — it must
      //    never re-apply over the automatic verdict nor relay again.
      const verdict = JSON.stringify({
        verdict: "pass",
        findings: [],
        testGaps: [],
        summary: "通过",
      });
      const respond = await runCli(
        ["respond", "--workflow", workflow.id, "--submission", submitted.submissionId!, "--codex-thread", codexThreadId, "--stdin", "--json"],
        verdict,
        dshHome,
      );
      assert.equal(respond.code, 0, respond.stderr);
      const responded = JSON.parse(respond.stdout) as { requestId: string };
      await waitFor(async () => (await store.receipt(responded.requestId)) !== undefined);
      const respondReceipt = await store.receipt(responded.requestId);
      assert.equal(respondReceipt?.status, "duplicate", "a second request id for an applied submission is refused");
      assert.match(respondReceipt?.error ?? "", /already applied as request/);
      await waitFor(async () => followups.length === 2);
      assert.equal(followups.length, 2, "no second relay for the refused manual verdict");
      const after = await workflowStore.load(workflow.id);
      assert.equal(after?.phase, "passed");
      assert.equal(after?.submissionState, "delivered");
    } finally {
      await runtime.stop();
      await manager.stop();
      await codex.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});

/** Manual/compat success: without an automatic staged expected command, a
 * manual `respond` is the legitimate path. The workflow is left in
 * `waiting_verdict` (no stagedVerdict) exactly as the pre-automatic legacy
 * flow, and the respond applies+delivers. Careful not to mix this with an
 * automatic callback scenario, which now owns its expected identity. */
test("manual respond succeeds when there is no automatic staged verdict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-e2e-bridge-respond-"));
  const dshHome = join(directory, "dsh-home");
  const storageDir = join(dshHome, "storages", "dsh-codex-workflow");
  await mkdir(join(storageDir, "bridge"), { recursive: true });
  try {
    const cwd = join(directory, "ws");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "a.txt"), "v1", "utf8");

    const store = new BridgeStore(storageDir);
    const workflowStore = new WorkflowStore(join(directory, "workflows"));
    const codexThreadId = newRequestId();
    const registry: AgentRegistryLike = {
      get: () => undefined,
      list: () => [],
    };
    const held = new Map<string, { agent: Agent }>();
    const liveRegistry: AgentRegistryLike = {
      get: (id: string) => held.get(id)?.agent,
      list: () => [...held.values()].map((entry) => entry.agent),
    };
    const holder = makeAgent("session-manual", cwd);
    held.set("session-manual", { agent: holder.agent });
    const followups = holder.followups;
    void registry;
    const manager = new WorkflowManager(workflowStore, new NoopGateway(), { ...config, storageDir }, undefined, store);
    const runtime = new BridgeRuntime(store, liveRegistry, {
      pollMs: 20,
      storageDir,
      manager,
      workflowStore,
    });
    runtime.start();

    try {
      // Dispatch creates the workflow bound to the manual session.
      const payload = JSON.stringify({
        task: "手工兼容场景",
        planMarkdown: "<proposed_plan>\n改 a.txt\n</proposed_plan>",
        assumptions: [],
      });
      const dispatch = await runCli(
        ["dispatch", "--cwd", cwd, "--codex-thread", codexThreadId, "--stdin", "--json"],
        payload,
        dshHome,
      );
      assert.equal(dispatch.code, 0, dispatch.stderr);
      const dispatched = JSON.parse(dispatch.stdout) as { requestId: string };
      await waitFor(async () => followups.length === 1);
      const workflow = (await workflowStore.byBridgeRequest(dispatched.requestId))!;

      // Put the workflow into the legacy waiting_verdict shape (no staged
      // expected command) with sufficient evidence.
      const evidence = await (await import("../src/evidence.js")).collectEvidence({
        cwd,
        maxDiffBytes: 65536,
        changedFiles: ["a.txt"],
      });
      const submissionId = newRequestId();
      await workflowStore.update(workflow.id, (r) => {
        r.submissionId = submissionId;
        r.submissionState = "waiting_verdict";
        r.reviewCycles = 1;
        r.pendingReviewRequest = { implementationSummary: "手动", changedFiles: ["a.txt"] };
        r.latestReviewEvidence = evidence;
      });

      // Manual respond is the legitimate path here: no staged identity exists.
      const respond = await runCli(
        ["respond", "--workflow", workflow.id, "--submission", submissionId, "--codex-thread", codexThreadId, "--stdin", "--json"],
        JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "手动通过" }),
        dshHome,
      );
      assert.equal(respond.code, 0, respond.stderr);
      const responded = JSON.parse(respond.stdout) as { requestId: string };
      await waitFor(async () => (await store.receipt(responded.requestId))?.status === "delivered");
      await waitFor(async () => followups.length === 2);
      assert.match(followups[1]!.text, /Codex review passed workflow/);
      const final = await workflowStore.load(workflow.id);
      assert.equal(final?.phase, "passed");
      assert.equal(final?.submissionState, "delivered");
    } finally {
      await runtime.stop();
    }
  } finally {
    await rmClosed(directory);
  }
});
