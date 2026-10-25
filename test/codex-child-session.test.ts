import assert from "node:assert/strict";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CodexChildSessionFactory, codexSubagentChatAddress } from "../src/codex-child-session.js";

test("Codex runs as a DSH subagent with native catalog, stream and conversation", async () => {
  const parentSession = Session.create(SessionId("parent-native"));
  const parent = { id: "parent-native", session: parentSession,
    ctx: { get: (name: string) => name === "agentPresets" ? { composedPreset: () => "standard" } : undefined },
  } as unknown as Agent;
  const frames: Array<{ type: string; revision: number }> = [];
  const children: Session[] = [];
  let disposed = false;
  let createdMeta: Record<string, unknown> | undefined;
  const agents = { create: async (options: { sessionId: ReturnType<typeof SessionId>; meta?: Record<string, unknown> }) => {
    createdMeta = options.meta;
    const session = Session.create(options.sessionId, [], {
      version: SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: Date.now(),
      cwd: process.cwd(), parentSession: SessionId(parent.id), origin: "subagent",
      delegationDepth: 1, isSeeded: false,
    });
    children.push(session);
    return { agent: { id: options.sessionId, session,
      ctx: { emit(_name: string, payload: { frame: { type: string; revision: number } }) { frames.push(payload.frame); } } } as unknown as Agent,
      dispose: async () => { disposed = true; } };
  } };
  let provider: SubagentProvider | undefined;
  let run: SubagentRun | undefined;
  const subagents = {
    registerProvider(value: SubagentProvider) { provider = value; return () => { provider = undefined; }; },
    async start(name: string, request: { parent: Agent; label: string; prompt: Array<{ type: "text"; text: string }>; signal: AbortSignal }) {
      const descriptor = snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label });
      run = await provider!.start({ ...request, descriptor });
      const session = run.localAgent!.session;
      parentSession.append("subagent/catalog", { version: 0, childId: session.id,
        childCreatedAt: session.header.createdAt, mode: "one-shot", label: request.label } as never);
      return run;
    },
  };
  const factory = new CodexChildSessionFactory(agents as never, subagents as never);
  const child = await factory.create(parent, process.cwd(), "Codex Planner", "请规划", new AbortController().signal);
  assert.equal(createdMeta?.agentPreset, "standard", "Codex child metadata must preserve the active agent preset");
  child.progress({ kind: "message", itemId: "m1", text: "第一步" });
  child.progress({ kind: "tool", itemId: "pending-tool", text: "Reading workspace", status: "inProgress" });
  child.beginContinuation("继续当前规划");
  child.progress({ kind: "message", itemId: "m2", text: "第二步" });
  child.finish("第二步");
  assert.equal(parentSession.snapshotEvents().at(-1)?.type, "subagent/catalog");
  const childEvents = children[0]?.snapshotEvents() ?? [];
  assert.equal(childEvents.at(-1)?.type, "turn/end");
  assert.deepEqual(childEvents.filter((event) => event.type === "turn/start").map((event) => (event.data as { turn: number }).turn), [1, 2]);
  const calls = childEvents.filter((event) => event.type === "tool/call");
  const results = childEvents.filter((event) => event.type === "tool/result");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1, "an interrupted tool must be balanced before a continuation opens");
  assert.equal(results[0]?.data.message.toolCallId, calls[0]?.data.callId);
  assert.equal(results[0]?.data.message.isError, true);
  const advertised = childEvents.find((event) => event.type === "assistant/message"
    && event.data.message.content.some((block) => block.type === "tool-call" && block.id === calls[0]?.data.callId));
  assert.ok(advertised && advertised.type === "assistant/message", "a native assistant tool-call precedes the actual invocation");
  const block = advertised.data.message.content.find((entry) => entry.type === "tool-call");
  assert.ok(block && block.type === "tool-call");
  assert.equal(block.name, calls[0]?.data.name);
  assert.equal(block.arguments, calls[0]?.data.arguments);
  assert.ok(advertised.seq < calls[0]!.seq);
  assert.ok(children[0]?.snapshotEvents().some((event) => event.type === "subagent/descriptor"));
  assert.equal(frames[0]?.type, "start");
  assert.equal(frames.at(-1)?.type, "end");
  assert.deepEqual(frames.map((frame) => frame.revision), Array.from({ length: frames.length }, (_, index) => index + 1));
  assert.equal((await run!.result).stopReason, "completed");
  assert.match(codexSubagentChatAddress(parent.id, child.id), /^dsh-resource:\/\/subagentchat\/session\//);
  await child.dispose();
  assert.equal(disposed, true);
  factory.unregisterProvider();
});

test("Codex clarification waits without settling and appends the answer to its original child", async () => {
  const parentSession = Session.create(SessionId("parent-clarification"));
  const parent = { id: parentSession.id, session: parentSession } as Agent;
  const children: Session[] = [];
  const frames: Array<{ type: string; revision: number }> = [];
  let disposed = 0;
  let provider: SubagentProvider | undefined;
  let run: SubagentRun | undefined;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    const session = Session.create(options.sessionId);
    children.push(session);
    return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: { type: string; revision: number } }) {
      frames.push(payload.frame);
    } } } as unknown as Agent, dispose: async () => { disposed += 1; } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => { provider = undefined; }; },
    async start(name: string, request: { parent: Agent; label: string; prompt: Array<{ type: "text"; text: string }>; signal: AbortSignal }) {
      run = await provider!.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) });
      const session = run.localAgent!.session;
      parentSession.append("subagent/catalog", { version: 0, childId: session.id,
        childCreatedAt: session.header.createdAt, mode: "one-shot", label: request.label } as never);
      return run;
    },
  } as never);
  const child = await factory.create(parent, process.cwd(), "Codex Planner", "Plan the change", new AbortController().signal);
  try {
    let settled = false;
    void run!.result.then(() => { settled = true; });
    const originalId = child.id;
    const question = "Which workspace should the plan target?";
    assert.equal(typeof child.pauseForInput, "function", "the child can wait for clarification without finalizing");
    child.pauseForInput!(question);
    const waitingEventCount = child.session.snapshotEvents().length;
    child.pauseForInput!(question);
    assert.equal(child.session.snapshotEvents().length, waitingEventCount, "repeated waiting notifications do not close the same turn twice");
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(disposed, 0);
    assert.deepEqual(child.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason), [{ kind: "completed" }]);
    assert.equal(child.session.deriveMessages().at(-1)?.content[0]?.type, "text");
    assert.equal((child.session.deriveMessages().at(-1)?.content[0] as { text: string }).text, question);
    child.beginContinuation("Use the current workspace.");
    child.progress({ kind: "message", itemId: "answer-plan", text: "Plan for the current workspace." });
    child.finish("Plan for the current workspace.");
    assert.equal(child.id, originalId);
    assert.equal(children.length, 1);
    assert.equal(parentSession.snapshotEvents().filter((event) => event.type === "subagent/catalog").length, 1);
    assert.deepEqual(child.session.snapshotEvents().filter((event) => event.type === "turn/start").map((event) => event.data.turn), [1, 2]);
    assert.deepEqual(child.session.snapshotEvents().filter((event) => event.type === "turn/end").map((event) => event.data.reason), [{ kind: "completed" }, { kind: "completed" }]);
    const result = await run!.result;
    assert.equal(result.stopReason, "completed");
    assert.deepEqual(result.output, [{ type: "text", text: "Plan for the current workspace." }]);
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length);
  } finally {
    await child.dispose();
    assert.equal(disposed, 1);
    factory.unregisterProvider();
  }
});

test("activation-only hosts retain a real native one-shot child without starting a model activation", async () => {
  const parentSession = Session.create(SessionId("parent-activation-host"), [], {
    version: SESSION_FORMAT_VERSION, id: SessionId("parent-activation-host"), createdAt: Date.now(), isSeeded: false, cwd: process.cwd(),
  });
  const parent = { id: parentSession.id, session: parentSession } as Agent;
  const children: Session[] = [];
  let disposed = 0;
  const factory = new CodexChildSessionFactory({ create: async (options: {
    sessionId: ReturnType<typeof SessionId>; parentAgent: Agent; meta: Record<string, unknown>;
  }) => {
    assert.equal(options.parentAgent, parent);
    const session = Session.create(options.sessionId, [], {
      version: SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: Date.now(), isSeeded: false, ...options.meta,
    });
    children.push(session);
    return { agent: { id: session.id, session } as Agent, dispose: async () => { disposed += 1; } };
  } } as never, {
    registerProvider() { return () => {}; },
    startActivation() { assert.fail("native Codex mirrors must not start an external activation or a parent-model loop"); },
  });
  const child = await factory.create(parent, process.cwd(), "Codex Planner", "Plan the change", new AbortController().signal);
  try {
    assert.equal(children.length, 1);
    assert.equal(child.session.header.parentSession, parent.id);
    assert.equal(child.session.header.origin, "subagent");
    assert.equal(child.session.header.delegationDepth, 1);
    assert.equal(child.session.header.agentPreset, "standard");
    const catalog = parentSession.snapshotEvents().filter(event => event.type === "subagent/catalog");
    assert.equal(catalog.length, 1);
    assert.deepEqual(catalog[0]?.data, { version: 0, childId: child.id,
      childCreatedAt: child.session.header.createdAt, mode: "one-shot", label: "Codex Planner" });
    const descriptor = child.session.snapshotEvents().find(event => event.type === "subagent/descriptor");
    assert.deepEqual(descriptor?.data, snapshotSubagentDescriptor({ mode: "one-shot", provider: "codex-workflow", label: "Codex Planner" }));
    child.pauseForInput!("Which directory?");
    child.beginContinuation("Use this directory.");
    child.finish("The plan is ready.");
    assert.deepEqual(child.session.snapshotEvents().filter(event => event.type === "turn/start").map(event => event.data.turn), [1, 2]);
    assert.equal(parentSession.snapshotEvents().filter(event => event.type === "subagent/catalog").length, 1);
    assert.equal(child.session.deriveMessages().at(-1)?.content[0]?.type, "text");
  } finally {
    await child.dispose();
    await child.dispose();
    assert.equal(disposed, 1);
    factory.unregisterProvider();
  }
});

test("activation-only host releases the real child if catalog publication fails", async () => {
  const parentSession = Session.create(SessionId("parent-catalog-failure"));
  const parent = { id: parentSession.id, session: parentSession } as Agent;
  const failure = new Error("parent session publication failed");
  parentSession.append = (() => { throw failure; }) as typeof parentSession.append;
  let disposed = 0;
  let childSession: Session | undefined;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    childSession = Session.create(options.sessionId);
    return { agent: { id: options.sessionId, session: childSession } as Agent, dispose: async () => { disposed += 1; } };
  } } as never, {
    registerProvider() { return () => {}; },
    startActivation() { assert.fail("native Codex mirrors must not use external activation admission"); },
  });
  try {
    await assert.rejects(factory.create(parent, process.cwd(), "Codex Planner", "Plan the change", new AbortController().signal),
      error => error === failure);
    assert.equal(disposed, 1);
    assert.equal(childSession?.snapshotEvents().at(-1)?.type, "turn/end");
    assert.equal(parentSession.snapshotEvents().length, 0);
  } finally {
    factory.unregisterProvider();
  }
});
