import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider } from "@deepseek-ai/dsh-subagent";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { CodexAppServerClient } from "../src/app-server.js";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { WorkflowStore } from "../src/store.js";
import type { WorkflowConfig, WorkflowRecord } from "../src/types.js";
import { WorkflowManager } from "../src/workflow.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

test("DSH receives Planner output in its session before planning completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-live-planner-"));
  const events: Array<{ type: string; data: unknown }> = [];
  const children: Array<{ session: Session; frames: Array<{ type: string }> }> = [];
  let plannerVisible!: () => void, reviewerVisible!: () => void;
  const plannerProgress = new Promise<void>((resolve) => { plannerVisible = resolve; });
  const reviewerProgress = new Promise<void>((resolve) => { reviewerVisible = resolve; });
  const plan = "# Goal\n实现安全的计划与验证流程。\n# Changes\n- src/index.ts：完成接口和错误处理。\n- test/index.test.ts：覆盖边界条件。\n# Verification\n- pnpm typecheck && pnpm test\n";
  const codex = new CodexAppServerClient({ command: process.execPath, args: [fixture],
    requestTimeoutMs: 5_000, idleProcessMs: 0,
    env: { ...process.env, FAKE_CODEX_STREAM_VISIBLE: "1", FAKE_CODEX_TURN_DELAY_MS: "700",
      FAKE_CODEX_HOLD_STREAM_TURN: "1", FAKE_CODEX_HOLD_STREAM_REVIEW: "1",
      FAKE_CODEX_PLAIN_REVIEW_TURNS: JSON.stringify([plan]),
      FAKE_CODEX_NATIVE_REVIEW_TEXT: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: 已检查实现和验证结果。" } });
  const store = new WorkflowStore(directory);
  const config = { codexCommand: "codex", autoTriggerMode: "complex", plannerModel: "", reviewerModel: "",
    plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
    reviewDiffMaxBytes: 65_536, bridgePollMs: 1_000, bridgeMaxPayloadBytes: 1_048_576,
    callbackTimeoutMs: 10_000, callbackMaxAttempts: 3, callbackRetryBaseMs: 200,
    transientRetryBaseMs: 1, transientRetryMaxMs: 5, transientRetryBudgetMs: 1_000,
    transientRetryJitterRatio: 0, turnTimeoutMs: 5_000, idleProcessMs: 0,
    terminalRelayTimeoutMs: 60_000, storageDir: directory } as WorkflowConfig;
  const agent = { id: "session-live", session: { header: { cwd: directory },
    append: (type: string, data: unknown) => {
      events.push({ type, data });
      if (type !== "dsh-codex-workflow/live") return;
      const live = data as { stage?: string; entries?: Array<{ text: string }> };
      const text = live.entries?.map((entry) => entry.text).join("") ?? "";
      if (live.stage === "planning" && text.includes("Implement safely")) plannerVisible();
      if (live.stage === "reviewing" && text.includes("VERDICT: pass")) reviewerVisible();
    } } } as unknown as Agent;
  const agents = { get: (id: string) => id === agent.id ? agent : undefined,
      create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
        const now = Date.now();
        const session = Session.create(options.sessionId, [], {
          version: SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: now,
          cwd: directory, parentSession: SessionId(agent.id), origin: "subagent",
          delegationDepth: 1, isSeeded: false,
        });
        const frames: Array<{ type: string }> = [];
        children.push({ session, frames });
        return { agent: { id: options.sessionId, session,
          ctx: { emit: (_event: string, payload: { frame: { type: string } }) => frames.push(payload.frame) } } as unknown as Agent,
          dispose: async () => undefined };
      } };
  let provider: SubagentProvider | undefined;
  const subagents = {
    registerProvider(value: SubagentProvider) { provider = value; return () => { provider = undefined; }; },
    async start(name: string, request: { parent: Agent; label: string; prompt: Array<{ type: "text"; text: string }>; signal: AbortSignal }) {
      const run = await provider!.start({ ...request,
        descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) });
      const child = run.localAgent!.session;
      (agent.session.append as unknown as (type: string, data: unknown) => unknown)("subagent/catalog", { version: 0, childId: child.id,
        childCreatedAt: child.header.createdAt, mode: "one-shot", label: request.label });
      return run;
    },
  };
  const childFactory = new CodexChildSessionFactory(agents as never, subagents as never);
  const manager = new WorkflowManager(store, codex, config, undefined, undefined, undefined, {}, agents, childFactory);
  const exec = { agent, signal: new AbortController().signal, deferContext: () => undefined } as unknown as ToolRunContext;
  const control = (codex as unknown as { request(method: string, params: object): Promise<unknown> }).request.bind(codex);
  let plannerThreadId: string | undefined, reviewerThreadId: string | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    let settled = false;
    pending = manager.start({ task: "规划安全接口和验证步骤" }, exec).finally(() => { settled = true; });
    // Observe real session output before releasing the original fixture turn.
    // Missing output still fails through the existing business turn timeout.
    await Promise.race([plannerProgress, pending.then(() => { throw new Error("Planner completed before its live session output"); })]);
    const plannerStreams = await control("fixture/heldStreams", {}) as { turns: string[] };
    assert.equal(plannerStreams.turns.length, 1);
    plannerThreadId = plannerStreams.turns[0];
    assert.ok(plannerThreadId);
    assert.ok(events.some((event) => event.type === "dsh-codex-workflow/plan-updated"
      && (event.data as { status?: string }).status === "planning"), "the tab can open at planning start");
    assert.equal(children.length, 1, "the Planner is a real child session");
    assert.ok(events.some((event) => event.type === "subagent/catalog"));
    assert.ok((events.find((event) => event.type === "dsh-codex-workflow/plan-updated")?.data as { childSessionId?: string }).childSessionId);
    assert.ok(events.some((event) => event.type === "dsh-codex-workflow/live"
      && JSON.stringify(event.data).includes("Implement safely")), "the session receives live plan text");
    assert.equal(settled, false, "Codex planning is still running when the sidebar gets text");
    assert.ok(children[0]?.frames.some((frame) => frame.type === "chunk"), "native child chat receives live frames");
    await control("fixture/releaseStreamTurn", { threadId: plannerThreadId });
    plannerThreadId = undefined;
    const planned = await pending as WorkflowRecord;
    assert.equal(planned.phase, "executing");
    await writeFile(join(directory, "a.txt"), "review evidence", "utf8");
    settled = false;
    pending = manager.review(planned.id, { implementationSummary: "完成实现", changedFiles: ["a.txt"],
      testResults: "已验证" }, exec).finally(() => { settled = true; });
    await Promise.race([reviewerProgress, pending.then(() => { throw new Error("Reviewer completed before its live session output"); })]);
    const reviewerStreams = await control("fixture/heldStreams", {}) as { reviews: string[] };
    assert.equal(reviewerStreams.reviews.length, 1);
    reviewerThreadId = reviewerStreams.reviews[0];
    assert.ok(reviewerThreadId);
    assert.ok(events.some((event) => event.type === "dsh-codex-workflow/review-start"));
    assert.equal(children.length, 2, "the Reviewer owns a separate child session");
    assert.ok((events.find((event) => event.type === "dsh-codex-workflow/review-start")?.data as { childSessionId?: string }).childSessionId);
    assert.ok(events.some((event) => event.type === "dsh-codex-workflow/live"
      && (event.data as { stage?: string }).stage === "reviewing"
      && (event.data as { entries?: Array<{ text: string }> }).entries?.map((entry) => entry.text).join("").includes("VERDICT: pass")),
    "the session receives live review text");
    assert.equal(settled, false, "Codex review is still running when the sidebar gets text");
    await control("fixture/releaseStreamReview", { threadId: reviewerThreadId });
    reviewerThreadId = undefined;
    await pending;
  } finally {
    if (plannerThreadId) await control("fixture/releaseStreamTurn", { threadId: plannerThreadId }).catch(() => undefined);
    if (reviewerThreadId) await control("fixture/releaseStreamReview", { threadId: reviewerThreadId }).catch(() => undefined);
    await pending?.catch(() => undefined);
    await manager.stop();
    await codex.stop();
    childFactory.unregisterProvider();
    store.close();
    closeCoordinationStoresForDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  }
});
