import { createHash } from "node:crypto";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionQueryError } from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { cwdKey } from "./coordination.js";

/** Stable per source/cwd/preset, so retries and Desktop restarts reuse only our worker. */
export function dedicatedSessionId(thread: string, cwd: string, preset: string): string {
  const h = createHash("sha256").update(JSON.stringify([thread, cwdKey(cwd), preset])).digest("hex");
  return `session-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function ensureDesktopSession(ctx: Context, id: string, cwd: string, preset: string, owned: Map<string, AgentHandle>): Promise<Agent> {
  if (!ctx.agentPresets || !ctx.agentDefaultModel || !ctx.sessionQuery) {
    throw new Error("Desktop session bootstrap requires public agentPresets, agentDefaultModel and sessionQuery services");
  }
  const resolved = await ctx.agentPresets.resolve(preset);
  if (resolved.id !== preset) throw new Error(`requested preset ${preset} was not resolved exactly`);
  const check = (header: { cwd?: string; agentPreset?: string }) => {
    if (!header.cwd || cwdKey(header.cwd) !== cwdKey(cwd) || header.agentPreset !== preset) {
      throw new Error("dedicated session cwd/preset mismatch; refusing adoption");
    }
  };
  const live = ctx.agents.get(SessionId(id));
  if (live) {
    check(live.session.header);
    if (ctx.agentPresets.composedPreset(live.ctx) !== preset) throw new Error("live dedicated session preset changed");
    return live;
  }
  let exists = true;
  try {
    const snapshot = await ctx.sessionQuery.readSession(SessionId(id));
    check(snapshot.session);
    const selected = snapshot.events.filter((event) => event.type === "agent-preset/selected").at(-1);
    if (selected?.type === "agent-preset/selected" && selected.data.agentPreset !== preset) throw new Error("persisted dedicated session preset changed");
  }
  catch (error) {
    if (error instanceof SessionQueryError && error.code === "SESSION_QUERY_SESSION_NOT_FOUND") exists = false;
    else throw error;
  }
  const options = {
    agentOptions: ctx.agentDefaultModel.currentSelection(),
    setup: async (agentCtx: Context) => { await ctx.agentPresets.mount(agentCtx, preset); },
  };
  const handle = exists
    ? await ctx.agents.resume({ resumeSessionId: SessionId(id), ...options })
    : await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd, agentPreset: preset }, ...options });
  try { check(handle.agent.session.header); } catch (error) { await handle.dispose(); throw error; }
  owned.set(id, handle);
  return handle.agent;
}

/** Return only assistant text after the workflow's exact relay, never unrelated history. */
export function workerOutput(events: readonly SessionEvent[], relayId: string, workflowId: string, ownedRelays: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const start = events.findIndex((event) => event.type === "user/message" && event.data.id === relayId);
  if (start < 0) return { messages: [], lastTurnEnd: null, completed: false, cursor: null };
  const tail = events.slice(start + 1);
  // Public ContextFormed marks generated context; role=user alone is not user input.
  // Unknown/unmarked sources remain boundaries so future producers cannot leak history.
  const isInput = (event: SessionEvent) => {
    if (event.type !== "user/message") return false;
    const source = event.data.source as { kind?: string; form?: string } | undefined;
    if (source?.kind === "user") return true;
    return !source?.form || !["instructions", "catalog", "snapshot", "notice", "recall"].includes(source.form);
  };
  const next = tail.findIndex((event) => isInput(event) && event.type === "user/message"
    && !event.data.id.startsWith(`dsh-codex-workflow:followup:${workflowId}:`) && !ownedRelays.has(event.data.id));
  const window = next < 0 ? tail : tail.slice(0, next);
  const messages = window.flatMap((event) => {
    if (event.type !== "assistant/message") return [];
    const text = event.data.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (!text) return [];
    return [{ seq: event.seq, turn: event.data.turn, interrupted: event.data.interrupted === true, text: text.slice(0, 16384), truncated: text.length > 16384 }];
  }).slice(-20);
  const end = window.filter((event) => event.type === "turn/end").at(-1);
  const last = messages.at(-1);
  const lastInput = window.filter(isInput).at(-1);
  const completed = (!lastInput || (end && end.seq > lastInput.seq)) && end?.type === "turn/end" && end.data.reason.kind === "completed"
    && last?.turn === end.data.turn && !last.interrupted;
  return { messages, lastTurnEnd: end?.data ?? null, completed: !!completed, cursor: window.at(-1)?.seq ?? events[start]!.seq };
}
