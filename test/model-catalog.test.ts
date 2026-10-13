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

test("model catalog uses its own Connection RPC channel", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-model-catalog-"));
  const ctx = new Context();
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
    ctx.provide("subagents", { registerProvider: () => () => undefined });
    ctx.provide("connection", connection);
    const fiber = ctx.plugin(plugin, { storageDir: directory });
    await fiber;
    const handler = routes.get("/dsh-codex-workflow");
    assert.ok(handler);
    assert.deepEqual(await handler("models", {}, new AbortController().signal), {
      ok: true, value: { models: [{ id: "dynamic-test-model", isDefault: true }] },
    });
    assert.equal((await handler("unknown", {}, new AbortController().signal)).ok, false);
    await fiber.dispose();
    assert.equal(routes.size, 0);
  } finally {
    await ctx.fiber.dispose();
    closeCoordinationStoresForDirectory(directory);
    await rm(directory, { recursive: true, force: true });
  }
});
