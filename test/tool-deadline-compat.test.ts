import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as plugin from "../src/index.js";
import { Config } from "../src/config.js";
import { MAX_HOST_TOOL_TIMEOUT_MS, assertWorkflowToolTimeout } from "../src/tool-timeout-compat.js";

const peerRequire = createRequire(import.meta.url);
const hostPackage = process.env.DSH_CODEX_HOST_PACKAGE_JSON ? resolve(process.env.DSH_CODEX_HOST_PACKAGE_JSON) : undefined;
const hostRequire = hostPackage ? createRequire(hostPackage) : peerRequire;
const hostContract = hostPackage ? "explicit installed host" : "known supported released host contract";
const loadHost = (name: string) => import(pathToFileURL(hostRequire.resolve(name)).href);

test("complete-operation compatibility accepts the host boundary and rejects unsupported deadlines without clamping", () => {
  assert.doesNotThrow(() => assertWorkflowToolTimeout("review", MAX_HOST_TOOL_TIMEOUT_MS));
  assert.doesNotThrow(() => assertWorkflowToolTimeout("review", 1));
  for (const value of [MAX_HOST_TOOL_TIMEOUT_MS + 1, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    assert.throws(() => assertWorkflowToolTimeout("codex_workflow_review", value), (error: unknown) => {
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /codex_workflow_review/);
      assert.match(error.message, /turnTimeoutMs/);
      assert.match(error.message, /cannot be shortened silently/);
      return true;
    });
  }
});

for (const input of [
  { turnTimeoutMs: 600_000, accepted: true },
  { turnTimeoutMs: 300_000_000, accepted: false },
  // This turn value exceeds a worst-case static maximum but is valid with
  // these smaller actual budgets. The checker must preserve it unchanged.
  { turnTimeoutMs: 250_000_000, transientRetryBudgetMs: 0, callbackTimeoutMs: 10_000, accepted: true },
]) {
  test(`${hostContract} honors actual operation budgets for a schema-valid ${input.turnTimeoutMs} ms turn`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-timer-host-"));
    const { Context } = await loadHost("@deepseek-ai/cordis");
    const { ToolRuntime } = await loadHost("@deepseek-ai/dsh-tools");
    const { default: SystemPrompt } = await loadHost("@deepseek-ai/dsh-system-prompt");
    const timeoutPolicy = await loadHost("@deepseek-ai/dsh-tool-call-timeout-policy");
    const { ToolCallId } = await loadHost("@deepseek-ai/dsh-llm");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    if (hostPackage) {
      const boot = await loadHost("@deepseek-ai/dsh-app-boot");
      const hostVersion = JSON.parse(await readFile(hostPackage, "utf8")).version;
      assert.equal(boot.evaluatePluginCompatibility(manifest, undefined, hostVersion), undefined);
    } else {
      // CI loads real services from the pinned released package group. It does
      // not need a global DSH profile or manufacture an installed-host claim.
      const expected = manifest.devDependencies["@deepseek-ai/dsh-tools"];
      for (const name of ["dsh-tools", "dsh-system-prompt", "dsh-llm", "dsh-tool-call-timeout-policy"]) {
        const actual = JSON.parse(await readFile(hostRequire.resolve(`@deepseek-ai/${name}/package.json`), "utf8")).version;
        assert.equal(actual, expected, `${name} must use the same pinned released host contract`);
      }
    }
    const ctx = new Context();
    let fiber: { await(): Promise<void>; dispose(): Promise<void> } | undefined;
    let executed = 0;
    try {
      const { accepted, ...settings } = input;
      assert.equal(Config(settings).turnTimeoutMs, settings.turnTimeoutMs, "schema preserves the valid finite input");
      await ctx.plugin(SystemPrompt, {});
      await ctx.plugin(ToolRuntime, {});
      await ctx.plugin(timeoutPolicy, {});
      ctx.provide("agents", { list: () => [], get: () => undefined });
      ctx.provide("sessionProjections", { register: () => () => undefined });
      ctx.provide("subagents", { registerProvider: () => () => undefined });
      ctx.provide("connection", { rpc: { handle: () => () => undefined } });
      fiber = ctx.plugin(plugin, { storageDir: directory, ...settings });
      if (!accepted) {
        await assert.rejects(fiber!.await(), /unsupported complete-operation timeout.*DSH host/s);
        for (const suffix of ["start", "continue", "resume", "review", "review_only", "submit", "decide", "status", "cancel"]) {
          assert.equal(ctx.tools.get(`codex_workflow_${suffix}`), undefined, "unsupported configuration registers no workflow tools");
        }
        assert.deepEqual(await readdir(directory), [], "budget rejection happens before any storage file is created");
        for (const artifact of ["coord.sqlite", "bridge/review-schema.json", "bridge/alignment-schema.json"]) {
          await assert.rejects(access(join(directory, artifact)), (error: unknown) => {
            assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
            return true;
          });
        }
        assert.equal(executed, 0);
        return;
      }
      await fiber!.await();
      const definition = ctx.tools.get("codex_workflow_review");
      assert.ok(definition);
      assert.ok(definition.timeoutMs > input.turnTimeoutMs);
      assert.ok(definition.timeoutMs <= MAX_HOST_TOOL_TIMEOUT_MS);
      const probe = { ...definition, name: "local_timeout_probe", parameters: {}, async execute() {
        executed += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { completed: true };
      } };
      const unregister = ctx.tools.register(probe);
      const result = await ctx.tools.execute({ callId: ToolCallId("timer-probe"), name: probe.name,
        arguments: {}, signal: new AbortController().signal });
      unregister();
      assert.equal(result.isError, false, JSON.stringify(result.error));
      assert.equal(executed, 1);
    } finally {
      await fiber?.dispose();
      await ctx.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
