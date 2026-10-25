import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as plugin from "../src/index.js";
import { CodexAppServerClient } from "../src/app-server.js";
import { closeCoordinationStoresForDirectory } from "../src/coordination.js";
import { WorkflowStore } from "../src/store.js";

test("model catalog uses its own Connection RPC channel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-model-catalog-"));
  const ctx = new Context();
  const subagents = { registerProvider: () => () => undefined,
    startActivation() { throw new Error("catalog requests must not start a child"); } };
  const routes = new Map<string, (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<any>>();
  const connection = { rpc: {
    handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<any>) {
      assert.equal(channel, "/dsh-codex-workflow");
      routes.set(channel, handler);
      return () => { routes.delete(channel); };
    },
  } };
  t.mock.method(CodexAppServerClient.prototype, "listModels", async () => [{ id: "dynamic-test-model", isDefault: true }]);
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    ctx.provide("agents", { list: () => [], get: () => undefined });
    ctx.provide("sessionProjections", { register: () => () => undefined });
    ctx.provide("subagents", subagents);
    ctx.provide("connection", connection);
    const fiber = ctx.plugin(plugin, { storageDir: directory });
    await fiber;
    const handler = routes.get("/dsh-codex-workflow");
    assert.ok(handler);
    assert.deepEqual(await handler("models", {}, new AbortController().signal), {
      ok: true, value: { models: [{ id: "dynamic-test-model", isDefault: true }] },
    });
    const signal = new AbortController().signal;
    assert.equal((await handler("workflow-state", { args: {} }, signal)).ok, false);
    assert.deepEqual(await handler("workflow-state", { args: { sessionId: "session-ui" } }, signal), {
      ok: true, value: { projection: null, externalState: true },
    });
    const writer = new WorkflowStore(directory);
    try {
      await writer.init();
      writer.appendUiEvent("session-ui", {
        type: "dsh-codex-workflow/plan-updated",
        data: { workflowId: "ui-workflow", status: "ready", planMarkdown: "Persisted plan", questions: [], assumptions: [] },
      });
    } finally {
      writer.close();
    }
    const state = await handler("workflow-state", { args: { sessionId: "session-ui" } }, signal);
    assert.equal(state.ok, true);
    assert.equal(state.value.externalState, true);
    assert.equal(state.value.projection.plan.planMarkdown, "Persisted plan");
    assert.equal(state.value.projection.currentWorkflowId, "ui-workflow");
    assert.equal((await handler("unknown", {}, new AbortController().signal)).ok, false);
    await fiber.dispose();
    assert.equal(routes.size, 0);
    Object.assign(subagents, { start() { throw new Error("catalog requests must not start a child"); } });
    const legacy = ctx.plugin(plugin, { storageDir: directory });
    await legacy;
    assert.deepEqual(await routes.get("/dsh-codex-workflow")!("workflow-state", { args: { sessionId: "session-ui" } }, signal), {
      ok: true, value: { projection: null, externalState: false },
    }, "a legacy host ignores sidecar state left by a newer host");
    await legacy.dispose();
    assert.equal(routes.size, 0);
  } finally {
    await ctx.fiber.dispose();
    closeCoordinationStoresForDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  }
});
