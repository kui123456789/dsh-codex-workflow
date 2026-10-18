import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import * as plugin from "../src/index.js";
import { WorkflowManager } from "../src/workflow.js";
import { AppServerCodexCallbackDispatcher } from "../src/app-server-callback.js";
import { CodexAppServerClient } from "../src/app-server.js";
import { CodexCliAuditDispatcher } from "../src/codex-cli-audit.js";
import { BridgeRuntime } from "../src/bridge-runtime.js";
import { BridgeStore } from "../src/bridge-store.js";
import { WorkflowStore } from "../src/store.js";

async function fixture(t: TestContext, options: { primary?: unknown; laterFailure?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dsh-teardown-captured-effect-"));
  let teardown: (() => Promise<void>) | undefined;
  let retired = false;
  let retained = true;
  const calls: string[] = [];
  const late = new Error("later manager failure");
  const bridgeClose = BridgeStore.prototype.close;
  const workflowClose = WorkflowStore.prototype.close;
  const cleanupStores: Array<() => void> = [];
  t.mock.method(BridgeRuntime.prototype, "start", () => undefined);
  t.mock.method(BridgeRuntime.prototype, "stop", async () => { calls.push("runtime"); });
  t.mock.method(WorkflowManager.prototype, "stop", async () => {
    calls.push(retired ? "manager-after-sdk" : "manager-before-sdk");
    if (retired) retained = false;
    if (options.laterFailure) throw late;
  });
  t.mock.method(AppServerCodexCallbackDispatcher.prototype, "stop", async () => {
    calls.push(retired ? "callback-after-sdk" : "callback-before-sdk");
  });
  t.mock.method(CodexCliAuditDispatcher.prototype, "stop", async () => { calls.push("audit"); });
  t.mock.method(CodexAppServerClient.prototype, "stop", async () => {
    calls.push("sdk");
    retired = true;
  });
  t.mock.method(BridgeStore.prototype, "close", function (this: unknown) {
    calls.push("bridge-close");
    cleanupStores.push(() => bridgeClose.call(this));
    assert.equal(retained, false, "retained terminal cleanup must finish before closing the bridge DB");
    bridgeClose.call(this);
  });
  t.mock.method(WorkflowStore.prototype, "close", function (this: unknown) {
    calls.push("workflow-close");
    cleanupStores.push(() => workflowClose.call(this));
    assert.equal(retained, false, "terminal marker reconciliation must precede closing the workflow DB");
    workflowClose.call(this);
  });
  const ctx = {
    get(name: string) {
      if (name === "sessionProjections") return { register: () => () => {
        calls.push("projection");
        if (options.primary !== undefined || Object.prototype.hasOwnProperty.call(options, "primary")) throw options.primary;
      } };
      if (name === "connection") return { rpc: { handle: () => () => calls.push("model-route") } };
      throw new Error(`unexpected service ${name}`);
    },
    effect: async (initialize: () => Promise<() => Promise<void>>) => { teardown = await initialize(); },
    agents: { list: () => [], get: () => undefined },
    subagents: { registerProvider: () => () => calls.push("provider") },
    systemPrompt: { section: () => () => calls.push("prompt") },
    tools: { register: () => () => calls.push("tool") },
    on: () => () => calls.push("listener"),
  };
  t.after(async () => {
    for (const close of cleanupStores) close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await plugin.apply(ctx as unknown as Context, { storageDir: directory } as never);
  assert.equal(typeof teardown, "function");
  return { teardown: teardown!, calls };
}

test("plugin teardown reconciles retained resources after SDK shutdown before closing storage", async (t) => {
  const f = await fixture(t);
  await f.teardown();
  assert.deepEqual(f.calls.filter((call) => /manager-|callback-|^sdk$|^audit$|-close$/.test(call)), [
    "manager-before-sdk", "callback-before-sdk", "audit", "sdk", "callback-after-sdk", "manager-after-sdk",
    "bridge-close", "workflow-close",
  ]);
});

for (const [label, value] of [["undefined", undefined], ["null", null], ["false", false], ["zero", 0], ["empty string", ""]] as const) {
  test(`plugin teardown preserves a ${label} first rejection while draining resources`, async (t) => {
    const f = await fixture(t, { primary: value, laterFailure: true });
    const outcome = await f.teardown().then(() => ({ rejected: false, reason: undefined as unknown }),
      (reason: unknown) => ({ rejected: true, reason }));
    assert.equal(outcome.rejected, true);
    assert.equal(outcome.reason, value);
    assert.deepEqual(f.calls.slice(-2), ["bridge-close", "workflow-close"]);
  });
}
