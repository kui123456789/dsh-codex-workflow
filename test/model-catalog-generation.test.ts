import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAppServerClient, type CodexAppServerOptions } from "../src/app-server.js";
import type { ReasoningEffort } from "../src/types.js";

const protocol = fileURLToPath(new URL("./fixtures/fake-model-catalog-app-server.mjs", import.meta.url));
type Wire = { kind: string; processId: number; method?: string; params?: Record<string, any> };
type Stats = { processId: number; initializations: number; initializedReady: boolean; heldInitializations: number;
  rpcCalls: Array<{ method: string; params: Record<string, any> }>; turnStartRequests: unknown[] };
const childExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Catalog fixture did not reach ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-model-catalog-generation-"));
  const wireLog = join(directory, "wire.jsonl");
  const args = (model: string, effort = "low", planModel = "explicit", initializeMode = "valid") =>
    [protocol, "--catalog-model", model, "--catalog-effort", effort, "--plan-model", planModel,
      "--initialize-mode", initializeMode, "--process-log", wireLog];
  const options: CodexAppServerOptions = { command: process.execPath, args: args("catalog-A"),
    requestTimeoutMs: 15_000, rpcTimeoutMs: 15_000, idleProcessMs: 0 };
  const client = new CodexAppServerClient(options);
  const children: ChildProcess[] = [];
  const nativeSpawn = childProcess.spawn;
  const ownedSpawn = ((...values: unknown[]) => {
    const child = Reflect.apply(nativeSpawn, childProcess, values) as ChildProcess;
    const commandArgs = values[1];
    if (Array.isArray(commandArgs) && commandArgs.includes(protocol) && commandArgs.includes(wireLog)) children.push(child);
    return child;
  }) as typeof nativeSpawn;
  childProcess.spawn = ownedSpawn;
  syncBuiltinESMExports();
  const exited = (pid: number): boolean => {
    const matches = children.filter(child => child.pid === pid);
    assert.equal(matches.length, 1, "An original diagnostic process requires its unambiguous captured ChildProcess");
    return childExited(matches[0]!);
  };
  const control = (client as unknown as { request<T>(method: string, params: object): Promise<T> }).request.bind(client);
  const stats = () => control<Stats>("fixture/stats", {});
  const rawControl = <T>(method: string) => {
    const port = client as unknown as { child?: object; requestRaw<R>(method: string, params: object,
      signal?: AbortSignal, expectedProcess?: object): Promise<R> };
    return port.requestRaw<T>(method, {}, undefined, port.child);
  };
  const wire = async () => (await readFile(wireLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Wire);
  return { directory, client, stats, wire, control, rawControl, exited,
    configure(model: string, effort = "low", planModel = "explicit", initializeMode = "valid", exitDelay = 0) {
      options.args = [...args(model, effort, planModel, initializeMode), "--eof-delay-ms", String(exitDelay)];
    },
    async exit() {
      const before = await stats();
      const child = (client as unknown as { child: { exitCode: number | null; signalCode: string | null } }).child;
      await control("fixture/exit", {});
      await waitFor(() => exited(before.processId), "the actual original ChildProcess exit");
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, "SDK child exit notification");
      return before;
    },
    async close() {
      try {
        await client.stop();
        const starts = (await wire().catch(() => [] as Wire[])).filter((entry) => entry.kind === "start");
        if (starts.length) {
          assert.equal(children.length, starts.length, "Each diagnostic launch retains its original native ChildProcess");
          assert.ok(starts.every(entry => children.some(child => child.pid === entry.processId)));
        }
        assert.ok(children.every(childExited), "Every diagnostic App Server really exited");
        assert.ok(resolve(directory).startsWith(`${resolve(tmpdir())}${sep}`));
        await rm(directory, { recursive: true, force: true });
      } finally {
        if (childProcess.spawn === ownedSpawn) { childProcess.spawn = nativeSpawn; syncBuiltinESMExports(); }
      }
    } };
}

for (const scenario of ["exit-plan-explicit", "idle-plan-explicit", "exit-plan-default"] as const) {
  test(`${scenario} refreshes defaults and conversion settings for independent new process work`, async () => {
    const f = await fixture();
    try {
      assert.equal(await f.client.resolveDefaultModel(), "catalog-A");
      assert.equal(await f.client.resolveDefaultModel(), "catalog-A");
      assert.equal((await f.client.listModels())[0]!.id, "catalog-A");
      const aThread = await f.client.startThread({ cwd: f.directory, ephemeral: true });
      const aOwner = f.client.captureThreadOwner(aThread);
      assert.ok(aOwner);
      await f.client.startTurn(aThread, { prompt: "A planning control", planMode: true });
      await f.client.startTurn(aThread, { prompt: "A conversion control", conversion: true });
      const original = await f.stats();
      assert.equal(original.rpcCalls.filter((entry) => entry.method === "model/list").length, 1,
        "Repeated same-process model selection keeps its cache");
      if (scenario.startsWith("idle")) {
        await f.client.releaseThreadForExternal(aThread, undefined, aOwner);
        assert.equal(f.exited(original.processId), true);
      } else await f.exit();
      f.configure("catalog-B", "high", scenario.endsWith("default") ? "none" : "explicit");
      const bThread = await f.client.startThread({ cwd: f.directory, ephemeral: true });
      const before = await f.stats();
      assert.notEqual(before.processId, original.processId);
      assert.equal(await f.client.resolveDefaultModel(), "catalog-B");
      assert.deepEqual(await f.client.listModels(), [{ id: "catalog-B", isDefault: true, defaultReasoningEffort: "high" }]);
      const models: string[] = [];
      await f.client.startTurn(bThread, { prompt: "B independent planning", planMode: true, onModel: (model) => models.push(model) });
      await f.client.startTurn(bThread, { prompt: "B independent conversion", conversion: true, onModel: (model) => models.push(model) });
      await f.client.startTurn(bThread, { prompt: "B independent silent review", silentReview: true, onModel: (model) => models.push(model) });
      assert.deepEqual(models, ["catalog-B", "catalog-B", "catalog-B"]);
      const selected = (await f.stats()).rpcCalls.filter((entry) => entry.method === "turn/start");
      assert.equal(selected.length, 3);
      assert.ok(selected.every((entry) => entry.params.collaborationMode.settings.model === "catalog-B"
        && entry.params.collaborationMode.settings.reasoning_effort === "high"));
      await f.client.startTurn(bThread, { prompt: "Explicit override control", conversion: true, model: "override-C", effort: "xhigh" });
      const after = await f.stats();
      const explicit = after.rpcCalls.filter((entry) => entry.method === "turn/start").at(-1)!.params;
      assert.equal(explicit.model, "override-C");
      assert.equal(explicit.collaborationMode.settings.model, "override-C");
      assert.equal(explicit.collaborationMode.settings.reasoning_effort, "xhigh");
      assert.equal(after.rpcCalls.filter((entry) => entry.method === "model/list").length, 1);
      await assert.rejects(f.client.startTurn(aThread, { expectedOwner: aOwner, prompt: "Do not resume original A in B", model: "catalog-A", planMode: true }), /original.*owner.*unavailable/);
      assert.deepEqual((await f.stats()).turnStartRequests, after.turnStartRequests,
        "Fresh model metadata never authorizes an admitted old run to switch processes");
    } finally { await f.close(); }
  });
}

for (const entry of ["default", "list"] as const) {
  test(`${entry} metadata starts the actual successor after exit before any health or thread operation`, async () => {
    const f = await fixture();
    try {
      await f.client.resolveDefaultModel();
      const old = await f.exit();
      f.configure("catalog-B", "high");
      if (entry === "default") assert.equal(await f.client.resolveDefaultModel(), "catalog-B");
      else assert.equal((await f.client.listModels())[0]!.id, "catalog-B");
      const current = await f.stats();
      assert.notEqual(current.processId, old.processId);
      assert.equal(current.initializations, 1);
      assert.equal(current.rpcCalls.filter((call) => call.method === "model/list").length, 1);
      assert.deepEqual(current.turnStartRequests, [], "Metadata bootstrap creates no model turn");
    } finally { await f.close(); }
  });

  test(`permanent stop rejects cached ${entry} metadata without spawning another process`, async () => {
    const f = await fixture();
    try {
      await f.client.resolveDefaultModel();
      await f.client.listModels();
      const original = await f.stats();
      await f.client.stop();
      assert.equal(f.exited(original.processId), true);
      await assert.rejects(entry === "default" ? f.client.resolveDefaultModel() : f.client.listModels(), /stopped/);
      assert.equal((await f.wire()).filter((call) => call.kind === "start").length, 1);
    } finally { await f.close(); }
  });
}

for (const initializeMode of ["error", "invalid"] as const) {
  test(`${initializeMode} initialization rejection cannot leave an accepted child or poison subsequent metadata`, async (t) => {
    const f = await fixture();
    f.configure("uninitialized-model", "low", "explicit", initializeMode);
    try {
      const failure = initializeMode === "error" ? /fixture initialization rejected/ : /invalid Codex initialize response/;
      await assert.rejects(f.client.start(), failure);
      const first = (await f.wire()).find((entry) => entry.kind === "start")!;
      const firstExited = f.exited(first.processId);
      const second = (await Promise.allSettled([f.client.start()]))[0]!;
      const attempts = await f.wire();
      t.diagnostic(JSON.stringify({ initializeMode, firstPid: first.processId, firstExited, second: second.status,
        initializations: attempts.filter((entry) => entry.method === "initialize").length }));
      assert.equal(firstExited, true, "A rejected initialization releases its actual original process");
      assert.equal(second.status, "rejected", "A second admission cannot bypass initialize on the rejected live child");
      if (second.status === "rejected") assert.match(String(second.reason), failure);
      assert.equal(attempts.filter((entry) => entry.method === "initialize").length, 2);
      assert.equal(attempts.filter((entry) => entry.method === "model/list").length, 0);
      f.configure("catalog-C", "medium");
      assert.equal(await f.client.resolveDefaultModel(), "catalog-C");
      assert.deepEqual(await f.client.listModels(), [{ id: "catalog-C", isDefault: true, defaultReasoningEffort: "medium" }]);
      const current = await f.stats();
      assert.notEqual(current.processId, first.processId);
      assert.equal(current.rpcCalls.filter((entry) => entry.method === "model/list").length, 1);
      assert.deepEqual(current.turnStartRequests, []);
    } finally { await f.close(); }
  });
}

test("concurrent start and catalog metadata wait for the actual held initialization receipt", async (t) => {
  const f = await fixture();
  let started: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    f.configure("catalog-A", "low", "explicit", "held");
    const first = f.client.start();
    void first.catch(() => undefined);
    const held = await f.rawControl<Stats>("fixture/stats");
    assert.equal(held.heldInitializations, 1);
    assert.equal(held.initializedReady, false);
    let secondReady = false;
    let metadataReady = false;
    const second = f.client.start().then(() => { secondReady = true; });
    const metadata = f.client.resolveDefaultModel().then((model) => { metadataReady = true; return model; });
    started = Promise.allSettled([first, second, metadata]);
    // Only this test-only raw control can pass the held admission to observe
    // the actual protocol. Two receipts let already queued model RPCs arrive.
    await f.rawControl<Stats>("fixture/stats");
    const before = await f.rawControl<Stats>("fixture/stats");
    t.diagnostic(JSON.stringify({ secondReady, metadataReady, initializedReady: before.initializedReady,
      modelQueriesBeforeInitialize: before.rpcCalls.filter((call) => call.method === "model/list").length }));
    assert.equal(secondReady, false, "A spawned child is not a completed initialize receipt");
    assert.equal(before.rpcCalls.filter((call) => call.method === "model/list").length, 0);
    await f.rawControl("fixture/releaseInitialize");
    const outcomes = await started;
    assert.ok(outcomes.every((outcome) => outcome.status === "fulfilled"));
    assert.equal(secondReady, true);
    assert.equal(metadataReady, true);
    const after = await f.stats();
    assert.equal(after.initializations, 1);
    assert.equal(after.initializedReady, true);
    const initialized = after.rpcCalls.findIndex((call) => call.method === "initialized");
    const modelQuery = after.rpcCalls.findIndex((call) => call.method === "model/list");
    assert.ok(initialized >= 0 && modelQuery > initialized);
    assert.deepEqual(after.turnStartRequests, []);
  } finally {
    await f.rawControl("fixture/releaseInitialize").catch(() => undefined);
    await f.close();
    await started;
  }
});

test("stop before a held initialize receipt settles every joined start and metadata observer once", async () => {
  const f = await fixture();
  try {
    f.configure("catalog-A", "low", "explicit", "held");
    const first = f.client.start();
    void first.catch(() => undefined);
    const held = await f.rawControl<Stats>("fixture/stats");
    assert.equal(held.heldInitializations, 1);
    const observed = Promise.allSettled([first, f.client.start(), f.client.resolveDefaultModel()]);
    await f.client.stop();
    const outcomes = await observed;
    assert.ok(outcomes.every((outcome) => outcome.status === "rejected" && /stopped/.test(String(outcome.reason))));
    const calls = await f.wire();
    assert.equal(calls.filter((call) => call.method === "initialize").length, 1);
    assert.equal(calls.filter((call) => call.method === "model/list").length, 0);
    assert.equal(calls.filter((call) => call.kind === "stdin-eof").length, 1);
    assert.equal(f.exited(held.processId), true);
    await assert.rejects(f.client.listModels(), /stopped/);
  } finally { await f.close(); }
});

test("stop racing rejected initialization joins its one original shutdown and preserves the primary cause", async () => {
  const f = await fixture();
  try {
    f.configure("uninitialized-model", "low", "explicit", "error", 200);
    const starting = Promise.allSettled([f.client.start()]);
    await waitFor(() => Boolean((f.client as unknown as { idleStopping?: Promise<void> }).idleStopping),
      "the actual failed initialization cleanup receipt");
    const pid = (await f.wire()).find((entry) => entry.kind === "start")!.processId;
    assert.equal(f.exited(pid), false, "The delayed original exit keeps this a real teardown race");
    const first = f.client.stop();
    const second = f.client.stop();
    assert.equal(first, second);
    await first.then(() => assert.equal(f.exited(pid), true, "Stop waits for the failed admission's actual child exit"));
    const result = (await starting)[0]!;
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /fixture initialization rejected/);
    const calls = await f.wire();
    assert.equal(calls.filter((entry) => entry.kind === "start").length, 1);
    assert.equal(calls.filter((entry) => entry.kind === "stdin-eof").length, 1);
    assert.equal(calls.filter((entry) => entry.method === "model/list").length, 0);
    await assert.rejects(f.client.resolveDefaultModel(), /stopped/);
  } finally { await f.close(); }
});

test("owned model preparation rejects cached metadata after original process loss without respawning", async () => {
  const f = await fixture();
  type Gateway = { planMode(model?: string, effort?: ReasoningEffort, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> };
  const gateway = (f.client as unknown as { modelGateway: Gateway }).modelGateway;
  const originalPlanMode = gateway.planMode.bind(gateway);
  try {
    await f.client.resolveDefaultModel();
    const thread = await f.client.startThread({ cwd: f.directory, ephemeral: true });
    gateway.planMode = async (...args) => {
      const mode = await originalPlanMode(...args);
      await f.exit();
      f.configure("catalog-B", "high");
      const reads = await Promise.allSettled([f.client.resolveDefaultModel(), f.client.listModels()]);
      assert.ok(reads.every((outcome) => outcome.status === "rejected" && /original.*(process|owner).*unavailable/.test(String(outcome.reason))),
        "Cached lookup cannot evade the actual SDK model-preparation namespace's original owner");
      return mode;
    };
    await assert.rejects(f.client.startTurn(thread, { prompt: "Original owned preparation", planMode: true }), /original.*(process|owner).*unavailable/);
    const calls = await f.wire();
    assert.equal(calls.filter((entry) => entry.kind === "start").length, 1);
    assert.equal(calls.filter((entry) => entry.method === "turn/start").length, 0);
  } finally { gateway.planMode = originalPlanMode; await f.close(); }
});

test("catalog cleanup verifies its original child even when a retired PID is reported live", async t => {
  const f = await fixture();
  const nativeKill = process.kill;
  let exitProbes = 0;
  try {
    await f.client.resolveDefaultModel();
    const original = await f.stats();
    await f.client.stop();
    const before = await f.wire();
    assert.equal(before.filter(row => row.kind === "start").length, 1);
    assert.equal(before.filter(row => row.method === "turn/start").length, 0);
    // The actual original already exited; only PID liveness observation is
    // injected. No process is created or signalled by this local probe.
    t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === original.processId && signal === 0) { exitProbes += 1; return true; }
      return nativeKill.call(process, pid, signal);
    });
    await f.close();
    t.diagnostic(JSON.stringify({ originalPid: original.processId, stalePidProbes: exitProbes,
      metadataStarts: 1, modelTurnStarts: 0, simulatedPidReuseOnly: true }));
  } finally {
    process.kill = nativeKill;
    await f.close();
  }
});
