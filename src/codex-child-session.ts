import { randomUUID } from "node:crypto";
import type { Agent, AgentHandle, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage, createUserMessage, type AssistantStreamRecord, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentResult, SubagentRun, SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { AppServerLiveEvent } from "./app-server.js";

const PROVIDER_NAME = "codex-workflow";

export interface CodexChildSessionHandle {
  readonly id: string;
  readonly session: Agent["session"];
  progress(entry: AppServerLiveEvent): void;
  finish(text: string, reason?: "completed" | "failed" | "aborted"): void;
  dispose(): Promise<void>;
}

/** DSH owns catalog and lifecycle through SubagentRuntime. This adapter owns
 * only the child Agent and bridges Codex output into its native conversation. */
export class CodexChildSessionFactory {
  private readonly provider: CodexWorkflowProvider;
  private readonly unregister: () => void;

  constructor(agents: Pick<AgentRegistry, "create">, private readonly subagents: Pick<SubagentRuntime, "start" | "registerProvider">) {
    this.provider = new CodexWorkflowProvider(agents);
    this.unregister = subagents.registerProvider(this.provider);
  }

  async create(parent: Agent, cwd: string, label: string, prompt: string, signal: AbortSignal): Promise<CodexChildSessionHandle> {
    if (parent.session.header.cwd && parent.session.header.cwd !== cwd) throw new Error("Codex subagent workspace differs from parent");
    const run = await this.subagents.start(PROVIDER_NAME, { parent, label,
      prompt: [{ type: "text", text: prompt }], signal });
    const child = this.provider.get(run.id);
    if (!child) {
      await run.dispose();
      throw new Error("Codex subagent provider did not publish its child");
    }
    return { id: child.id, session: child.session, progress: (entry) => child.progress(entry),
      finish: (text, reason) => child.finish(text, reason), dispose: () => run.dispose() };
  }

  unregisterProvider(): void { this.unregister(); }
}

class CodexWorkflowProvider implements SubagentProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities = { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false };
  readonly inheritsParentContext = false;
  private readonly children = new Map<string, CodexChildSession>();

  constructor(private readonly agents: Pick<AgentRegistry, "create">) {}
  get(id: string): CodexChildSession | undefined { return this.children.get(id); }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const parent = request.parent;
    const id = SessionId(randomUUID());
    const handle = await this.agents.create({ sessionId: id, parentAgent: parent, signal: request.signal,
      meta: { cwd: parent.session.header.cwd, parentSession: parent.id, origin: "subagent",
        delegationDepth: Number(parent.session.header.delegationDepth ?? 0) + 1 } });
    let settle!: (result: SubagentResult) => void;
    const result = new Promise<SubagentResult>((resolve) => { settle = resolve; });
    const child = new CodexChildSession(handle, request.descriptor, settle);
    try {
      const prompt = request.prompt.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text).join("\n");
      child.start(prompt);
      this.children.set(id, child);
    } catch (error) {
      await child.dispose();
      throw error;
    }
    return { id, localAgent: handle.agent, result, dispose: async () => {
      this.children.delete(id);
      await child.dispose();
    } };
  }
}

class CodexChildSession {
  readonly id: string;
  readonly session: Agent["session"];
  private text = "";
  private started = false;
  private finished = false;
  private closed = false;
  private revision = 0;
  private chunkIndex = 0;
  private readonly attemptId: string;
  private readonly stream: AssistantStreamRecord[] = [];

  constructor(private readonly handle: AgentHandle,
    private readonly descriptor: ResolvedSubagentStartRequest["descriptor"],
    private readonly settle: (result: SubagentResult) => void) {
    this.id = handle.agent.id;
    this.session = handle.agent.session;
    this.attemptId = `${this.id}:codex:1`;
  }

  start(prompt: string): void {
    if (this.started) return;
    this.session.append("turn/start", { turn: 1 });
    (this.session.append as unknown as (type: string, data: unknown) => unknown)("subagent/descriptor", this.descriptor);
    this.session.append("user/message", createUserMessage({ content: [{ type: "text", text: prompt }],
      source: { kind: "user" } }), { surfaceOp: "append" });
    this.session.append("step/start", { turn: 1, step: 1 });
    this.started = true;
    this.emitFrame({ type: "start", attemptId: this.attemptId, revision: ++this.revision, turn: 1, step: 1 });
  }

  private emitFrame(frame: Record<string, unknown>): void {
    const ctx = (this.handle.agent as Agent & { ctx?: { emit?: (name: string, payload: unknown) => unknown } }).ctx;
    ctx?.emit?.("agent/assistant-stream", { agent: this.handle.agent, frame });
  }

  private pushChunk(chunk: StreamChunk): void {
    const time = Date.now();
    this.stream.push({ type: "chunk", time, chunk });
    this.emitFrame({ type: "chunk", attemptId: this.attemptId, revision: ++this.revision,
      index: this.chunkIndex++, time, chunk });
  }

  progress(entry: AppServerLiveEvent): void {
    if (this.closed || this.finished) return;
    const rendered = entry.kind === "tool" || entry.kind === "reasoning" ? `\n\n[${entry.kind}] ${entry.text}` : entry.text;
    if (this.stream.length === 0) this.pushChunk({ type: "block-start", index: 0, blockType: "text" });
    this.text += rendered;
    this.pushChunk({ type: "text-delta", index: 0, text: rendered });
  }

  finish(text: string, reason: "completed" | "failed" | "aborted" = "completed"): void {
    if (this.closed || this.finished) return;
    if (text && text !== this.text) this.text = text;
    if (this.stream.length === 0) this.pushChunk({ type: "block-start", index: 0, blockType: "text" });
    this.pushChunk({ type: "block-end", index: 0, block: { type: "text", text: this.text } });
    this.pushChunk({ type: "finish", reason: { kind: "stop" } });
    const settled = this.session.append("assistant/message", { turn: 1, step: 1, stream: this.stream,
      message: createAssistantMessage({ content: [{ type: "text", text: this.text }],
        source: { provider: "codex", model: "codex-app-server" } }) }, { surfaceOp: "append" });
    this.emitFrame({ type: "end", attemptId: this.attemptId, revision: ++this.revision,
      index: this.chunkIndex, outcome: { kind: "committed", eventType: "assistant/message", seq: settled.seq } });
    this.session.append("step/end", { turn: 1, step: 1 });
    this.session.append("turn/end", { turn: 1, reason: reason === "completed" ? { kind: "completed" }
      : reason === "aborted" ? { kind: "aborted", reason: { kind: "user" } }
        : { kind: "error", error: { message: "Codex run failed", code: "UNKNOWN" } } });
    this.finished = true;
    this.settle({ output: this.text ? [{ type: "text", text: this.text }] : [],
      stopReason: reason === "failed" ? "error" : reason });
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    if (!this.finished) this.finish("", "aborted");
    this.closed = true;
    await this.handle.dispose();
  }
}

export function codexSubagentChatAddress(parentSessionId: string, childSessionId: string): string {
  const query = new URLSearchParams({ parent: parentSessionId, mode: "one-shot" });
  return `dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?${query}`;
}
