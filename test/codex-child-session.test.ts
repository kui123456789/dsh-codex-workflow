import assert from "node:assert/strict";
import test from "node:test";
import { Session, SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { snapshotSubagentDescriptor, type SubagentProvider, type SubagentRun } from "@deepseek-ai/dsh-subagent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CodexChildSessionFactory, codexSubagentChatAddress } from "../src/codex-child-session.js";

test("Codex runs as a DSH subagent with native catalog, stream and conversation", async () => {
  const parentSession = Session.create(SessionId("parent-native"));
  const parent = { id: "parent-native", session: parentSession } as unknown as Agent;
  const frames: Array<{ type: string; revision: number }> = [];
  const children: Session[] = [];
  let disposed = false;
  const agents = { create: async (options: { sessionId: ReturnType<typeof SessionId> }) => {
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
  child.progress({ kind: "message", itemId: "m1", text: "第一步" });
  child.finish("第一步");
  assert.equal(parentSession.snapshotEvents().at(-1)?.type, "subagent/catalog");
  assert.equal(children[0]?.snapshotEvents().at(-1)?.type, "turn/end");
  assert.ok(children[0]?.snapshotEvents().some((event) => event.type === "subagent/descriptor"));
  assert.deepEqual(frames.map((frame) => frame.type), ["start", "chunk", "chunk", "chunk", "chunk", "end"]);
  assert.deepEqual(frames.map((frame) => frame.revision), [1, 2, 3, 4, 5, 6]);
  assert.equal((await run!.result).stopReason, "completed");
  assert.match(codexSubagentChatAddress(parent.id, child.id), /^dsh-resource:\/\/subagentchat\/session\//);
  await child.dispose();
  assert.equal(disposed, true);
  factory.unregisterProvider();
});
