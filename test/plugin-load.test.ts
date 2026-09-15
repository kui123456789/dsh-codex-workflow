import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as plugin from "../src/index.js";

test("DSH plugin activation waits for all workflow tools and unload removes them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-plugin-load-"));
  const ctx = new Context();
  const names = ["start", "continue", "review", "review_only", "submit", "decide", "status", "cancel"]
    .map((name) => `codex_workflow_${name}`);
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    ctx.provide("agents", { list: () => [], get: () => undefined });
    const fiber = ctx.plugin(plugin, { storageDir: directory });
    await fiber;
    for (const name of names) assert.ok(ctx.tools.get(name), `${name} must exist when activation resolves`);
    await fiber.dispose();
    for (const name of names) assert.equal(ctx.tools.get(name), undefined);
  } finally {
    // Let an already-started async effect settle even when the activation
    // assertion fails, so its disposer can release the Windows SQLite handle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("DSH receives asynchronous plugin initialization failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-codex-plugin-failure-"));
  const occupied = join(directory, "not-a-directory");
  await writeFile(occupied, "fixture");
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, {});
    ctx.provide("agents", { list: () => [], get: () => undefined });
    const fiber = ctx.plugin(plugin, { storageDir: occupied });
    await assert.rejects(fiber.await(), /EEXIST|ENOTDIR/);
    assert.equal(ctx.tools.get("codex_workflow_start"), undefined);
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
