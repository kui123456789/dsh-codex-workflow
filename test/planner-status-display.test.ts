import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { applyCodexWorkflowProjection, codexWorkflowProjectionDefinition } from "../src/review-events.js";

type PlanEvent = { workflowId?: string; status: "planning" | "waiting_input" | "ready" | "failed";
  processState?: "running" | "waiting" | "completed" | "failed"; message?: string };
function project(events: PlanEvent[]) {
  let state = codexWorkflowProjectionDefinition.init();
  events.forEach((event, seq) => {
    state = applyCodexWorkflowProjection(state, { type: "dsh-codex-workflow/plan-updated", seq, time: seq,
      data: { workflowId: "wf", childSessionId: "original-child", questions: [], assumptions: [], ...event } } as never);
  });
  assert.equal(state.failure, null);
  return codexWorkflowProjectionDefinition.wire.viewSchema.parse(codexWorkflowProjectionDefinition.wire.view(state));
}
type Tree = { type: unknown; props?: Record<string, unknown>; children: unknown[] };
function words(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(words).join("");
  return value && typeof value === "object" && "children" in value ? words((value as Tree).children) : "";
}
function status(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(status).find(Boolean);
  if (!value || typeof value !== "object" || !("children" in value)) return;
  const tree = value as Tree;
  return tree.props?.role === "status" ? words(tree) : status(tree.children);
}
function heading(events: PlanEvent[]) {
  const projection = project(events);
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  let body: ((props: unknown) => unknown) | undefined;
  const h = (type: unknown, props: unknown, ...children: unknown[]): unknown =>
    typeof type === "function" ? type({ ...(props as object), children }) : { type, props, children };
  runInNewContext(readFileSync(join(process.cwd(), "src/client.js"), "utf8"), { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(entry: { factory(require: (name: string) => unknown): typeof plugin }) {
      plugin = entry.factory(() => ({ createElement: h, useSyncExternalStore: (_s: unknown, read: () => unknown) => read(),
        useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined,
        useState: (initial: unknown) => [initial, () => undefined] }));
    } } },
  });
  assert.ok(plugin);
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const dispose = plugin.apply({ sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_n: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string }, component: (props: unknown) => unknown) => {
        if (definition.name === "sidebar.right.pane.tab") body = component;
        return () => undefined;
      } },
    sidebarRight: { mounted: { getSnapshot: () => "parent", subscribe: () => () => undefined }, openResource: () => undefined },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) } });
  try { assert.ok(body); return status(body({ projectionFace: face, useTabInfo: () => ({}) })); }
  finally { dispose(); }
}

test("explicit Planner pause survives projection and wire validation", () => {
  const projection = project([{ status: "planning", processState: "waiting" }]);
  assert.equal((projection.plan as unknown as { processState?: string }).processState, "waiting");
  assert.equal(heading([{ status: "planning", processState: "waiting" }]), "规划已暂停");
});

test("resumed original Planner replaces pause with explicit running", () => {
  const events: PlanEvent[] = [{ status: "planning", processState: "waiting" }, { status: "planning", processState: "running" }];
  assert.equal((project(events).plan as unknown as { processState?: string }).processState, "running");
  assert.equal(heading(events), "Codex 正在规划");
});

test("completed Planner clears the prior waiting marker", () => {
  const events: PlanEvent[] = [{ status: "planning", processState: "waiting" }, { status: "ready", processState: "completed" }];
  assert.equal((project(events).plan as unknown as { processState?: string }).processState, "completed");
  assert.equal(heading(events), "规划已完成");
});

test("old planning events remain compatible and do not invent a pause", () => {
  assert.equal((project([{ status: "planning" }]).plan as unknown as { processState?: string }).processState, undefined);
  assert.equal(heading([{ status: "planning" }]), "Codex 正在规划");
});

test("a later legacy event cannot silently retain an earlier pause", () => {
  const events: PlanEvent[] = [{ status: "planning", processState: "waiting" }, { status: "planning" }];
  assert.equal((project(events).plan as unknown as { processState?: string }).processState, undefined);
  assert.equal(heading(events), "Codex 正在规划");
});

test("a new workflow does not inherit the prior Planner waiting marker", () => {
  const events: PlanEvent[] = [{ status: "planning", processState: "waiting" }, { workflowId: "next", status: "planning" }];
  assert.equal(project(events).currentWorkflowId, "next");
  assert.equal((project(events).plan as unknown as { processState?: string }).processState, undefined);
});

test("terminal failure pending cleanup remains a failure heading", () => {
  assert.equal(heading([{ status: "failed", processState: "waiting", message: "Schema failure; original cleanup pending" }]), "规划失败");
});

test("clarification waiting remains a question rather than a generic paused run", () => {
  assert.equal(heading([{ status: "waiting_input", processState: "waiting" }]), "规划等待用户回答");
});

test("the host invalidates a v1 checkpoint and replays the original log with Planner process state", async () => {
  const ctx = new Context();
  await ctx.plugin(SessionProjectionRegistry);
  try {
    ctx.sessionProjections.register(codexWorkflowProjectionDefinition);
    const events = [{ type: "dsh-codex-workflow/plan-updated", seq: SessionSeq(0), time: 0,
      data: { workflowId: "wf", status: "planning", processState: "waiting", questions: [], assumptions: [] } }] as SessionEvent[];
    const old = { ...codexWorkflowProjectionDefinition.init(), currentWorkflowId: "wf",
      plan: { workflowId: "wf", status: "planning" as const, questions: [], assumptions: [] } };
    const checkpoint = { codexWorkflow: { ver: 1, seq: SessionSeq(0), val: old } };
    const header: SessionHeader = { id: SessionId("planner-checkpoint-parent"), version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false };
    assert.equal(ctx.sessionProjections.restoreFloor(checkpoint), 0, "changed fold must replay the original prefix");
    assert.throws(() => ctx.sessionProjections.restore(checkpoint, [], SessionLogOffset(1), header, SessionLogOffset(0)),
      /re-read from seq 0/);
    const replayed = ctx.sessionProjections.restore(checkpoint, events, SessionLogOffset(0), header, SessionLogOffset(0));
    assert.equal(replayed.snapshot.values.codexWorkflow?.plan?.processState, "waiting");
    assert.equal(replayed.checkpoint.codexWorkflow?.ver, 2);
    const legacyEvents = [{ ...events[0]!, data: { workflowId: "wf", status: "planning", questions: [], assumptions: [] } }] as SessionEvent[];
    const legacy = ctx.sessionProjections.restore(checkpoint, legacyEvents, SessionLogOffset(0), header, SessionLogOffset(0));
    assert.equal(legacy.snapshot.values.codexWorkflow?.plan?.processState, undefined, "legacy logs never invent a paused run");
  } finally { await ctx.fiber.dispose(); }
});
