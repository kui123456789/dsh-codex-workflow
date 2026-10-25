#!/usr/bin/env node
// Load the built plugin against the operator's installed DSH core packages.
// No live profile, session, model, port, or user storage is started or modified.
//
// It also answers the question the HOST asks at profile startup: does this
// plugin's declared @deepseek-ai/dsh* peer range cover the installed runtime? The
// answer comes from the host's OWN evaluator (`evaluatePluginCompatibility`, the
// same code path that asks the user for an exact-version exemption), so this gate
// can never drift from real host behaviour. Note its documented semantics:
// prereleases PARTICIPATE in ranges — plain npm semver would misjudge them.
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
const packageRoot = (name) => join(hostRequire.resolve(`${name}/package.json`), "..");
const { Context } = await loadHost("@deepseek-ai/cordis");
const { default: SystemPrompt } = await loadHost("@deepseek-ai/dsh-system-prompt");
const { ToolRuntime } = await loadHost("@deepseek-ai/dsh-tools");
const { AgentRegistry } = await loadHost("@deepseek-ai/dsh-agent");
const { SessionStore, KNOWN_SESSION_EVENT_TYPES } = await loadHost("@deepseek-ai/dsh-session");
const { SessionProjectionRegistry } = await loadHost("@deepseek-ai/dsh-session-projection");
const { SubagentRuntime } = await loadHost("@deepseek-ai/dsh-subagent");
const { HostConnectionService } = await loadHost("@deepseek-ai/dsh-client-connection");
const { WebServer } = await loadHost("@deepseek-ai/dsh-host-webserver");
const hostVersion = JSON.parse(await readFile(hostPackage, "utf8")).version;
const directory = await mkdtemp(join(tmpdir(), "dsh-codex-host-compat-"));
const ctx = new Context();
const names = ["start", "continue", "resume", "review", "review_only", "submit", "decide", "status", "cancel"]
  .map((name) => `codex_workflow_${name}`);
// Desktop distributions may omit declaration files. Only their absence permits
// checking the shipped implementation instead; unreadable files still fail.
async function clientContract(packageName, declarationPath, declarationPattern, implementationPattern, message) {
  try {
    const declaration = await readFile(join(packageRoot(packageName), "lib", "types", ...declarationPath), "utf8");
    assert.match(declaration, declarationPattern, message);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const implementation = await readFile(join(packageRoot(packageName), "lib", "client.js"), "utf8");
    assert.match(implementation, implementationPattern, `${message} in shipped client implementation`);
  }
}
try {
  // Static public-client contract guard. These checks do not load or mutate a
  // browser surface; they fail the gate if a host upgrade removes the exact
  // native subagent resource or public sidebar/session faces this client uses.
  const subagentClient = await readFile(join(packageRoot("@deepseek-ai/dsh-client-ui-subagent"), "lib", "client.js"), "utf8");
  assert.ok(subagentClient.includes("dsh-resource://subagentchat/session/"), "subagentchat resource address contract missing");
  assert.match(subagentClient, /kind:\s*["']subagentchat["']/, "subagentchat tab kind contract missing");
  assert.match(subagentClient, /mode\s*!==\s*["']one-shot["']/, "subagentchat one-shot mode parser contract missing");
  assert.match(subagentClient, /searchParams\.get\(["']parent["']\)/, "subagentchat parent query parser contract missing");
  await clientContract("@deepseek-ai/dsh-client-ui-sidebar-right", ["client", "service.d.ts"],
    /openResource\(/, /^\s*openResource\([^)]*\)\s*\{/m, "ISidebarRight.openResource contract missing");
  await clientContract("@deepseek-ai/dsh-client-ui-sidebar-right", ["client", "service.d.ts"],
    /openTab</, /^\s*openTab\([^)]*\)\s*\{/m, "ISidebarRight.openTab contract missing");
  await clientContract("@deepseek-ai/dsh-api-session-controller", ["client", "contract", "sessions.d.ts"],
    /binding\(/, /^\s*binding\([^)]*\)\s*\{/m, "ISessions.binding contract missing");
  await clientContract("@deepseek-ai/dsh-api-session-controller", ["client", "contract", "session.d.ts"],
    /faceOf\(/, /^\s*faceOf\([^)]*\)\s*\{/m, "ProjectionsFace.faceOf contract missing");

  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(ToolRuntime, {});
  // Use the installed services, with no agents, model provider or agent loop.
  await ctx.plugin(AgentRegistry, {});
  await ctx.plugin(SessionStore, {});
  await ctx.plugin(SessionProjectionRegistry, {});
  if (SubagentRuntime.inject?.includes("workingDirectory")) {
    const [filesystem, workingDirectory] = await Promise.all([
      loadHost("@deepseek-ai/dsh-fs-local"), loadHost("@deepseek-ai/dsh-working-directory"),
    ]);
    await ctx.plugin(filesystem.default, {});
    await ctx.plugin(workingDirectory.default, { defaultDirectory: directory });
  }
  await ctx.plugin(SubagentRuntime, {});
  let webServer;
  await ctx.plugin({ name: "host-check-http-carrier", apply(owner) {
    // Construct the real route registry without invoking its listener hook.
    // A separate provider fiber preserves Cordis injection/access checks.
    webServer = new WebServer(owner, { host: "127.0.0.1", port: 0, compression: false });
  } });
  await ctx.plugin({ name: "host-check-connection", apply(owner) {
    // No request crosses the authentication boundary in this registration check.
    const browserAuth = new Proxy({}, { get() { throw new Error("host check must not authenticate browser requests"); } });
    new HostConnectionService(owner, [], browserAuth);
  } });
  assert.equal(webServer.port, undefined, "host check must not open a listener");
  const eventTypesBefore = new Set(KNOWN_SESSION_EVENT_TYPES);
  const fiber = ctx.plugin(plugin, { storageDir: directory });
  await fiber;
  if (typeof ctx.subagents.start !== "function") assert.deepEqual(new Set(KNOWN_SESSION_EVENT_TYPES), eventTypesBefore,
    "V4 activation must not extend the host's released event vocabulary");
  for (const name of names) assert.ok(ctx.tools.get(name), `${name} missing after activation`);
  const modelRoute = { kind: "prefix", path: "/dsh-codex-workflow", handler() {
    throw new Error("host check must not issue model catalog requests");
  } };
  assert.throws(() => webServer.register(modelRoute), /duplicate.*route/, "model catalog RPC route missing after activation");
  await fiber.dispose();
  for (const name of names) assert.equal(ctx.tools.get(name), undefined, `${name} survived unload`);
  const removeProbeRoute = webServer.register(modelRoute);
  removeProbeRoute();
  assert.equal(webServer.port, undefined, "host check must not open a listener");

  // Peer range vs. the installed runtime, judged by the host itself.
  const boot = await loadHost("@deepseek-ai/dsh-app-boot");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const runtimeVersion = boot.getDshRuntimeVersion();
  assert.equal(runtimeVersion, hostVersion,
    `the selected dsh package.json (${hostVersion}) disagrees with the host runtime version (${runtimeVersion})`);
  const incompatibility = boot.evaluatePluginCompatibility(manifest, undefined, runtimeVersion);
  assert.equal(incompatibility, undefined,
    `declared DSH peer range does not cover the running dsh ${runtimeVersion}: `
    + `${incompatibility ? boot.pluginCompatibilityWarning(incompatibility) : ""}`);
  const peers = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/"))
    .map(([name, range]) => `${name}@${range}`);

  console.log(JSON.stringify({ ok: true, hostVersion, pluginVersion: plugin.PLUGIN_VERSION,
    toolsRegistered: names.length, unloaded: true, storage: "isolated-temp",
    peerCompatible: true, nativeSubagentSidebarContract: true, modelCatalogRpcRegistered: true,
    modelCatalogRpcUnloaded: true, listenerStarted: false, declaredPeers: peers }, null, 2));
} finally {
  await ctx.fiber.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
