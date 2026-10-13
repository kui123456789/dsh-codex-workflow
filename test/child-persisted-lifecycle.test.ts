import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionLogOffset, type Session } from "@deepseek-ai/dsh-session";
import { CodexChildSessionFactory } from "../src/codex-child-session.js";

const hostRequire = createRequire(import.meta.url);
const loadHost = (name: string) => import(pathToFileURL(hostRequire.resolve(name)).href);

for (const boundary of ["interruption", "clarification"] as const) for (const compression of ["none", "zstd"] as const) test(`Codex child ${boundary === "clarification" ? "clarification answer" : "tool continuation"} survives released DSH V4 cold ${compression} persistence and live frame replay`, async () => {
  const [cordis, sessions, persistence, llm, streams, projections, subagents, clientFrames] = await Promise.all([
    loadHost("@deepseek-ai/cordis"), loadHost("@deepseek-ai/dsh-session"), loadHost("@deepseek-ai/dsh-session-persistence-jsonl"),
    loadHost("@deepseek-ai/dsh-llm"), loadHost("@deepseek-ai/dsh-llm/assistant-stream"),
    loadHost("@deepseek-ai/dsh-session-projection"), loadHost("@deepseek-ai/dsh-subagent"),
    import(pathToFileURL(join(dirname(hostRequire.resolve("@deepseek-ai/dsh-api-session-controller/package.json")),
      "lib", "types", "client", "sessions", "assistant-stream.js")).href),
  ]);
  const directory = await mkdtemp(join(tmpdir(), "dsh-child-stored-lifecycle-"));
  const ctx = new cordis.Context();
  let readerContext: any;
  let writer: any;
  let reader: any;
  let child: Awaited<ReturnType<CodexChildSessionFactory["create"]>> | undefined;
  let factory: CodexChildSessionFactory | undefined;
  try {
    await ctx.plugin(persistence.default, { root: directory, compression });
    await ctx.plugin(projections.SessionProjectionRegistry, {});
    await ctx.plugin(subagents.SubagentRuntime, {});
    const frameReplay = new clientFrames.ClientAssistantStream();
    frameReplay.replace([]);
    const frames: Array<Record<string, any>> = [];
    const parentId = sessions.SessionId("isolated-parent");
    const parentSession = sessions.Session.create(parentId, [], {
      version: sessions.SESSION_FORMAT_VERSION, id: parentId, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false,
    });
    const parent = { id: parentSession.id, session: parentSession } as Agent;
    factory = new CodexChildSessionFactory({ create: async (options: { sessionId: string; meta: object }) => {
      const session = sessions.Session.create(options.sessionId, [], {
        version: sessions.SESSION_FORMAT_VERSION, id: options.sessionId, createdAt: Date.now(), isSeeded: false,
        ...options.meta,
      }) as Session;
      const append = session.append.bind(session);
      session.append = ((...args: Parameters<typeof append>) => {
        const event = Reflect.apply(append, session, args);
        assert.notEqual(frameReplay.acceptDurable({ type: "event", event })?.type, "rebaseline", "durable settlement has a valid active frame");
        return event;
      }) as typeof session.append;
      return { agent: { id: session.id, session, ctx: { emit(_name: string, payload: { frame: Record<string, any> }) {
        frames.push(payload.frame);
        assert.notEqual(frameReplay.acceptFrame(payload.frame)?.type, "rebaseline", "live frame segments do not overlap or lose their settlement");
      } } } as unknown as Agent, dispose: async () => undefined };
    } } as never, ctx.subagents);
    child = await factory.create(parent, process.cwd(), "Isolated Codex", "Inspect the workspace", new AbortController().signal);
    child.progress({ kind: "tool", itemId: "actual-tool-item", command: "read local fixture", cwd: process.cwd(), text: "Reading", status: "inProgress" });
    child.progress({ kind: "tool", itemId: "actual-tool-item", command: "read local fixture", cwd: process.cwd(), text: "Read completed", status: "completed", exitCode: 0 });
    const longPrefix = "shared-item-prefix-" + "x".repeat(140);
    child.progress({ kind: "plan", itemId: "original-steps", text: "Superseded original plan snapshot", replace: true });
    child.progress({ kind: "plan", itemId: "original-steps", text: "Corrected original plan snapshot", replace: true });
    child.progress({ kind: "message", itemId: "analysis", text: "Continue inspecting." });
    child.progress({ kind: "tool", itemId: `${longPrefix}A`, command: "read A", text: "Reading A", status: "inProgress" });
    child.progress({ kind: "tool", itemId: `${longPrefix}B`, command: "read B", text: "Reading B", status: "inProgress" });
    child.progress({ kind: "message", itemId: "parallel-analysis", text: "Awaiting the remaining inspection." });
    child.progress({ kind: "tool", itemId: `${longPrefix}A`, text: "A completed", status: "completed", exitCode: 0 });
    child.progress({ kind: "tool", itemId: `${longPrefix}A`, text: "duplicate completion", status: "completed", exitCode: 0 });
    const question = "Which workspace should the inspection target?";
    if (boundary === "clarification") child.pauseForInput!(question);
    else child.failAttempt("The model turn was interrupted.");
    const originalId = child.id;
    writer = await ctx.sessionPersistence.create(child.session.header);
    await writer.append(child.session.snapshotEvents());
    await writer.flush();
    readerContext = new cordis.Context();
    await readerContext.plugin(persistence.default, { root: directory, compression });
    reader = await readerContext.sessionPersistence.open(child.id, "read");
    const interrupted = await reader.read();
    assert.equal(interrupted.events.filter((event: { type: string }) => event.type === "tool/call").length, 3);
    assert.equal(interrupted.events.filter((event: { type: string }) => event.type === "tool/result").length, 3, "waiting has no unresolved native tools");
    assert.deepEqual(interrupted.events.filter((event: { type: string }) => event.type === "turn/end").map((event: any) => event.data.reason.kind),
      [boundary === "clarification" ? "completed" : "error"], "clarification is a completed question rather than a failed model marker");
    const waitingReplay = sessions.Session.create(reader.id, interrupted.events, reader.header);
    assert.ok(waitingReplay.deriveMessages().some((message: any) => message.content.some((block: any) =>
      block.type === "text" && block.text.includes("Corrected original plan snapshot"))), "native replacement survives actual closed-file replay");
    assert.ok(!waitingReplay.deriveMessages().some((message: any) => message.content.some((block: any) =>
      block.type === "text" && block.text.includes("Superseded original plan snapshot"))), "the replaced draft is not committed as duplicate history");
    if (boundary === "clarification") assert.equal(waitingReplay.deriveMessages().at(-1).content[0].text, question);
    else assert.ok(waitingReplay.deriveMessages().some((message: any) => message.content.some((block: any) =>
      block.type === "text" && block.text.includes("Awaiting the remaining inspection."))),
      "failed cold replay retains the original buffered partial output, not only its interruption diagnostic");
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length,
      "waiting closes each live frame exactly once");
    const waitingCatalog = ctx.sessionProjections.snapshot(parentSession).values.subagentCatalog;
    assert.equal(waitingCatalog.length, 1);
    assert.equal(waitingCatalog[0].id, originalId);
    const beforeContinuation = child.session.snapshotEvents().length;
    await reader.close();
    child.beginContinuation(boundary === "clarification" ? "Use the current workspace." : "Continue the original inspection.");
    child.progress({ kind: "tool", itemId: `${longPrefix}A`, command: "read original A again", text: "Continued reading", status: "inProgress" });
    child.progress({ kind: "tool", itemId: `${longPrefix}A`, text: "Continued read complete", status: "completed", exitCode: 0 });
    child.progress({ kind: "message", itemId: "final-plan", text: "The original inspection is complete." });
    child.finish("The original inspection is complete.");
    assert.equal(child.id, originalId);
    await writer.append(child.session.snapshotEvents(SessionLogOffset(beforeContinuation)));
    await writer.flush();
    await writer.close();
    reader = await readerContext.sessionPersistence.open(originalId, "read");
    const restored = await reader.read();
    const calls = restored.events.filter((event: { type: string }) => event.type === "tool/call");
    const results = restored.events.filter((event: { type: string }) => event.type === "tool/result");
    assert.equal(calls.length, 4);
    assert.equal(results.length, 4);
    assert.equal(new Set(calls.map((event: any) => event.data.callId)).size, 4, "raw long ids and repeated turn ids have independent native tool identities");
    assert.ok(results.some((event: any) => event.data.message.isError === true), "interrupted pending tool is explicitly balanced");
    for (const event of calls) {
      const advertised = restored.events.find((entry: any) => entry.type === "assistant/message" && entry.seq < event.seq
        && entry.data.message.content.some((block: any) => block.type === "tool-call" && block.id === event.data.callId));
      const block = advertised.data.message.content.find((entry: any) => entry.type === "tool-call" && entry.id === event.data.callId);
      assert.equal(block.name, event.data.name);
      assert.equal(block.arguments, event.data.arguments, "native advertisement matches the exact serialized arguments");
    }
    for (const event of restored.events.filter((entry: { type: string }) => entry.type === "assistant/message")) {
      const assembler = new llm.BlockAssembler();
      for (const member of streams.expandAssistantStream(event.data.stream)) assembler.push(member.chunk);
      assert.deepEqual(assembler.blocks(), event.data.message.content, "stored stream reassembles the authoritative native message");
    }
    assert.deepEqual(restored.events.filter((event: any) => event.type === "turn/start").map((event: any) => event.data.turn), [1, 2]);
    assert.deepEqual(restored.events.filter((event: any) => event.type === "turn/end").map((event: any) => event.data.reason.kind),
      [boundary === "clarification" ? "completed" : "error", "completed"]);
    const replay = sessions.Session.create(reader.id, restored.events, reader.header);
    assert.equal(replay.id, child.id);
    assert.deepEqual(replay.deriveMessages(), child.session.deriveMessages());
    if (boundary === "interruption") assert.ok(replay.deriveMessages().some((message: any) => message.content.some((block: any) =>
      block.type === "text" && block.text.includes("Awaiting the remaining inspection."))),
      "completed continuation cannot erase its original failed turn's streamed partial");
    const catalog = ctx.sessionProjections.snapshot(parentSession).values.subagentCatalog;
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].id, originalId, "the same native sidebar catalog child survives continuation");
    const identity = ctx.sessionProjections.snapshot(replay).values.subagent;
    assert.equal(identity.mode, "one-shot");
    assert.equal(replay.deriveMessages().at(-1).content[0].text, "The original inspection is complete.");
    assert.equal(frames.filter((frame) => frame.type === "start").length, frames.filter((frame) => frame.type === "end").length);
    assert.deepEqual(frames.map((frame) => frame.revision), Array.from({ length: frames.length }, (_, index) => index + 1));
  } finally {
    await reader?.close();
    await writer?.close();
    await readerContext?.fiber.dispose();
    await child?.dispose();
    factory?.unregisterProvider();
    await ctx.fiber.dispose();
    assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
