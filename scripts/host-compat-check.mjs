#!/usr/bin/env node
// Load the built plugin against the operator's installed DSH core packages.
// No live profile, session, model, port, or user storage is started or modified.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as plugin from "../lib/index.js";

const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
const profileRequire = createRequire(join(dshHome, "profiles", "package.json"));
const hostPackage = process.env.DSH_CODEX_HOST_PACKAGE_JSON
  ? resolve(process.env.DSH_CODEX_HOST_PACKAGE_JSON)
  : profileRequire.resolve("@deepseek-ai/dsh/package.json");
const hostRequire = createRequire(hostPackage);
const loadHost = (name) => import(pathToFileURL(hostRequire.resolve(name)).href);
const { Context } = await loadHost("@deepseek-ai/cordis");
const { default: SystemPrompt } = await loadHost("@deepseek-ai/dsh-system-prompt");
const { ToolRuntime } = await loadHost("@deepseek-ai/dsh-tools");
const hostVersion = JSON.parse(await readFile(hostPackage, "utf8")).version;
const directory = await mkdtemp(join(tmpdir(), "dsh-codex-host-compat-"));
const ctx = new Context();
const names = ["start", "continue", "review", "review_only", "submit", "decide", "status", "cancel"]
  .map((name) => `codex_workflow_${name}`);
try {
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  // An empty registry keeps all bridge work local and prevents model calls.
  ctx.provide("agents", { list: () => [], get: () => undefined });
  const fiber = ctx.plugin(plugin, { storageDir: directory });
  await fiber;
  for (const name of names) assert.ok(ctx.tools.get(name), `${name} missing after activation`);
  await fiber.dispose();
  for (const name of names) assert.equal(ctx.tools.get(name), undefined, `${name} survived unload`);
  console.log(JSON.stringify({ ok: true, hostVersion, pluginVersion: plugin.PLUGIN_VERSION,
    toolsRegistered: names.length, unloaded: true, storage: "isolated-temp" }, null, 2));
} finally {
  await ctx.fiber.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
