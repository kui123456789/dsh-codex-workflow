import { randomUUID } from "node:crypto";
import type { Agent, AgentHandle, AgentRegistry } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId, type AssistantStreamRecord, type ContentBlock, type StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { childSessionMeta, type ResolvedSubagentStartRequest, type SubagentProvider, type SubagentResult, type SubagentRun, type SubagentRuntime } from "@deepseek-ai/dsh-subagent";
import type { AppServerLiveEvent } from "./app-server.js";

const PROVIDER_NAME = "codex-workflow";
type TextPart = { kind: AppServerLiveEvent["kind"]; itemId: string; text: string };

export interface CodexChildSessionHandle {
  readonly id: string;
  readonly session: Agent["session"];
  /** Close the current failed model turn and append a continuation turn to the
   * same native DSH child conversation. */
  beginContinuation(prompt: string): void;
  /** Close a failed turn while keeping the child session resumable. */
  failAttempt(message: string): void;
  /** Complete a clarification turn while keeping the child available for the answer. */
  pauseForInput?(message: string): void;
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
    return { id: child.id, session: child.session, beginContinuation: (prompt) => child.beginContinuation(prompt), failAttempt: (message) => child.failAttempt(message), pauseForInput: (message) => child.pauseForInput(message), progress: (entry) => child.progress(entry),
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
    const childDepth = Number(parent.session.header.delegationDepth ?? 0) + 1;
    // Use the same metadata as DSH's standard subagent path, including the
    // active preset from the parent context. Lightweight test parents fall
    // back to the persisted header or the host's standard preset.
    const inheritedMeta = parent.ctx
      ? childSessionMeta(parent, childDepth, false)
      : { cwd: parent.session.header.cwd, parentSession: parent.id, origin: "subagent" as const, delegationDepth: childDepth };
    const handle = await this.agents.create({ sessionId: id, parentAgent: parent, signal: request.signal,
      meta: { ...inheritedMeta, agentPreset: inheritedMeta.agentPreset ?? parent.session.header.agentPreset ?? "standard" } });
    if (request.signal.aborted) {
      await handle.dispose();
      request.signal.throwIfAborted();
    }
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
  private attempt = 0;
  private segment = 0;
  private streamOpen = false;
  private step = 0;
  private stepOpen = false;
  private stepSettled = false;
  private textParts: TextPart[] = [];
  private bufferedParts: TextPart[] = [];
  private attemptId = "";
  private stream: AssistantStreamRecord[] = [];
  private readonly toolCalls = new Map<string, ToolCallId>();
  private readonly advertisedTools = new Set<string>();

  constructor(private readonly handle: AgentHandle,
    private readonly descriptor: ResolvedSubagentStartRequest["descriptor"],
    private readonly settle: (result: SubagentResult) => void) {
    this.id = handle.agent.id;
    this.session = handle.agent.session;
    this.attemptId = `${this.id}:codex:1`;
  }

  start(prompt: string): void {
    if (this.started) return;
    this.openTurn(prompt);
  }

  beginContinuation(prompt: string): void {
    if (this.closed || this.finished) return;
    if (this.started) this.closeTurn("Codex run failed; continuing in the same session.", "failed", false);
    this.openTurn(prompt);
  }

  failAttempt(message: string): void {
    if (this.closed || this.finished) return;
    this.closeTurn(message, "failed", false);
  }

  pauseForInput(message: string): void {
    this.closeTurn(message, "completed", false);
  }

  private openTurn(prompt: string): void {
    this.attempt += 1;
    this.segment = 0;
    this.streamOpen = false;
    this.step = 0;
    this.stepOpen = false;
    this.stepSettled = false;
    this.textParts = [];
    this.bufferedParts = [];
    this.toolCalls.clear();
    this.advertisedTools.clear();
    this.session.append("turn/start", { turn: this.attempt });
    if (this.attempt === 1) {
      (this.session.append as unknown as (type: string, data: unknown) => unknown)("subagent/descriptor", this.descriptor);
    }
    this.session.append("user/message", createUserMessage({ content: [{ type: "text", text: prompt }],
      source: { kind: "user" } }), { surfaceOp: "append" });
    this.started = true;
    this.openStream();
  }

  private openStream(): boolean {
    if (this.streamOpen) return true;
    if (this.stepSettled && this.toolCalls.size > 0) return false;
    if (!this.stepOpen) {
      this.step += 1;
      this.session.append("step/start", { turn: this.attempt, step: this.step });
      this.stepOpen = true;
      this.stepSettled = false;
    }
    this.segment += 1;
    this.attemptId = `${this.id}:codex:${this.attempt}:${this.segment}`;
    this.stream = [];
    this.text = "";
    this.textParts = this.bufferedParts;
    this.bufferedParts = [];
    this.chunkIndex = 0;
    this.streamOpen = true;
    this.emitFrame({ type: "start", attemptId: this.attemptId, revision: ++this.revision, turn: this.attempt, step: this.step });
    if (this.textParts.length > 0) {
      this.text = this.textParts.map(part => part.text).join("");
      this.pushChunk({ type: "block-start", index: 0, blockType: "text" });
      this.pushChunk({ type: "text-delta", index: 0, text: this.text });
    }
    return true;
  }

  private closeStep(): void {
    if (!this.stepOpen) return;
    this.session.append("step/end", { turn: this.attempt, step: this.step });
    this.stepOpen = false;
    this.stepSettled = false;
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
    if (this.closed || this.finished || !this.started) return;
    if (entry.kind === "tool") {
      let callId = this.toolCalls.get(entry.itemId);
      if (!callId) {
        if (this.advertisedTools.has(entry.itemId)) return;
        // Keep full external item ids as correlation keys. Native call ids are
        // unique, so long ids or repeated ids across turns cannot alias cards.
        callId = ToolCallId(randomUUID());
        const name = entry.command ? "commandExecution" : "codex-tool";
        const args = JSON.stringify({ ...(entry.command ? { command: entry.command } : {}), ...(entry.cwd ? { cwd: entry.cwd } : {}) });
        this.advertiseTool(callId, name, args);
        this.session.append("tool/call", { turn: this.attempt, step: this.step, callId,
          name, arguments: args });
        this.toolCalls.set(entry.itemId, callId);
        this.advertisedTools.add(entry.itemId);
      }
      const terminal = entry.exitCode !== undefined || entry.status === "completed" || entry.status === "failed";
      if (terminal) {
        this.session.append("tool/result", { turn: this.attempt, step: this.step,
          message: createToolResultMessage({ callId, isError: entry.status === "failed" || (entry.exitCode !== undefined && entry.exitCode !== 0), content: [{ type: "text", text: entry.text }] }) }, { surfaceOp: "append" });
        this.toolCalls.delete(entry.itemId);
        if (this.toolCalls.size === 0 && this.stepSettled) this.closeStep();
      }
      return;
    }
    const rendered = entry.kind === "reasoning" && entry.text ? `\n\n[${entry.kind}] ${entry.text}` : entry.text;
    if (!this.openStream()) { this.bufferedParts = this.updateTextParts(this.bufferedParts, entry, rendered); return; }
    const original = this.text;
    const parts = this.updateTextParts(this.textParts, entry, rendered);
    const replacement = parts.map(part => part.text).join("");
    if (entry.replace) {
      if (replacement === original) { this.textParts = parts; return; }
      // Native deltas are append-only. Retire this uncommitted display attempt
      // before opening its corrected snapshot on the same Turn and Step.
      this.emitFrame({ type: "end", attemptId: this.attemptId, revision: ++this.revision,
        index: this.chunkIndex, outcome: { kind: "abandoned" } });
      this.streamOpen = false;
      this.bufferedParts = parts;
      this.openStream();
      return;
    }
    this.textParts = parts;
    if (this.stream.length === 0) this.pushChunk({ type: "block-start", index: 0, blockType: "text" });
    this.text += rendered;
    this.pushChunk({ type: "text-delta", index: 0, text: rendered });
  }

  private updateTextParts(parts: TextPart[], entry: AppServerLiveEvent, text: string): TextPart[] {
    const part = { kind: entry.kind, itemId: entry.itemId, text };
    if (!entry.replace) {
      const last = parts.at(-1);
      if (last?.kind === entry.kind && last.itemId === entry.itemId) last.text += text;
      else parts.push(part);
      return parts;
    }
    const first = parts.findIndex(value => value.kind === entry.kind && value.itemId === entry.itemId);
    if (first < 0) return [...parts, part];
    return parts.flatMap((value, index) => value.kind !== entry.kind || value.itemId !== entry.itemId
      ? [value] : index === first ? [part] : []);
  }

  private advertiseTool(callId: ToolCallId, name: string, args: string): void {
    const block = { type: "tool-call" as const, id: callId, name, arguments: args };
    if (!this.openStream()) {
      // Parallel tool items share the still-open native step. Publish the real
      // additional call durably without starting a second overlapping stream.
      const stream: AssistantStreamRecord[] = [
        { type: "chunk", time: Date.now(), chunk: { type: "block-start", index: 0, blockType: "tool-call" } },
        { type: "chunk", time: Date.now(), chunk: { type: "tool-call-delta", index: 0, id: callId, name, argumentsDelta: args } },
        { type: "chunk", time: Date.now(), chunk: { type: "block-end", index: 0, block } },
        { type: "chunk", time: Date.now(), chunk: { type: "finish", reason: { kind: "tool-calls" } } },
      ];
      this.session.append("assistant/message", { turn: this.attempt, step: this.step, stream,
        message: createAssistantMessage({ content: [block], source: { provider: "codex", model: "codex-app-server" } }) }, { surfaceOp: "append" });
      return;
    }
    const content: ContentBlock[] = [];
    if (this.stream.length > 0) {
      this.pushChunk({ type: "block-end", index: 0, block: { type: "text", text: this.text } });
      content.push({ type: "text", text: this.text });
    }
    const index = content.length;
    this.pushChunk({ type: "block-start", index, blockType: "tool-call" });
    this.pushChunk({ type: "tool-call-delta", index, id: callId, name, argumentsDelta: args });
    this.pushChunk({ type: "block-end", index, block });
    this.pushChunk({ type: "finish", reason: { kind: "tool-calls" } });
    content.push(block);
    // A real Codex tool item is advertised as a native assistant tool-call
    // before its invocation; the stored V4 relationship reader requires this.
    this.commitStream(content);
  }

  private commitStream(content: Parameters<typeof createAssistantMessage>[0]["content"]): void {
    const settled = this.session.append("assistant/message", { turn: this.attempt, step: this.step, stream: this.stream,
      message: createAssistantMessage({ content, source: { provider: "codex", model: "codex-app-server" } }) }, { surfaceOp: "append" });
    this.emitFrame({ type: "end", attemptId: this.attemptId, revision: ++this.revision,
      index: this.chunkIndex, outcome: { kind: "committed", eventType: "assistant/message", seq: settled.seq } });
    this.streamOpen = false;
    this.stepSettled = true;
  }

  finish(text: string, reason: "completed" | "failed" | "aborted" = "completed"): void {
    if (this.closed || this.finished) return;
    if (!this.started) {
      if (text) this.text = text;
      this.finished = true;
      this.settle({ output: this.text ? [{ type: "text", text: this.text }] : [],
        stopReason: reason === "failed" ? "error" : reason });
      return;
    }
    this.closeTurn(text, reason, true);
  }

  private closeTurn(text: string, reason: "completed" | "failed" | "aborted", settle: boolean): void {
    if (this.closed || this.finished || !this.started) return;
    // Balance pending tool calls before closing a failed/cancelled turn. A
    // missing result makes the native DSH conversation corrupt on replay.
    for (const callId of this.toolCalls.values()) {
      this.session.append("tool/result", { turn: this.attempt, step: this.step,
        message: createToolResultMessage({ callId: ToolCallId(callId), isError: true,
          content: [{ type: "text", text: "Codex tool was interrupted before returning a result." }] }) }, { surfaceOp: "append" });
    }
    this.toolCalls.clear();
    if (this.stepSettled) this.closeStep();
    this.openStream();
    if (text && text !== this.text) {
      // A failed/cancelled turn has no authoritative replacement response.
      // Retain text already shown in this segment (including buffered text
      // behind native tools), then append its diagnostic before continuation.
      this.text = reason !== "completed" && this.text.trim()
        ? `${this.text}\n\n${text}` : text;
    }
    if (this.stream.length === 0) this.pushChunk({ type: "block-start", index: 0, blockType: "text" });
    this.pushChunk({ type: "block-end", index: 0, block: { type: "text", text: this.text } });
    this.pushChunk({ type: "finish", reason: { kind: "stop" } });
    this.commitStream([{ type: "text", text: this.text }]);
    this.closeStep();
    this.session.append("turn/end", { turn: this.attempt, reason: reason === "completed" ? { kind: "completed" }
      : reason === "aborted" ? { kind: "aborted", reason: { kind: "user" } }
        : { kind: "error", error: { message: "Codex run failed", code: "UNKNOWN" } } });
    this.started = false;
    if (settle) {
      this.finished = true;
      this.settle({ output: this.text ? [{ type: "text", text: this.text }] : [],
        stopReason: reason === "failed" ? "error" : reason });
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    if (!this.finished) {
      if (this.started) this.finish("", "aborted");
      else {
        this.finished = true;
        this.settle({ output: this.text ? [{ type: "text", text: this.text }] : [], stopReason: "aborted" });
      }
    }
    this.closed = true;
    await this.handle.dispose();
  }
}

export function codexSubagentChatAddress(parentSessionId: string, childSessionId: string): string {
  const query = new URLSearchParams({ parent: parentSessionId, mode: "one-shot" });
  return `dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?${query}`;
}
