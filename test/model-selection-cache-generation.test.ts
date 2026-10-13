import assert from "node:assert/strict";
import test from "node:test";
import { ModelSelectionGateway } from "../src/application/app-server/model-selection-gateway.js";

type JsonObject = Record<string, unknown>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : {};
const catalog = (id: string, effort = "low") => ({ data: [{ id, isDefault: true, defaultReasoningEffort: effort }] });

test("a late old catalog response cannot replace a reset namespace's ready directory", async () => {
  const old = deferred<JsonObject>();
  let requests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async (method) => {
    assert.equal(method, "model/list");
    requests += 1;
    return requests === 1 ? old.promise : catalog("new-model", "high");
  } });
  const original = gateway.listVisibleModels();
  void original.catch(() => undefined);
  gateway.resetCache();
  assert.deepEqual((await gateway.listVisibleModels()).map((entry) => entry.id), ["new-model"]);
  old.resolve(catalog("old-model"));
  await assert.rejects(original, /original.*catalog.*generation.*unavailable|catalog.*generation.*changed/i);
  assert.deepEqual((await gateway.listVisibleModels()).map((entry) => entry.id), ["new-model"]);
  assert.equal(await gateway.resolveDefaultModel(), "new-model");
  assert.equal(requests, 2, "Late fulfillment does not backfill or refetch the current namespace");
});

test("an old default derived from a ready directory cannot backfill the successor's default", async () => {
  let requests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async () => catalog(++requests === 1 ? "old-model" : "new-model") });
  await gateway.listVisibleModels();
  const original = gateway.resolveDefaultModel();
  let rejected: unknown;
  const settled = original.catch((error: unknown) => { rejected = error; });
  gateway.resetCache();
  assert.deepEqual((await gateway.listVisibleModels()).map((entry) => entry.id), ["new-model"]);
  await settled;
  assert.equal(await gateway.resolveDefaultModel(), "new-model", "Old derived work cannot repopulate cachedDefault after reset");
  assert.ok(rejected instanceof Error);
  assert.match(rejected.message, /original.*catalog.*generation.*unavailable|catalog.*generation.*changed/i);
});

for (const response of ["named", "fallback"] as const) {
  test(`old plan collaboration metadata (${response}) cannot adopt a reset namespace`, async () => {
    const old = deferred<JsonObject>();
    let modes = 0;
    let catalogs = 0;
    const gateway = new ModelSelectionGateway({ object, request: async (method) => {
      if (method === "collaborationMode/list") return ++modes === 1 ? old.promise : { data: [{ mode: "plan", model: "new-model" }] };
      assert.equal(method, "model/list");
      catalogs += 1;
      return catalog("new-model");
    } });
    const original = gateway.planMode();
    void original.catch(() => undefined);
    gateway.resetCache();
    assert.equal(await gateway.resolveDefaultModel(), "new-model");
    assert.equal(object((await gateway.planMode())?.settings).model, "new-model");
    old.resolve({ data: response === "named" ? [{ mode: "plan", model: "old-model" }] : [] });
    await assert.rejects(original, /original.*catalog.*generation.*unavailable|catalog.*generation.*changed/i);
    assert.equal(await gateway.resolveDefaultModel(), "new-model");
    assert.equal(catalogs, 1, "An old collaboration response cannot query or repopulate the current fallback");
  });
}

for (const reader of ["list", "default", "conversion", "silent"] as const) {
  test(`the public ${reader} result from a ready cache is invalidated at its asynchronous handoff`, async () => {
    let requests = 0;
    const gateway = new ModelSelectionGateway({ object, request: async () => catalog(++requests === 1 ? "old-model" : "new-model") });
    assert.equal(await gateway.resolveDefaultModel(), "old-model");
    const original = reader === "list" ? gateway.listVisibleModels()
      : reader === "default" ? gateway.resolveDefaultModel()
      : reader === "conversion" ? gateway.conversionMode()
      : gateway.silentReviewMode();
    void original.catch(() => undefined);
    gateway.resetCache();
    assert.equal(await gateway.resolveDefaultModel(), "new-model");
    await assert.rejects(original, /original.*catalog.*generation.*unavailable|catalog.*generation.*changed/i);
    assert.equal(object((await gateway.conversionMode())?.settings).model, "new-model");
    assert.equal(requests, 2);
  });
}

test("a late old catalog failure preserves its cause and leaves the new ready default intact", async () => {
  const old = deferred<JsonObject>();
  const originalError = new Error("old transport closed before its directory response");
  let requests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async () => ++requests === 1 ? old.promise : catalog("new-model") });
  const original = gateway.resolveDefaultModel();
  void original.catch(() => undefined);
  gateway.resetCache();
  assert.equal(await gateway.resolveDefaultModel(), "new-model");
  old.reject(originalError);
  await assert.rejects(original, (error: unknown) => error === originalError);
  assert.equal(await gateway.resolveDefaultModel(), "new-model");
  assert.equal(requests, 2);
});

test("a failed directory request is not cached as an empty or successful default", async () => {
  const originalError = new Error("directory temporarily unavailable");
  let requests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async () => {
    if (++requests === 1) throw originalError;
    return catalog("recovered-model");
  } });
  await assert.rejects(gateway.resolveDefaultModel(), (error: unknown) => error === originalError);
  assert.equal(await gateway.resolveDefaultModel(), "recovered-model");
  assert.equal(object((await gateway.silentReviewMode())?.settings).model, "recovered-model");
  assert.equal(requests, 2);
});

test("public model catalog snapshots cannot mutate the generation cache", async () => {
  let requests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async () => {
    requests += 1;
    return catalog("stable-model", "high");
  } });
  const first = await gateway.listVisibleModels();
  assert.equal(requests, 1);
  first[0]!.id = "caller-mutated-model";
  first[0]!.defaultReasoningEffort = "low";
  first.push({ id: "caller-added-model", isDefault: false, hidden: false });
  const second = await gateway.listVisibleModels();
  assert.deepEqual(second, [{ id: "stable-model", isDefault: true, hidden: false, defaultReasoningEffort: "high" }]);
  assert.equal(await gateway.resolveDefaultModel(), "stable-model");
  assert.equal(requests, 1, "The cache remains reusable after a caller mutates its detached snapshot");
});

test("reset clears a ready default through an empty directory and preserves an explicit unknown model override", async () => {
  let directory = "old";
  let catalogRequests = 0;
  const gateway = new ModelSelectionGateway({ object, request: async (method) => {
    if (method === "collaborationMode/list") return { data: [] };
    catalogRequests += 1;
    return directory === "empty" ? { data: [] } : catalog(`${directory}-model`, directory === "new" ? "high" : "low");
  } });
  assert.equal(await gateway.resolveDefaultModel(), "old-model");
  directory = "empty";
  gateway.resetCache();
  assert.deepEqual(await gateway.listVisibleModels(), []);
  assert.equal(await gateway.resolveDefaultModel(), undefined);
  assert.equal(await gateway.planMode(), undefined);
  assert.equal(await gateway.silentReviewMode(), undefined);
  assert.equal(await gateway.conversionMode(), undefined);
  const explicit = object((await gateway.conversionMode("not-listed", "medium"))?.settings);
  assert.equal(explicit.model, "not-listed");
  assert.equal(explicit.reasoning_effort, "medium");
  directory = "new";
  gateway.resetCache();
  const mode = object((await gateway.silentReviewMode())?.settings);
  assert.equal(mode.model, "new-model");
  assert.equal(mode.reasoning_effort, "high");
  assert.equal(await gateway.resolveDefaultModel(), "new-model");
  assert.equal(catalogRequests, 3, "Each healthy namespace reuses its own directory, including an empty one");
});

test("concurrent caller cancellation cannot cancel another catalog observer in the same namespace", async () => {
  const requests: Array<{ gate: ReturnType<typeof deferred<JsonObject>>; signal?: AbortSignal }> = [];
  const gateway = new ModelSelectionGateway({ object, request: async (_method, _params, signal) => {
    const gate = deferred<JsonObject>();
    requests.push({ gate, signal });
    const aborted = () => gate.reject(signal?.reason instanceof Error ? signal.reason : new Error("observer cancelled"));
    signal?.addEventListener("abort", aborted, { once: true });
    try { return await gate.promise; }
    finally { signal?.removeEventListener("abort", aborted); }
  } });
  const first = new AbortController();
  const second = new AbortController();
  const originalError = new Error("first observer cancelled");
  const cancelled = gateway.listVisibleModels(first.signal);
  const current = gateway.resolveDefaultModel(second.signal);
  void cancelled.catch(() => undefined);
  assert.equal(requests.length, 1, "same generation shares one model/list RPC");
  assert.equal(requests[0]?.signal, undefined, "the shared flight is not owned by one cancellable observer");
  first.abort(originalError);
  await assert.rejects(cancelled, (error: unknown) => error === originalError);
  requests[0]!.gate.resolve(catalog("current-model"));
  assert.equal(await current, "current-model");
  assert.deepEqual((await gateway.listVisibleModels()).map((entry) => entry.id), ["current-model"]);
  assert.equal(requests.length, 1);
});

test("reset starts a new catalog flight while an old shared flight cannot repopulate it", async () => {
  const requests: Array<{ gate: ReturnType<typeof deferred<JsonObject>> }> = [];
  const gateway = new ModelSelectionGateway({ object, request: async () => {
    const gate = deferred<JsonObject>();
    requests.push({ gate });
    return gate.promise;
  } });
  const old = gateway.resolveDefaultModel();
  void old.catch(() => undefined);
  assert.equal(requests.length, 1);
  gateway.resetCache();
  const current = gateway.resolveDefaultModel();
  assert.equal(requests.length, 2, "a reset namespace does not join the old generation flight");
  requests[1]!.gate.resolve(catalog("current-model"));
  assert.equal(await current, "current-model");
  requests[0]!.gate.resolve(catalog("old-model"));
  await assert.rejects(old, /catalog.*generation.*unavailable|catalog.*generation.*changed/i);
  assert.equal(await gateway.resolveDefaultModel(), "current-model");
  assert.equal(requests.length, 2);
});
