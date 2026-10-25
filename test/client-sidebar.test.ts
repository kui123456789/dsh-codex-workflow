import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("planner projection opens Codex Review in the mounted DSH session", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  const calls: Array<{ sessionId: string; kind: string }> = [];
  let notifyMounted: (() => void) | undefined;
  let notifyProjection: (() => void) | undefined;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: (listener: () => void) => { notifyProjection = listener; return () => undefined; } };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => "session-1", subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openTab: (kind: string) => calls.push({ sessionId: "session-1", kind }),
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  };
  plugin.apply(ctx);
  assert.deepEqual(calls, [{ sessionId: "session-1", kind: "codex-review" }]);
  notifyProjection?.();
  notifyMounted?.();
  assert.equal(calls.length, 1, "ordinary projection updates do not reopen the tab");
});

test("planner child projection opens the native DSH subagent chat resource", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  const resources: Array<{ address: string; options: { kind?: string } }> = [];
  let notifyMounted: (() => void) | undefined;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", childSessionId: "child-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => "parent-1", subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openResource: (address: string, options: { kind?: string }) => resources.push({ address, options }),
      openTabIn: () => { throw new Error("custom review tab should not be used when a child exists"); },
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  };
  plugin!.apply(ctx);
  notifyMounted?.();
  assert.equal(resources.length, 1);
  assert.match(resources[0]!.address, /^dsh-resource:\/\/subagentchat\/session\/child-1/);
  assert.match(resources[0]!.address, /parent=parent-1/);
  assert.equal(resources[0]!.options.kind, "subagentchat");
});

test("native open failure retries on the next projection notification without fallback", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  let attempts = 0;
  let notifyProjection: (() => void) | undefined;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", childSessionId: "child-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: (listener: () => void) => { notifyProjection = listener; return () => undefined; } };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => "parent-1", subscribe: () => () => undefined },
      openResource: () => { attempts += 1; if (attempts === 1) throw new Error("seat not mounted"); },
      openTab: () => { throw new Error("native failure must not fall back"); },
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  assert.equal(attempts, 1);
  notifyProjection?.();
  assert.equal(attempts, 2, "the next projection notification retries the native resource");
  dispose?.();
});

test("late session binding is discovered and subscribed without stacking listeners", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  let bound = false;
  let subscriptions = 0;
  let openCount = 0;
  let notifyMounted: (() => void) | undefined;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", childSessionId: "child-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: () => { subscriptions += 1; return () => undefined; } };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => "parent-1", subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openResource: () => { openCount += 1; }, openTab: () => { throw new Error("fallback must not be used"); },
    },
    sessions: { binding: () => bound ? ({ session: { projections: { faceOf: () => face } } }) : undefined },
  };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  bound = true;
  notifyMounted?.();
  notifyMounted?.();
  assert.equal(openCount, 1);
  assert.equal(subscriptions, 1, "the same projection face is subscribed only once");
  dispose?.();
});

test("fallback open is retried after the mounted seat is replaced", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  runInNewContext(source, { setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  assert.ok(plugin);
  let mounted: string | undefined = "session-1";
  let notifyMounted: (() => void) | undefined;
  let calls = 0;
  const projection = { currentWorkflowId: "workflow-1", plan: { workflowId: "workflow-1", status: "planning", questions: [], assumptions: [] }, activeReview: null, reviews: [] };
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const ctx = {
    sidebarRightTabs: { register: () => () => undefined }, slots: { inject: () => () => undefined },
    sidebarRight: {
      mounted: { getSnapshot: () => mounted, subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openTab: () => { calls += 1; if (calls === 1) throw new Error("seat replaced"); },
    },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) },
  };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  assert.equal(calls, 1);
  mounted = undefined;
  notifyMounted?.();
  mounted = "session-1";
  notifyMounted?.();
  assert.equal(calls, 2, "fallback key remains retryable after a failed/unmounted open");
  dispose?.();
});

test("sidebar body renders Planner and Reviewer activity while they are running", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
    if (typeof type === "function") return type({ ...props, children });
    return { type, props, children };
  };
  runInNewContext(source, { setTimeout, clearTimeout, window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
    plugin = entry.factory(() => ({ createElement: h, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined,
      useState: (initial: unknown) => [initial, () => undefined], useMemo: (factory: () => unknown) => factory() }));
  } } } });
  assert.ok(plugin);
  let body: ((props: unknown) => unknown) | undefined;
  const projection = { currentWorkflowId: "wf", plan: { workflowId: "wf", status: "planning", questions: [], assumptions: [],
    live: [{ kind: "plan", itemId: "p1", text: "正在生成计划" }] },
    activeReview: { workflowId: "wf", reviewId: "wf:1", attempt: 1, processState: "running", message: "审查中",
      live: [{ kind: "message", itemId: "r1", text: "正在检查改动" }] },
    reviews: [{ workflowId: "wf", reviewId: "wf:1", attempt: 1, processState: "running",
      live: [{ kind: "message", itemId: "r1", text: "正在检查改动" }] }] };
  const face = { getSnapshot: () => projection, subscribe: () => () => undefined };
  const ctx = { sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (_definition: unknown, component: (props: unknown) => unknown) => { body ??= component; return () => undefined; } },
    sidebarRight: { mounted: { getSnapshot: () => "session-1", subscribe: () => () => undefined }, openTab: () => undefined },
    sessions: { binding: () => ({ session: { projections: { faceOf: () => face } } }) } };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  assert.ok(body);
  const rendered = JSON.stringify(body({ projectionFace: face, useTabInfo: () => ({}) }));
  assert.match(rendered, /正在生成计划/);
  assert.match(rendered, /正在检查改动/);
  dispose?.();
});

test("settings tab exposes model and reasoning-effort selectors", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  let settingsBody: ((props: unknown) => unknown) | undefined;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
    if (typeof type === "function") return type({ ...props, children });
    return { type, props, children };
  };
  runInNewContext(source, { setTimeout, clearTimeout, window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
    plugin = entry.factory(() => ({ createElement: h,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useMemo: (factory: () => unknown) => factory(), useState: (initial: unknown) => [initial, () => undefined],
      useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined }));
  } } } });
  assert.ok(plugin);
  const form = {
    getSnapshot: () => ({ status: "ready", value: { plannerModel: "gpt-6-sol", plannerEffort: "medium", reviewerModel: "", reviewerEffort: "high" }, writable: true }),
    subscribe: () => () => undefined,
    set: async () => true,
  };
  const ctx = {
    configForms: { get: () => form },
    sidebarRightTabs: { register: () => () => undefined },
    slots: {
      inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string }, component: (props: unknown) => unknown) => {
        if (definition.name === "settings.plugins.tab") settingsBody = component;
        return () => undefined;
      },
    },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => undefined } },
    sessions: { binding: () => undefined },
  };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  assert.ok(settingsBody);
  const rendered = JSON.stringify(settingsBody({ configForm: form }));
  assert.match(rendered, /gpt-6-sol/);
  assert.match(rendered, /Planner 推理程度/);
  assert.match(rendered, /medium/);
  dispose?.();
});

test("settings tab renders an explicit state when the Host form is not ready", () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  let settingsBody: ((props: unknown) => unknown) | undefined;
  let settingsProps: unknown;
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
    if (typeof type === "function") return type({ ...props, children });
    return { type, props, children };
  };
  runInNewContext(source, { setTimeout, clearTimeout, window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
    plugin = entry.factory(() => ({ createElement: h,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useMemo: (factory: () => unknown) => factory(), useState: (initial: unknown) => [initial, () => undefined],
      useRef: (initial: unknown) => ({ current: initial }), useEffect: () => undefined }));
  } } } });
  assert.ok(plugin);
  const ctx = {
    configForms: { get: () => { throw new Error("settings form is still loading"); } },
    sidebarRightTabs: { register: () => () => undefined },
    slots: {
      inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string; inject?: () => unknown }, component: (props: unknown) => unknown) => {
        if (definition.name === "settings.plugins.tab") {
          settingsBody = component;
          settingsProps = definition.inject?.();
        }
        return () => undefined;
      },
    },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => undefined } },
    sessions: { binding: () => undefined },
  };
  const dispose = plugin.apply(ctx) as unknown as (() => void) | undefined;
  assert.ok(settingsBody);
  const rendered = JSON.stringify(settingsBody(settingsProps));
  assert.match(rendered, /当前宿主没有开放可写的插件设置/);
  assert.match(rendered, /Planner 模型/);
  dispose?.();
});

test("settings tab binds ConfigForm subscription and reads models over Connection RPC", async () => {
  let plugin: { apply(ctx: unknown): void } | undefined;
  let settingsBody: ((props: unknown) => unknown) | undefined;
  const calls: Array<[string, string]> = [];
  const source = readFileSync(join(process.cwd(), "src/client.js"), "utf8");
  const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => ({ type, props, children });
  runInNewContext(source, { setTimeout, clearTimeout, window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): { apply(ctx: unknown): void } }) => {
    plugin = entry.factory(() => ({ createElement: h,
      useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => unknown) => { subscribe(() => undefined); return getSnapshot(); },
      useMemo: (factory: () => unknown) => factory(), useState: (initial: unknown) => [initial, () => undefined],
      useRef: (initial: unknown) => ({ current: initial }), useEffect: (effect: () => void) => effect() }));
  } } } });
  class HostForm {
    subscribed = false;
    getSnapshot() { return { status: "ready", value: {}, writable: true }; }
    subscribe(_listener: () => void) { this.subscribed = true; return () => undefined; }
  }
  const form = new HostForm();
  const connection = { rpc: { call: async (channel: string, endpoint: string) => {
    calls.push([channel, endpoint]);
    return { ok: true, value: { models: [{ id: "dynamic-test-model", name: "Dynamic test model" }] } };
  } } };
  plugin!.apply({ configForms: { get: () => form }, connection,
    sidebarRightTabs: { register: () => () => undefined },
    slots: { inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string }, component: (props: unknown) => unknown) => {
        if (definition.name === "settings.plugins.tab") settingsBody = component;
        return () => undefined;
      } },
    sidebarRight: { mounted: { getSnapshot: () => undefined, subscribe: () => () => undefined } },
    sessions: { binding: () => undefined } });
  assert.ok(settingsBody);
  assert.doesNotThrow(() => settingsBody!({ configForm: form, connection }));
  assert.equal(form.subscribed, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [["/dsh-codex-workflow", "models"]]);
});

function rpcSidebar(legacy?: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }) {
  let plugin: { apply(ctx: unknown): () => void } | undefined;
  let mounted: string | undefined = "parent-1";
  let notifyMounted: (() => void) | undefined;
  let injectBody: ((id: string) => { projectionFace: { getSnapshot(): unknown } }) | undefined;
  let nextTimer = 0;
  const timers = new Map<number, { delay: number; run: () => void }>();
  const requests: Array<{ sessionId: string; signal: AbortSignal; resolve(value: unknown): void; reject(error: Error): void }> = [];
  const opened: string[] = [];
  runInNewContext(readFileSync(join(process.cwd(), "src/client.js"), "utf8"), {
    AbortController,
    setTimeout: (run: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { run, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    window: { __ModuleLoader__: { load: (entry: { factory(require: (name: string) => unknown): typeof plugin }) => {
      plugin = entry.factory(() => ({ createElement: () => null }));
    } } },
  });
  const dispose = plugin!.apply({
    connection: { rpc: { call: (channel: string, endpoint: string, payload: { args: { sessionId: string } }, signal: AbortSignal) => {
      assert.equal(channel, "/dsh-codex-workflow");
      assert.equal(endpoint, "workflow-state");
      return new Promise((resolve, reject) => requests.push({ sessionId: payload.args.sessionId, signal, resolve, reject }));
    } } },
    sidebarRightTabs: { register: () => () => undefined },
    slots: {
      inject: (_name: string, register: () => void) => { register(); return () => undefined; },
      register: (definition: { name?: string; inject?: typeof injectBody }) => {
        if (definition.name === "sidebar.right.pane.tab") injectBody = definition.inject;
        return () => undefined;
      },
    },
    sidebarRight: {
      mounted: { getSnapshot: () => mounted, subscribe: (listener: () => void) => { notifyMounted = listener; return () => undefined; } },
      openResource: (address: string) => opened.push(address),
      openTab: () => opened.push("fallback"),
    },
    sessions: { binding: () => legacy ? { session: { projections: { faceOf: () => legacy } } } : undefined },
  });
  return {
    requests, opened, timers, dispose,
    face: (id = "parent-1") => injectBody!(id).projectionFace,
    mount: (id: string | undefined) => { mounted = id; notifyMounted?.(); },
    poll: () => {
      const timer = [...timers].find(([, value]) => value.delay === 1_000);
      assert.ok(timer, "subscribed state schedules the next one-second read");
      timers.delete(timer[0]);
      timer[1].run();
    },
  };
}

const sidecarProjection = (childSessionId: string) => ({ currentWorkflowId: "wf", plan: {
  workflowId: "wf", childSessionId, status: "planning", questions: [], assumptions: [],
}, activeReview: null, reviews: [] });
const drainRpc = async () => { for (let step = 0; step < 6; step += 1) await Promise.resolve(); };

test("sidecar RPC restores the native sidebar without a live Session binding and retains state across read failures", async () => {
  const sidebar = rpcSidebar();
  try {
    assert.equal(sidebar.requests.length, 1);
    sidebar.requests[0]!.resolve({ ok: true, value: { externalState: true, projection: null } });
    await drainRpc();
    assert.equal(sidebar.opened.length, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(sidebar.face().getSnapshot())), {
      currentWorkflowId: null, plan: null, activeReview: null, reviews: [],
    });
    sidebar.poll();
    sidebar.requests[1]!.resolve({ ok: true, value: { externalState: true, projection: sidecarProjection("cold-child") } });
    await drainRpc();
    assert.equal(sidebar.opened.length, 1);
    assert.match(sidebar.opened[0]!, /session\/cold-child\?parent=parent-1/);
    const accepted = sidebar.face().getSnapshot();
    sidebar.poll();
    sidebar.requests[2]!.resolve({ ok: true, value: { externalState: true, projection: sidecarProjection("cold-child") } });
    await drainRpc();
    assert.equal(sidebar.face().getSnapshot(), accepted, "unchanged reads retain a stable React snapshot");
    assert.equal(sidebar.opened.length, 1, "the same durable child is not reopened by polling");
    sidebar.poll();
    sidebar.requests[3]!.reject(new Error("connection reset"));
    await drainRpc();
    assert.equal(sidebar.face().getSnapshot(), accepted, "transport errors retain the accepted state");
    sidebar.poll();
    const pending = sidebar.requests[4]!;
    sidebar.dispose();
    assert.equal(pending.signal.aborted, true);
    pending.resolve({ ok: true, value: { externalState: true, projection: sidecarProjection("too-late") } });
    await drainRpc();
    assert.equal(sidebar.opened.length, 1);
    assert.equal(sidebar.timers.size, 0, "unmounted clients leave no polling or retry timers");
  } finally { sidebar.dispose(); }
});

test("switching sessions cancels sidecar reads and prevents old responses from opening another session's child", async () => {
  const sidebar = rpcSidebar();
  try {
    const original = sidebar.requests[0]!;
    sidebar.mount("parent-2");
    assert.equal(original.signal.aborted, true);
    assert.equal(sidebar.requests[1]!.sessionId, "parent-2");
    original.resolve({ ok: true, value: { externalState: true, projection: sidecarProjection("old-child") } });
    sidebar.requests[1]!.resolve({ ok: true, value: { externalState: true, projection: sidecarProjection("current-child") } });
    await drainRpc();
    assert.equal(sidebar.opened.length, 1);
    assert.match(sidebar.opened[0]!, /current-child\?parent=parent-2/);
    sidebar.mount(undefined);
    assert.equal([...sidebar.timers.values()].filter(timer => timer.delay === 1_000).length, 0);
    sidebar.mount("parent-1");
    assert.equal(sidebar.requests[2]!.sessionId, "parent-1", "returning to a released session starts a fresh read");
    assert.equal(sidebar.opened.length, 1, "the cancelled old snapshot was not cached");
  } finally { sidebar.dispose(); }
});

test("legacy hosts keep their projection subscription when workflow-state uses the legacy source", async () => {
  let projection = sidecarProjection("legacy-child");
  let notify: (() => void) | undefined;
  let subscriptions = 0;
  const sidebar = rpcSidebar({ getSnapshot: () => projection, subscribe: (listener) => {
    subscriptions += 1;
    notify = listener;
    return () => { subscriptions -= 1; };
  } });
  try {
    sidebar.requests[0]!.resolve({ ok: true, value: { externalState: false, projection: null } });
    await drainRpc();
    assert.equal(sidebar.face().getSnapshot(), projection);
    assert.equal(subscriptions, 1);
    projection = sidecarProjection("next-legacy-child");
    notify?.();
    assert.equal(sidebar.opened.length, 2);
    assert.match(sidebar.opened[1]!, /next-legacy-child/);
  } finally { sidebar.dispose(); }
  assert.equal(subscriptions, 0);
});
