import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BlockAssembler, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";

async function fixture() {
  const parentSession = Session.create(SessionId("partial-output-parent"));
  const parent = { id: parentSession.id, session: parentSession } as Agent;
  const children: Session[] = [], frames: Array<{ type: string; revision: number; chunk?: StreamChunk }> = [];
  let provider: SubagentProvider | undefined, run: SubagentRun | undefined, disposals = 0;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    const session = Session.create(options.sessionId); children.push(session);
    return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: (typeof frames)[number] }) { frames.push(payload.frame); } } } as unknown as Agent,
      dispose: async () => { disposals++; } };
  } } as never, {
    registerProvider(value: SubagentProvider) { provider = value; return () => { provider = undefined; }; },
    async start(name: string, request: { parent: Agent; label: string; prompt: Array<{ type: "text"; text: string }>; signal: AbortSignal }) {
      run = await provider!.start({ ...request, descriptor: snapshotSubagentDescriptor({ mode: "one-shot", provider: name, label: request.label }) });
      const session = run.localAgent!.session;
      parentSession.append("subagent/catalog", { version: 0, childId: session.id, childCreatedAt: session.header.createdAt, mode: "one-shot", label: request.label } as never);
      return run;
    },
  } as never);
  const child = await factory.create(parent, process.cwd(), "Original Planner", "Original task", new AbortController().signal);
  const checkStreams = () => {
    for (const event of child.session.snapshotEvents()) if (event.type === "assistant/message") {
      const assembler = new BlockAssembler();
      for (const item of event.data.stream) if (item.type === "chunk") assembler.push(item.chunk);
      assert.deepEqual(assembler.blocks(), event.data.message.content);
    }
    assert.equal(frames.filter(frame => frame.type === "start").length, frames.filter(frame => frame.type === "end").length);
    assert.deepEqual(frames.map(frame => frame.revision), Array.from({ length: frames.length }, (_, index) => index + 1));
  };
  const assistantText = () => child.session.snapshotEvents().filter(event => event.type === "assistant/message")
    .flatMap(event => event.data.message.content.filter(block => block.type === "text").map(block => block.text));
  return { child, children, frames, parentSession, assistantText, checkStreams,
    result: () => run!.result, disposals: () => disposals, close: async () => { await child.dispose(); factory.unregisterProvider(); } };
}

for (const boundary of ["parked", "automatic", "terminal", "cancelled"] as const) {
  test(`the original child retains streamed partial output at ${boundary} settlement`, async () => {
    const f = await fixture();
    try {
      const partial = "已经核对模块一，模块二尚未完成。";
      f.child.progress({ kind: "message", itemId: "original-item", text: partial });
      const original = f.child.id;
      if (boundary === "automatic") f.child.beginContinuation("Continue only the unfinished part");
      else if (boundary === "parked") f.child.failAttempt("Original stream disconnected; waiting for continuation.");
      else f.child.finish("Original stream disconnected.", boundary === "cancelled" ? "aborted" : "failed");
      assert.ok(f.assistantText().some(text => text.includes(partial)), "settled original content must not replace the streamed partial with only an error");
      if (boundary === "automatic" || boundary === "parked") {
        if (boundary === "parked") f.child.beginContinuation("Continue only the unfinished part");
        f.child.progress({ kind: "message", itemId: "continued-item", text: "模块二核对完成。" });
        f.child.finish("模块二核对完成。");
      }
      assert.equal(f.child.id, original); assert.equal(f.children.length, 1);
      assert.equal(f.parentSession.snapshotEvents().filter(event => event.type === "subagent/catalog").length, 1);
      const events = f.child.session.snapshotEvents();
      assert.equal(events.filter(event => event.type === "turn/start").length, events.filter(event => event.type === "turn/end").length);
      assert.equal(events.find(event => event.type === "turn/end")?.data.reason.kind, boundary === "cancelled" ? "aborted" : "error");
      f.checkStreams();
    } finally { await f.close(); assert.equal(f.disposals(), 1); }
  });
}

test("a pending native tool preserves buffered partial text before original-turn cleanup", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "before-tool", text: "Read the first module." });
    f.child.progress({ kind: "tool", itemId: "original-tool", text: "Reading", command: "read module", status: "inProgress" });
    const buffered = "This second-module note was waiting behind the original tool.";
    f.child.progress({ kind: "message", itemId: "buffered-item", text: buffered });
    f.child.failAttempt("Original tool interrupted; waiting.");
    assert.ok(f.assistantText().some(text => text.includes(buffered)), "buffered partial output is committed before the diagnostic");
    const events = f.child.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === "tool/call").length, 1);
    assert.equal(events.filter(event => event.type === "tool/result").length, 1);
    assert.equal(events.find(event => event.type === "tool/result")?.data.message.isError, true);
    f.checkStreams();
    f.child.beginContinuation("Continue the original second module"); f.child.finish("Completed second module");
    assert.equal(f.children.length, 1); f.checkStreams();
  } finally { await f.close(); }
});

test("an empty failed turn records the original diagnostic once and stays resumable", async () => {
  const f = await fixture();
  try {
    f.child.failAttempt("Original empty turn failure.");
    const before = f.child.session.snapshotEvents().length;
    f.child.failAttempt("Original empty turn failure.");
    assert.equal(f.child.session.snapshotEvents().length, before);
    assert.deepEqual(f.assistantText(), ["Original empty turn failure."]);
    f.child.beginContinuation("Continue"); f.child.finish("Recovered"); f.checkStreams();
  } finally { await f.close(); }
});

test("successful authoritative output still replaces provisional text without retaining an error", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "provisional", text: "Provisional output" });
    f.child.finish("Authoritative successful plan");
    assert.deepEqual(f.assistantText(), ["Authoritative successful plan"]);
    assert.deepEqual((await f.result()).output, [{ type: "text", text: "Authoritative successful plan" }]);
    f.checkStreams();
  } finally { await f.close(); }
});

test("cold event replay retains partial text and the original failed/continued turns", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "original", text: "Persisted original partial" });
    f.child.failAttempt("Retained original failure");
    f.child.beginContinuation("Continue only the unfinished work"); f.child.finish("Continued final output");
    const copy = Session.create(f.child.session.id, f.child.session.snapshotEvents(), f.child.session.header);
    assert.ok(copy.deriveMessages().some(message => message.content.some(block => block.type === "text" && block.text.includes("Persisted original partial"))));
    assert.deepEqual(copy.deriveMessages(), f.child.session.deriveMessages());
    f.checkStreams();
  } finally { await f.close(); }
});
