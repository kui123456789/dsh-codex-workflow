import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BlockAssembler, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";

const hostRequire = createRequire(import.meta.url);
const clientModule = await import(pathToFileURL(join(dirname(hostRequire.resolve("@deepseek-ai/dsh-api-session-controller/package.json")),
  "lib/types/client/sessions/assistant-stream.js")).href);

async function fixture() {
  const parentSession = Session.create(SessionId("partial-output-parent"));
  const parent = { id: parentSession.id, session: parentSession } as Agent;
  const children: Session[] = [], frames: Array<{ type: string; revision: number; chunk?: StreamChunk }> = [];
  const frameReplay = new clientModule.ClientAssistantStream(); frameReplay.replace([]);
  let provider: SubagentProvider | undefined, run: SubagentRun | undefined, disposals = 0;
  const factory = new CodexChildSessionFactory({ create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
    const session = Session.create(options.sessionId); children.push(session);
    const append = session.append.bind(session);
    session.append = ((...args: Parameters<typeof append>) => {
      const event = Reflect.apply(append, session, args);
      assert.notEqual(frameReplay.acceptDurable({ type: "event", event })?.type, "rebaseline", "native durable settlement keeps its original stream identity");
      return event;
    }) as typeof session.append;
    return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: (typeof frames)[number] }) {
      frames.push(payload.frame);
      assert.notEqual(frameReplay.acceptFrame(payload.frame)?.type, "rebaseline", "replacement retires the original display attempt before its next native start");
    } } } as unknown as Agent,
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

test("a corrected original message replaces its own provisional text before failed settlement", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "original", text: "Incorrect provisional output" });
    f.child.progress({ kind: "message", itemId: "original", text: "Corrected original output", replace: true });
    f.child.failAttempt("Original stream interrupted.");
    assert.deepEqual(f.assistantText(), ["Corrected original output\n\nOriginal stream interrupted."]);
    f.checkStreams();
  } finally { await f.close(); }
});

test("repeated plan snapshots retain only the latest original plan state", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "plan", itemId: "steps", text: "→ Read module", replace: true });
    f.child.progress({ kind: "plan", itemId: "steps", text: "✓ Read module", replace: true });
    f.child.progress({ kind: "plan", itemId: "steps", text: "✓ Read module\n→ Inspect tests", replace: true });
    f.child.failAttempt("Waiting for the original model.");
    assert.deepEqual(f.assistantText(), ["✓ Read module\n→ Inspect tests\n\nWaiting for the original model."]);
    f.checkStreams();
  } finally { await f.close(); }
});

test("replacement is scoped to kind and item while preserving surrounding text", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "shared", text: "Old message" });
    f.child.progress({ kind: "plan", itemId: "shared", text: "Distinct plan" });
    f.child.progress({ kind: "message", itemId: "peer", text: "Peer message" });
    f.child.progress({ kind: "message", itemId: "shared", text: "Corrected message", replace: true });
    f.child.failAttempt("Interrupted.");
    assert.deepEqual(f.assistantText(), ["Corrected messageDistinct planPeer message\n\nInterrupted."]);
    f.checkStreams();
  } finally { await f.close(); }
});

test("a tool-buffered replacement drops only its old buffered snapshot", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "tool", itemId: "original-tool", text: "Reading", status: "inProgress" });
    f.child.progress({ kind: "plan", itemId: "steps", text: "Old buffered plan", replace: true });
    f.child.progress({ kind: "message", itemId: "peer", text: "Keep buffered peer" });
    f.child.progress({ kind: "plan", itemId: "steps", text: "Latest buffered plan", replace: true });
    f.child.failAttempt("Original tool interrupted.");
    assert.ok(f.assistantText().includes("Latest buffered planKeep buffered peer\n\nOriginal tool interrupted."));
    assert.ok(!f.assistantText().some(text => text.includes("Old buffered plan")));
    f.checkStreams();
  } finally { await f.close(); }
});

test("an empty replacement clears the targeted text but preserves another original item", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "original", text: "Remove this" });
    f.child.progress({ kind: "message", itemId: "peer", text: "Keep this" });
    f.child.progress({ kind: "message", itemId: "original", text: "", replace: true });
    f.child.failAttempt("Interrupted.");
    assert.deepEqual(f.assistantText(), ["Keep this\n\nInterrupted."]);
    f.checkStreams();
  } finally { await f.close(); }
});

test("reused item names after continuation do not replace the previous failed turn", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "shared", text: "First turn original" });
    f.child.failAttempt("First failure."); f.child.beginContinuation("Continue original work");
    f.child.progress({ kind: "message", itemId: "shared", text: "Second provisional" });
    f.child.progress({ kind: "message", itemId: "shared", text: "Second corrected", replace: true });
    f.child.failAttempt("Second failure.");
    assert.deepEqual(f.assistantText(), ["First turn original\n\nFirst failure.", "Second corrected\n\nSecond failure."]);
    assert.equal(f.children.length, 1); f.checkStreams();
  } finally { await f.close(); }
});

test("ordinary deltas still append in original order and successful final output remains authoritative", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "one", text: "A" });
    f.child.progress({ kind: "message", itemId: "two", text: "B" });
    f.child.progress({ kind: "message", itemId: "one", text: "C" });
    f.child.finish("Authoritative final output");
    assert.deepEqual(f.assistantText(), ["Authoritative final output"]); f.checkStreams();
  } finally { await f.close(); }
});

test("a corrected snapshot retires the provisional live attempt before failed settlement", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "original", text: "Provisional live text" });
    const before = f.frames.length;
    f.child.progress({ kind: "message", itemId: "original", text: "Corrected live text", replace: true });
    const replacementFrames = f.frames.slice(before) as Array<{ type: string; outcome?: { kind: string }; chunk?: StreamChunk }>;
    assert.equal(replacementFrames[0]?.type, "end"); assert.equal(replacementFrames[0]?.outcome?.kind, "abandoned");
    assert.equal(replacementFrames[1]?.type, "start");
    assert.ok(replacementFrames.some(frame => frame.chunk?.type === "text-delta" && frame.chunk.text === "Corrected live text"));
    assert.equal(f.child.session.snapshotEvents().filter(event => event.type === "assistant/message").length, 0,
      "the replaced live draft is not committed as a duplicate message");
    f.child.failAttempt("Interrupted."); f.checkStreams();
    assert.equal(f.child.session.snapshotEvents().filter(event => event.type === "turn/start").length, 1);
  } finally { await f.close(); }
});

test("an identical snapshot does not restart the current native display attempt", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "plan", itemId: "steps", text: "✓ Same state", replace: true });
    const before = f.frames.length;
    f.child.progress({ kind: "plan", itemId: "steps", text: "✓ Same state", replace: true });
    assert.equal(f.frames.length, before); f.child.failAttempt("Waiting."); f.checkStreams();
    assert.deepEqual(f.assistantText(), ["✓ Same state\n\nWaiting."]);
  } finally { await f.close(); }
});

test("a replacement after a tool boundary preserves its already committed predecessor", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "reused", text: "Committed before tool" });
    f.child.progress({ kind: "tool", itemId: "original-tool", text: "Reading", status: "inProgress" });
    f.child.progress({ kind: "tool", itemId: "original-tool", text: "Completed", status: "completed", exitCode: 0 });
    f.child.progress({ kind: "message", itemId: "reused", text: "After-tool provisional" });
    f.child.progress({ kind: "message", itemId: "reused", text: "After-tool corrected", replace: true });
    f.child.failAttempt("Waiting.");
    assert.ok(f.assistantText().includes("Committed before tool"));
    assert.ok(f.assistantText().includes("After-tool corrected\n\nWaiting."));
    f.checkStreams();
  } finally { await f.close(); }
});

test("replacement removes interleaved deltas only for its original item", async () => {
  const f = await fixture();
  try {
    f.child.progress({ kind: "message", itemId: "one", text: "Old first fragment" });
    f.child.progress({ kind: "message", itemId: "peer", text: "Preserve peer" });
    f.child.progress({ kind: "message", itemId: "one", text: "Old later fragment" });
    f.child.progress({ kind: "message", itemId: "one", text: "Corrected whole item", replace: true });
    f.child.failAttempt("Waiting.");
    assert.deepEqual(f.assistantText(), ["Corrected whole itemPreserve peer\n\nWaiting."]); f.checkStreams();
  } finally { await f.close(); }
});

test("replacement keeps distinct full-length item identities even with identical prefixes", async () => {
  const f = await fixture();
  try {
    const prefix = "original-long-item-" + "x".repeat(150);
    f.child.progress({ kind: "message", itemId: prefix + "A", text: "Old A" });
    f.child.progress({ kind: "message", itemId: prefix + "B", text: "Preserve B" });
    f.child.progress({ kind: "message", itemId: prefix + "A", text: "Corrected A", replace: true });
    f.child.failAttempt("Waiting.");
    assert.deepEqual(f.assistantText(), ["Corrected APreserve B\n\nWaiting."]); f.checkStreams();
  } finally { await f.close(); }
});
