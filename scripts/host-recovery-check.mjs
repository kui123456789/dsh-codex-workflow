#!/usr/bin/env node
// Isolated installed-host smoke: real DSH services, temporary session journals,
// workflow storage and a scripted local model gateway. No user
// profile, chat logs, credentials, browser, port or live model is opened.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexChildSessionFactory, codexSubagentChatAddress } from "../lib/codex-child-session.js";
import { codexWorkflowProjectionDefinition, registerCodexWorkflowSessionEventTypes } from "../lib/review-events.js";
import { WorkflowStore } from "../lib/store.js";
import { createWorkflowTools } from "../lib/tools.js";
import { WorkflowManager } from "../lib/workflow.js";
import { CodexTurnInterruptionError } from "../lib/turn-interruption.js";

const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
const profileRequire = createRequire(join(dshHome, "profiles", "package.json"));
const hostPackage = process.env.DSH_CODEX_HOST_PACKAGE_JSON
  ? resolve(process.env.DSH_CODEX_HOST_PACKAGE_JSON)
  : profileRequire.resolve("@deepseek-ai/dsh/package.json");
const hostRequire = createRequire(hostPackage);
const loadHost = (name) => import(pathToFileURL(hostRequire.resolve(name)).href);
const [cordis, prompts, tools, agents, sessions, projections, subagents, llm, persistence] = await Promise.all([
  loadHost("@deepseek-ai/cordis"), loadHost("@deepseek-ai/dsh-system-prompt"),
  loadHost("@deepseek-ai/dsh-tools"), loadHost("@deepseek-ai/dsh-agent"),
  loadHost("@deepseek-ai/dsh-session"), loadHost("@deepseek-ai/dsh-session-projection"),
  loadHost("@deepseek-ai/dsh-subagent"), loadHost("@deepseek-ai/dsh-llm"),
  loadHost("@deepseek-ai/dsh-session-persistence-jsonl"),
]);
const hostVersion = JSON.parse(await readFile(hostPackage, "utf8")).version;
registerCodexWorkflowSessionEventTypes(sessions.KNOWN_SESSION_EVENT_TYPES);
const PLAN = [
  "# Goal", "Add a local health check that reports configuration and storage status.",
  "# Changes", "- Inspect configuration through a read-only adapter and report readable failures.",
  "# Verification", "- Check valid, absent and invalid inputs without initializing the database.",
  "# Risks", "- Preserve the original workspace and return an explicit error for unavailable storage.",
].join("\n");
const REVIEW = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: The implementation satisfies the approved task.";
const instruction = "Continue only the unfinished work in this original conversation.";
const clarificationTask = "ORIGINAL-TASK-SENTINEL: plan a read-only local health check";
const question = { id: "scope", header: "Scope", question: "Which local configuration should the health check inspect?",
  options: [], allowOther: true, secret: false };
const answers = { scope: ["ANSWER-SENTINEL: the current local profile only"] };

class ScriptedGateway {
  threadStarts = [];
  auxiliaryThreads = [];
  turnStarts = [];
  nativeAnswers = [];
  conversions = [];
  releases = [];
  interruptions = [];
  interruptionAcknowledgements = [];
  unconfirmedInterruptions = 0;
  remoteActive;
  modelInterruption = false;
  abortSubmittedAnswer;
  failures = 2;
  turns = 0;
  pins = 0;
  roundStarts = 0;
  roundEnds = 0;
  available = new Set();
  constructor(clarificationMode, action) {
    this.clarificationMode = clarificationMode;
    if (clarificationMode) this.failures = 0;
    if (action === "submitted_abort") this.unconfirmedInterruptions = 1;
    if (action === "model_interruption") {
      this.failures = 0;
      this.unconfirmedInterruptions = 2;
      this.modelInterruption = true;
    }
  }
  beginRound() { this.pins += 1; this.roundStarts += 1; }
  endRound() { this.pins -= 1; this.roundEnds += 1; }
  isThreadAvailable(id) { return this.available.has(id); }
  async startThread(options) { return this.createThread(options.name?.startsWith("DSH Review ") ? "private" : "planning"); }
  async startReviewerThread() { return this.createThread("reviewing"); }
  createThread(stage) {
    const id = `${stage}-${randomUUID()}`;
    this.available.add(id);
    if (stage !== "private") this.threadStarts.push({ id, stage });
    else this.auxiliaryThreads.push(id);
    return id;
  }
  async resumeThread() { throw new Error("the smoke must not resume a different thread"); }
  async unsubscribeThread(id) { this.releases.push(id); this.available.delete(id); }
  async interrupt(threadId, turnId) {
    this.interruptions.push({ threadId, turnId });
    if (this.remoteActive) assert.deepEqual(this.remoteActive, { threadId, turnId }, "cleanup targets the original active remote turn");
    if (this.unconfirmedInterruptions > 0) {
      this.unconfirmedInterruptions -= 1;
      throw new Error("scripted original turn interruption was not acknowledged");
    }
    this.remoteActive = undefined;
    this.interruptionAcknowledgements.push({ threadId, turnId });
  }
  async continueTurn(pending, submitted, signal, onProgress) {
    assert.equal(this.clarificationMode, "native");
    assert.equal(pending, this.nativePending, "the native answer submits the exact original request");
    assert.equal(this.available.has(pending.threadId), true);
    signal?.throwIfAborted();
    this.nativeAnswers.push({ threadId: pending.threadId, turnId: pending.turnId, answers: submitted });
    if (this.abortSubmittedAnswer) {
      onProgress?.({ kind: "tool", itemId: `submitted-answer-tool-${pending.turnId}`, text: "Working after the submitted native answer", status: "inProgress" });
      this.abortSubmittedAnswer();
      assert.equal(signal?.aborted, true, "the real ToolRuntime caller signal reaches the running native answer");
      signal.throwIfAborted();
    }
    onProgress?.({ kind: "message", itemId: `answer-${pending.turnId}`, text: PLAN });
    this.remoteActive = undefined;
    return { kind: "completed", threadId: pending.threadId, turnId: pending.turnId, status: "completed", text: PLAN };
  }
  async startTurn(threadId, options) { return this.run(threadId, options, "turn"); }
  async startReview(options) {
    return { threadId: options.threadId, result: await this.run(options.threadId, {
      ...options, prompt: options.target.instructions,
    }, "review") };
  }
  async run(threadId, options, api) {
    assert.equal(this.available.has(threadId), true, "the original thread remains live");
    assert.equal(this.remoteActive, undefined, "a new SDK turn is forbidden until the original remote turn termination is acknowledged");
    const turnId = `turn-${++this.turns}`;
    this.turnStarts.push({ threadId, turnId, prompt: options.prompt, api, model: options.model, effort: options.effort });
    await options.onStarted?.({ threadId, turnId });
    if (this.modelInterruption && this.turnStarts.length === 1) {
      this.remoteActive = { threadId, turnId };
      options.onProgress?.({ kind: "tool", itemId: `model-timeout-tool-${turnId}`, text: "Inspecting interrupted model fixture", status: "inProgress" });
      // Model the SDK's typed result after its interruption RPC was rejected.
      // Actual transport ACK ordering is covered by the separate protocol suite.
      await assert.rejects(this.interrupt(threadId, turnId), /not acknowledged/);
      throw new CodexTurnInterruptionError(new Error(`Codex turn timed out: ${turnId}`), threadId, turnId);
    }
    if (this.clarificationMode && this.turnStarts.length === 1) {
      // Leave a real tool display item open so pausing must balance its native
      // lifecycle before the question history can be replayed by the host.
      options.onProgress?.({ kind: "tool", itemId: `question-tool-${turnId}`, text: "Inspecting question fixture", status: "inProgress" });
      options.onProgress?.({ kind: "message", itemId: `question-${turnId}`, text: question.question });
      if (this.clarificationMode === "native") {
        this.remoteActive = { threadId, turnId };
        this.nativePending = { kind: "needs_input", threadId, turnId, request: {
          requestId: 1, threadId, turnId, itemId: "original-input-request", questions: [question],
        } };
        return this.nativePending;
      }
      return { kind: "completed", threadId, turnId, status: "completed", text: `1. ${question.question}` };
    }
    if (this.failures > 0) {
      this.failures -= 1;
      // Exercise balancing of a tool call whose model turn never returned.
      options.onProgress?.({ kind: "tool", itemId: `tool-${turnId}`, text: "Inspecting local fixture", status: "inProgress" });
      return { kind: "completed", threadId, turnId, status: "failed", text: "", reason: "turn failed" };
    }
    const text = threadId.startsWith("planning-") ? PLAN : REVIEW;
    options.onProgress?.({ kind: "message", itemId: `message-${turnId}`, text });
    return { kind: "completed", threadId, turnId, status: "completed", text };
  }
  async normalizeInFork(options) {
    this.conversions.push({ threadId: options.threadId, model: options.model });
    const text = options.prompt.includes("REVIEW AUTHORITY checker")
      ? JSON.stringify({ aligned: true, conflicts: [] })
      : options.prompt.startsWith("Convert the readable code review")
        ? JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "The original requirements are verified." })
        : options.prompt.includes(question.question)
          ? JSON.stringify({ status: "needs_input", questions: [question], assumptions: [], message: "Choose the local scope" })
        : JSON.stringify({ status: "ready", planMarkdown: PLAN, questions: [], assumptions: [] });
    return { kind: "completed", threadId: options.threadId, turnId: `private-${++this.turns}`, status: "completed", text };
  }
}

function assertBalancedSession(session) {
  const events = session.snapshotEvents();
  let openTurn;
  let openStep;
  const pending = new Set();
  for (const event of events) {
    if (event.type === "turn/start") { assert.equal(openTurn, undefined); openTurn = event.data.turn; }
    if (event.type === "step/start") {
      assert.equal(event.data.turn, openTurn);
      assert.equal(openStep, undefined);
      openStep = event.data.step;
    }
    if (event.type === "tool/call") {
      assert.equal(event.data.turn, openTurn);
      assert.equal(event.data.step, openStep);
      assert.equal(pending.has(event.data.callId), false, "tool call identities do not duplicate");
      pending.add(event.data.callId);
    }
    if (event.type === "tool/result") {
      assert.equal(event.data.turn, openTurn);
      assert.equal(event.data.step, openStep);
      assert.equal(pending.delete(event.data.message.source.callId), true, "every result has an existing tool call");
    }
    if (event.type === "step/end") {
      assert.equal(event.data.turn, openTurn);
      assert.equal(event.data.step, openStep);
      assert.equal(pending.size, 0, "no unbalanced tool survives a closed step");
      openStep = undefined;
    }
    if (event.type === "turn/end") {
      assert.equal(event.data.turn, openTurn);
      assert.equal(openStep, undefined);
      openTurn = undefined;
    }
  }
  assert.equal(openTurn, undefined, "the native child has no unfinished turn");
  assert.equal(openStep, undefined);
  assert.equal(pending.size, 0);
  assert.ok(session.deriveMessages().length > 0, "installed-host message projection accepts child history");
  // Recreate using the installed host's event/header/surface validators.
  const replay = sessions.Session.create(session.id, events, session.header);
  assert.deepEqual(replay.deriveMessages(), session.deriveMessages(), "native message replay is stable");
}

async function scenario(stage, action, clarificationMode) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-host-recovery-"));
  const ctx = new cordis.Context();
  const store = new WorkflowStore(join(directory, "storage"));
  const gateway = new ScriptedGateway(clarificationMode, action);
  const modelInterruption = action === "model_interruption";
  const children = [];
  const disposeCalls = [];
  const frames = [];
  let manager;
  let childFactory;
  let parentWriter;
  try {
    await ctx.plugin(prompts.default, {});
    await ctx.plugin(tools.ToolRuntime, {});
    await ctx.plugin(agents.AgentRegistry, {});
    await ctx.plugin(sessions.SessionStore, {});
    await ctx.plugin(projections.SessionProjectionRegistry, {});
    await ctx.plugin(subagents.SubagentRuntime, {});
    await ctx.plugin(persistence.default, { root: join(directory, "journals") });
    ctx.sessionProjections.register(codexWorkflowProjectionDefinition);
    ctx.on("agent/assistant-stream", ({ agent, frame }) => { frames.push({ id: agent.id, frame }); });
    // No agent loop or model provider is installed. Own the real persistence
    // handle across native publication and retirement, as the production loop does.
    ctx.agents.setFactory({
      async createAgent(ownerCtx, options) {
        options.signal?.throwIfAborted();
        const session = sessions.Session.create(options.sessionId, [], {
          version: sessions.SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: Date.now(),
          cwd: directory, isSeeded: false, ...options.meta,
        });
        const writer = await ctx.sessionPersistence.create(session.header, {
          inheritedEventCount: session.inheritedEventCount,
        });
        const seed = session.snapshotEvents();
        if (seed.length > 0) await writer.append(seed);
        const agent = { id: session.id, session, ctx: ownerCtx, options: {} };
        const detachSession = ctx.sessions.enter(session);
        ctx.sessions.announce(session);
        const detach = ctx.agents.enter(agent, options.parentAgent);
        await ctx.agents.announce(agent, "create", options.signal);
        children.push(session);
        let disposal;
        return { agent, dispose: () => disposal ??= (async () => {
          disposeCalls.push(session.id);
          await writer.close();
          detach();
          detachSession();
        })() };
      },
      async resume() { throw new Error("the smoke never opens a persisted user session"); },
    });
    const parentId = sessions.SessionId(`smoke-${randomUUID()}`);
    const parent = { id: parentId, ctx, options: {}, session: ctx.sessions.create(parentId, {
      meta: { cwd: directory, isSeeded: false },
    }) };
    parentWriter = await ctx.sessionPersistence.create(parent.session.header);
    const parentSeed = parent.session.snapshotEvents();
    if (parentSeed.length > 0) await parentWriter.append(parentSeed);
    await ctx.agents.register(parent);
    await writeFile(join(directory, "implementation.txt"), "isolated health-check implementation fixture", "utf8");
    childFactory = new CodexChildSessionFactory(ctx.agents, ctx.subagents);
    const config = {
      codexCommand: "unused-scripted-gateway", autoTriggerMode: "complex", plannerModel: clarificationMode || modelInterruption ? "model-B" : "", reviewerModel: modelInterruption ? "model-B" : "",
      plannerEffort: "high", reviewerEffort: "high", maxReviewCycles: 3, maxNoChangeReviewRounds: 1,
      reviewDiffMaxBytes: 65_536, bridgePollMs: 1_000, bridgeMaxPayloadBytes: 1_048_576,
      callbackTimeoutMs: 1_000, callbackMaxAttempts: 1, callbackRetryBaseMs: 1,
      transientRetryBaseMs: 1, transientRetryMaxMs: 1, transientRetryBudgetMs: 0, transientRetryJitterRatio: 0,
      turnTimeoutMs: 1_000, idleProcessMs: 0, terminalRelayTimeoutMs: 1_000, storageDir: store.directory,
    };
    manager = new WorkflowManager(store, gateway, config, undefined, undefined, undefined, {}, ctx.agents, childFactory);
    const registrations = createWorkflowTools(manager, config).map((definition) => ctx.tools.register(definition));
    let call = 0;
    const invoke = async (name, args) => {
      const result = await ctx.tools.execute({
        callId: llm.ToolCallId(`smoke-call-${++call}`), name, arguments: args, agent: parent,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.error ?? result.content)}`);
      return result.value;
    };
    const waiting = stage === "planning"
      ? await invoke("codex_workflow_start", clarificationMode || modelInterruption
        ? { task: clarificationMode ? clarificationTask : "Plan a read-only local health check", plannerModel: "model-A", plannerEffort: "low" }
        : { task: "Plan a read-only local health check" })
      : await invoke("codex_workflow_review_only", {
        task: "Review the local health-check implementation", implementationSummary: "Read-only health check implemented",
        changedFiles: ["implementation.txt"], testResults: "The isolated fixture is deterministic",
        ...(modelInterruption ? { reviewerModel: "model-A", reviewerEffort: "low" } : {}),
      });
    if (clarificationMode) {
      assert.equal(waiting.phase, "waiting_input");
      assert.deepEqual(waiting.questions, [question]);
      assert.equal(waiting.plannerModel, "model-A");
      assert.equal(waiting.plannerEffort, "low");
      assert.equal(waiting.retryState, undefined, "clarification is not a model-failure continuation");
      const persisted = await store.load(waiting.id);
      assert.equal(persisted.plannerModel, "model-A");
      assert.equal(persisted.plannerEffort, "low");
    } else {
      assert.equal(waiting.processState, "waiting");
      assert.equal(waiting.retryState.awaitingContinuation, true);
    }
    assert.equal(gateway.threadStarts.length, 1);
    assert.equal(children.length, 1);
    const child = children[0];
    assertBalancedSession(child);
    const originalThread = gateway.threadStarts[0].id;
    const originalChild = child.id;
    assert.equal(gateway.pins, 1, "the waiting original conversation retains its round pin");
    assert.equal(gateway.roundStarts, 1);
    assert.equal(gateway.roundEnds, 0);
    assert.deepEqual(disposeCalls, [], "the waiting native child is not disposed");
    assert.equal(gateway.releases.filter((id) => id === originalThread).length, 0);
    assert.equal(ctx.agents.get(originalChild)?.session, child, "the original native child is still addressable while waiting");
    const catalogBefore = ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog;
    assert.equal(catalogBefore.length, 1);
    assert.equal(catalogBefore[0].id, originalChild);
    const childBefore = ctx.sessionProjections.snapshot(child).values;
    assert.equal(childBefore.subagent.mode, "one-shot", "native descriptor is valid, not corrupt");
    assert.equal(childBefore.subagentTiming.active, undefined);
    const turnsBefore = child.snapshotEvents().filter((event) => event.type === "turn/start").length;
    const status = await invoke("codex_workflow_status", {});
    assert.equal(status.id, waiting.id, "status resolves the original workflow without an id");
    if (clarificationMode) assert.equal(status.phase, "waiting_input");
    else assert.deepEqual(status.continuation, modelInterruption
      ? { available: false, reason: "interruption_unconfirmed" } : { available: true });
    const projection = ctx.sessionProjections.snapshot(parent.session).values.codexWorkflow;
    if (stage === "planning") {
      assert.equal(projection.plan.processState, "waiting", "Planner wait is published to the real host projection");
      assert.equal(projection.plan.status, clarificationMode ? "waiting_input" : "planning");
    }
    const projectedChild = stage === "planning" ? projection.plan.childSessionId : projection.reviews.at(-1)?.childSessionId ?? projection.activeReview?.childSessionId;
    assert.equal(projectedChild, originalChild, "native sidebar projection retains the child address");
    assert.match(codexSubagentChatAddress(parent.id, originalChild), /^dsh-resource:\/\/subagentchat\/session\//);

    if (modelInterruption) {
      const originalTurn = gateway.turnStarts[0].turnId;
      const originalPair = { threadId: originalThread, turnId: originalTurn };
      assert.equal(gateway.turnStarts.length, 1, "unknown model interruption starts no automatic writer");
      assert.deepEqual(gateway.interruptions, [originalPair]);
      assert.deepEqual(gateway.remoteActive, originalPair);
      assert.deepEqual(gateway.interruptionAcknowledgements, []);
      const heldBeforeCleanup = await store.load(waiting.id);
      const modelField = stage === "planning" ? "plannerModel" : "reviewerModel";
      const effortField = stage === "planning" ? "plannerEffort" : "reviewerEffort";
      assert.equal(heldBeforeCleanup[modelField], "model-A");
      assert.equal(heldBeforeCleanup[effortField], "low");
      const denied = await ctx.tools.execute({ callId: llm.ToolCallId(`smoke-call-${++call}`), name: "codex_workflow_resume",
        arguments: { workflowId: waiting.id, instruction }, agent: parent, signal: new AbortController().signal });
      assert.equal(denied.isError, true, "a second unconfirmed cleanup cannot start a model continuation");
      assert.match(denied.error?.message ?? "", /interruption is unconfirmed/);
      assert.deepEqual(gateway.interruptions, [originalPair, originalPair]);
      assert.equal(gateway.turnStarts.length, 1);
      assert.deepEqual(gateway.remoteActive, originalPair);
      assert.deepEqual(gateway.interruptionAcknowledgements, []);
      assert.equal(gateway.pins, 1);
      assert.deepEqual(disposeCalls, []);
      assert.equal(gateway.releases.filter((id) => id === originalThread).length, 0);
      assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore);
      assertBalancedSession(child);
      assert.deepEqual((await invoke("codex_workflow_status", { workflowId: waiting.id })).continuation,
        { available: false, reason: "interruption_unconfirmed" });
      assert.equal(ctx.agents.get(originalChild)?.session, child);
      const resumed = await invoke("codex_workflow_resume", { workflowId: waiting.id, instruction });
      assert.equal(resumed.id, waiting.id);
      assert.equal(resumed.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(resumed.retryState, undefined);
      assert.equal(resumed[modelField], "model-A");
      assert.equal(resumed[effortField], "low");
      assert.equal(resumed.reviewCycles, stage === "planning" ? 0 : 1);
      assert.deepEqual(gateway.interruptions, [originalPair, originalPair, originalPair]);
      assert.deepEqual(gateway.interruptionAcknowledgements, [originalPair]);
      assert.equal(gateway.remoteActive, undefined);
      assert.equal(gateway.turnStarts.length, 2, "only confirmed cleanup admits the original-thread continuation");
      assert.ok(gateway.turnStarts.every((turn) => turn.threadId === originalThread && turn.model === "model-A" && turn.effort === "low"));
      assert.equal(gateway.turnStarts[1].prompt, instruction);
      assert.equal(gateway.nativeAnswers.length, 0, "ordinary model interruption never replays native answers");
      assert.equal(gateway.threadStarts.length, 1);
      assert.equal(children.length, 1);
      assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore + 1);
      assert.equal(child.snapshotEvents().filter((event) => event.type === "user/message").at(-1).data.content[0].text, instruction);
    } else if (action === "answer") {
      assert.ok(clarificationMode);
      const answered = await invoke("codex_workflow_continue", { workflowId: waiting.id, answers });
      assert.equal(answered.id, waiting.id);
      assert.equal(answered.phase, "executing");
      assert.equal(answered.retryState, undefined);
      assert.equal(answered.plannerModel, "model-A");
      assert.equal(answered.plannerEffort, "low");
      assert.equal(gateway.threadStarts.length, 1);
      assert.equal(children.length, 1);
      assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore + 1);
      const lastInput = child.snapshotEvents().filter((event) => event.type === "user/message").at(-1).data.content[0].text;
      assert.ok(lastInput.includes(answers.scope[0]));
      assert.equal(lastInput.includes(clarificationTask), false, "the child receives only clarification answers");
      assert.ok(gateway.turnStarts.every((turn) => turn.threadId === originalThread && turn.model === "model-A" && turn.effort === "low"));
      assert.ok(gateway.conversions.every((turn) => turn.threadId === originalThread && turn.model === "model-A"));
      if (clarificationMode === "native") {
        assert.equal(gateway.turnStarts.length, 1, "native answers do not start a replacement SDK turn");
        assert.deepEqual(gateway.nativeAnswers, [{ threadId: originalThread, turnId: gateway.turnStarts[0].turnId, answers }]);
      } else {
        assert.equal(gateway.nativeAnswers.length, 0);
        assert.equal(gateway.turnStarts.length, 2);
        const followup = gateway.turnStarts[1];
        assert.ok(followup.prompt.includes(answers.scope[0]));
        assert.equal(followup.prompt.includes(clarificationTask), false, "the SDK turn receives a short answer followup");
      }
      const persisted = await store.load(waiting.id);
      assert.equal(persisted.phase, "executing");
      assert.equal(persisted.plannerModel, "model-A");
      assert.equal(persisted.plannerEffort, "low");
    } else if (action === "submitted_abort") {
      assert.equal(stage, "planning");
      assert.equal(clarificationMode, "native");
      // This exercises the application's interruption-confirmation port. The
      // scripted gateway does not run a real App Server or SDK background abandon.
      const caller = new AbortController();
      gateway.abortSubmittedAnswer = () => caller.abort();
      const aborted = await ctx.tools.execute({
        callId: llm.ToolCallId(`smoke-call-${++call}`), name: "codex_workflow_continue",
        arguments: { workflowId: waiting.id, answers }, agent: parent, signal: caller.signal,
      });
      assert.equal(caller.signal.aborted, true);
      assert.equal(aborted.isError, true, "the installed ToolRuntime materializes the caller abort after cleanup");
      assert.equal(aborted.error?.info?.name, "AbortError");
      assert.match(aborted.error?.message ?? "", /abort/i);
      const originalTurn = gateway.turnStarts[0].turnId;
      assert.deepEqual(gateway.nativeAnswers, [{ threadId: originalThread, turnId: originalTurn, answers }]);
      assert.equal(gateway.turnStarts.length, 1, "no second SDK turn starts while interruption is unconfirmed");
      assert.deepEqual(gateway.interruptions, [{ threadId: originalThread, turnId: originalTurn }]);
      assert.deepEqual(gateway.interruptionAcknowledgements, []);
      assert.deepEqual(gateway.remoteActive, { threadId: originalThread, turnId: originalTurn });
      const held = await store.load(waiting.id);
      assert.equal(held.phase, "planning");
      assert.equal(held.processState, "waiting");
      assert.equal(held.retryState.awaitingContinuation, true);
      assert.match(held.retryState.reason, /interruption is unconfirmed/);
      assert.equal(held.pendingInput, undefined, "the already submitted answer is not offered for replay");
      assert.equal(gateway.threadStarts.length, 1);
      assert.equal(children.length, 1);
      assert.deepEqual(disposeCalls, []);
      assert.equal(gateway.pins, 1);
      assert.equal(gateway.roundEnds, 0);
      assert.equal(gateway.releases.filter((id) => id === originalThread).length, 0);
      assert.equal(ctx.agents.get(originalChild)?.session, child);
      assertBalancedSession(child);
      const heldStatus = await invoke("codex_workflow_status", { workflowId: waiting.id });
      assert.deepEqual(heldStatus.continuation, { available: false, reason: "interruption_unconfirmed" });
      const resumed = await invoke("codex_workflow_resume", { workflowId: waiting.id, instruction });
      assert.equal(resumed.phase, "executing");
      assert.equal(resumed.retryState, undefined);
      assert.equal(resumed.pendingInput, undefined);
      assert.equal(resumed.plannerModel, "model-A");
      assert.equal(resumed.plannerEffort, "low");
      assert.deepEqual(gateway.interruptions, [
        { threadId: originalThread, turnId: originalTurn },
        { threadId: originalThread, turnId: originalTurn },
      ], "manual resume retries cleanup of the same original turn");
      assert.deepEqual(gateway.interruptionAcknowledgements, [{ threadId: originalThread, turnId: originalTurn }]);
      assert.equal(gateway.remoteActive, undefined);
      assert.equal(gateway.turnStarts.length, 2, "only the initial SDK turn and the ACK-authorized continuation run");
      assert.equal(gateway.nativeAnswers.length, 1, "the submitted native answer is never replayed");
      assert.equal(gateway.threadStarts.length, 1);
      assert.equal(children.length, 1);
      const followup = gateway.turnStarts[1];
      assert.equal(followup.threadId, originalThread);
      assert.ok(followup.prompt.includes(answers.scope[0]));
      assert.ok(followup.prompt.includes(instruction));
      assert.equal(followup.prompt.includes(clarificationTask), false);
      assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore + 2);
      const lastInput = child.snapshotEvents().filter((event) => event.type === "user/message").at(-1);
      assert.equal(lastInput.data.content[0].text, followup.prompt);
      assert.ok(gateway.conversions.every((turn) => turn.threadId === originalThread && turn.model === "model-A"));
    } else if (action === "resume") {
      const resumed = await invoke("codex_workflow_resume", { instruction });
      assert.equal(resumed.phase, stage === "planning" ? "executing" : "passed");
      assert.equal(resumed.retryState, undefined);
      assert.equal(gateway.threadStarts.length, 1, "resume never creates a replacement visible thread");
      assert.equal(children.length, 1, "resume never creates a replacement native child");
      assert.equal(gateway.turnStarts.at(-1).threadId, originalThread);
      assert.equal(gateway.turnStarts.at(-1).prompt, instruction, "only the short instruction is resent");
      assert.equal(child.snapshotEvents().filter((event) => event.type === "turn/start").length, turnsBefore + 1);
      const lastInput = child.snapshotEvents().filter((event) => event.type === "user/message").at(-1);
      assert.equal(lastInput.data.content[0].text, instruction);
      assert.equal(resumed.reviewCycles, stage === "planning" ? 0 : 1);
    } else if (action === "cancel") {
      const cancelled = await invoke("codex_workflow_cancel", { workflowId: waiting.id });
      assert.equal(cancelled.phase, "cancelled");
      assert.deepEqual((await invoke("codex_workflow_status", { workflowId: waiting.id })).continuation, {
        available: false, reason: "cancelled",
      });
      if (clarificationMode) {
        assert.equal(gateway.turnStarts.length, 1, "cancelling waiting input starts no model turn");
        assert.equal(gateway.nativeAnswers.length, 0);
        assert.equal(gateway.interruptions.length, clarificationMode === "native" ? 1 : 0);
        if (clarificationMode === "native") assert.deepEqual(gateway.interruptions[0], {
          threadId: originalThread, turnId: gateway.turnStarts[0].turnId,
        });
        await invoke("codex_workflow_cancel", { workflowId: waiting.id });
      }
    } else {
      await manager.stop();
      assert.deepEqual((await invoke("codex_workflow_status", { workflowId: waiting.id })).continuation, {
        available: false, reason: "stopped",
      });
    }
    if (clarificationMode || modelInterruption) await manager.stop();
    assertBalancedSession(child);
    assert.deepEqual(ctx.sessionProjections.snapshot(parent.session).values.subagentCatalog, catalogBefore,
      "resume, cancellation and stop preserve the original native catalog identity");
    const replayParent = sessions.Session.create(parent.id, parent.session.snapshotEvents(), parent.session.header);
    assert.deepEqual(ctx.sessionProjections.snapshot(replayParent).values.subagentCatalog, catalogBefore,
      "installed-host cold replay preserves the parent's original native catalog");
    // A fresh backend must read the original journal after the child is released;
    // replaying an in-memory snapshot cannot prove that the session was persisted.
    await ctx.sessionPersistence.flush();
    const cold = new cordis.Context();
    try {
      await cold.plugin(persistence.default, { root: join(directory, "journals") });
      for (const original of [child, parent.session]) {
        const reader = await cold.sessionPersistence.open(original.id, "read");
        try {
          const { events } = await reader.read(sessions.SessionLogOffset(0));
          assert.deepEqual(events, original.snapshotEvents(), "cold journal retains the complete original event sequence");
          const replay = sessions.Session.create(original.id, events, reader.header, reader.inheritedEventCount);
          if (original === child) assertBalancedSession(replay);
          assert.deepEqual(replay.deriveMessages(), original.deriveMessages(), "cold persisted messages match live history");
          if (original === parent.session) {
            assert.deepEqual(ctx.sessionProjections.snapshot(replay).values.subagentCatalog, catalogBefore,
              "cold persisted parent points to the same original child");
          }
        } finally {
          await reader.close();
        }
      }
    } finally {
      await cold.fiber.dispose();
    }
    const finalView = ctx.sessionProjections.snapshot(child).values;
    if (stage === "planning" && ["resume", "answer", "model_interruption", "submitted_abort"].includes(action)) {
      const plan = ctx.sessionProjections.snapshot(parent.session).values.codexWorkflow.plan;
      assert.equal(plan.status, "ready");
      assert.equal(plan.processState, "completed", "a ready plan clears the prior pause state");
      const states = parent.session.snapshotEvents().filter(event => event.type === "dsh-codex-workflow/plan-updated")
        .map(event => ({ status: event.data.status, processState: event.data.processState }));
      assert.equal(states[0].processState, "running");
      assert.ok(states.some((state, index) => state.processState === "waiting"
        && states.slice(index + 1).some(next => next.processState === "running")), "the same Planner publishes wait then running");
    }
    assert.equal(finalView.subagent.mode, "one-shot");
    assert.equal(finalView.subagentTiming.active, undefined);
    assert.equal(disposeCalls.filter((id) => id === originalChild).length, 1, "native child dispose is invoked exactly once");
    assert.equal(gateway.pins, 0, "the lifecycle releases the App Server round pin");
    assert.equal(gateway.roundStarts, 1 + gateway.auxiliaryThreads.length, "the business round and each private seed own independent pins");
    assert.equal(gateway.roundEnds, 1 + gateway.auxiliaryThreads.length);
    for (const id of gateway.auxiliaryThreads) {
      assert.equal(gateway.releases.filter((threadId) => threadId === id).length, 1);
      assert.equal(gateway.available.has(id), false);
    }
    assert.equal(gateway.releases.filter((id) => id === originalThread).length, 1, "the original thread subscription is released exactly once");
    if (clarificationMode) {
      assert.ok(gateway.turnStarts.every((turn) => turn.model === "model-A" && turn.effort === "low"));
      const persisted = await store.load(waiting.id);
      assert.equal(persisted.plannerModel, "model-A", "cleanup preserves the original selected model");
      assert.equal(persisted.plannerEffort, "low", "cleanup preserves the original selected effort");
    }
    if (modelInterruption) {
      const persisted = await store.load(waiting.id);
      assert.equal(persisted[stage === "planning" ? "plannerModel" : "reviewerModel"], "model-A");
      assert.equal(persisted[stage === "planning" ? "plannerEffort" : "reviewerEffort"], "low");
    }
    assert.ok(frames.some((entry) => entry.id === originalChild && entry.frame.type === "start"));
    assert.ok(frames.some((entry) => entry.id === originalChild && entry.frame.type === "end"));
    for (const unregister of registrations.reverse()) unregister();
    return { stage, action, waiting: true, persistedColdReplay: true, childCount: children.length, visibleThreadStarts: gateway.threadStarts.length,
      nativeCatalogPreserved: true, nativeMessagesReplayed: true, pendingTools: 0,
      ...(clarificationMode ? { clarificationMode, retainedWaitingPin: true, settingsPreserved: true, originalCleanupOnce: true } : {}),
      ...(action === "answer" ? { sameThread: true, shortAnswer: true, nativeOriginalRequest: clarificationMode === "native", nativeTurns: turnsBefore + 1 } : {}),
      ...(action === "submitted_abort" ? { sameThread: true, nativeOriginalRequest: true, submittedAnswerAborted: true,
        unconfirmedInterruptionRetained: true, cleanupRetried: true, scriptedTerminationAcknowledged: true,
        nativeAnswers: gateway.nativeAnswers.length, sdkTurnStarts: gateway.turnStarts.length, nativeTurns: turnsBefore + 2 } : {}),
      ...(modelInterruption ? { sameThread: true, ordinaryModelInterruption: true, unconfirmedInterruptionRetained: true,
        unconfirmedCleanupDenied: true, cleanupRetried: true, scriptedTerminationAcknowledged: true,
        settingsPreserved: true, originalCleanupOnce: true, interruptionAttempts: gateway.interruptions.length,
        sdkTurnStarts: gateway.turnStarts.length, nativeTurns: turnsBefore + 1 } : {}),
      ...(action === "resume" ? { sameThread: true, shortContinuation: true, nativeTurns: turnsBefore + 1 } : {}) };
  } finally {
    await manager?.stop();
    childFactory?.unregisterProvider();
    await parentWriter?.close();
    await ctx.fiber.dispose();
    store.close();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`), "cleanup stays in the isolated temp directory");
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const results = [];
for (const [stage, action] of [["planning", "resume"], ["reviewing", "resume"], ["planning", "cancel"], ["reviewing", "stop"]]) {
  results.push(await scenario(stage, action));
}
for (const mode of ["native", "converted"]) {
  for (const action of ["answer", "cancel"]) results.push(await scenario("planning", action, mode));
}
results.push(await scenario("planning", "submitted_abort", "native"));
for (const stage of ["planning", "reviewing"]) results.push(await scenario(stage, "model_interruption"));
console.log(JSON.stringify({ ok: true, hostVersion, services: ["ToolRuntime", "AgentRegistry", "SessionStore", "SessionProjectionRegistry", "SubagentRuntime", "SessionPersistence"],
  modelGateway: "scripted-local", storage: "isolated-temp", browserUIVerified: false, scenarios: results }, null, 2));
