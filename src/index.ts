import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { writeFile, mkdir } from "node:fs/promises";
import { registerAutoTriggerPrompt } from "./auto-trigger.js";
import { CodexAppServerClient } from "./app-server.js";
import { CodexCliAuditDispatcher } from "./codex-cli-audit.js";
import { BridgeStore } from "./bridge-store.js";
import { BridgeRuntime } from "./bridge-runtime.js";
import { Config as ConfigSchema, type Config as RawConfig } from "./config.js";
import { SystemDesktopThreadOpener } from "./desktop-thread-opener.js";
import { REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { ALIGN_OUTPUT_SCHEMA } from "./review-authority.js";
import { WorkflowStore } from "./store.js";
import { createWorkflowTools } from "./tools.js";
import type { WorkflowConfig } from "./types.js";
import { WorkflowManager } from "./workflow.js";

export const name = "dsh-codex-workflow";
export const inject = ["tools", "agents", "systemPrompt"];
export const Config = ConfigSchema;
export type Config = RawConfig;

export function apply(ctx: Context, raw: Config): void {
  ctx.effect(async () => {
    const config = resolveConfig(raw);
    const store = new WorkflowStore(config.storageDir);
    await store.init();
    const bridgeStore = new BridgeStore(config.storageDir, config.bridgeMaxPayloadBytes);
    // Keep a materialized review schema for diagnostics and compatibility with
    // the legacy CLI dispatcher; production App Server turns receive it inline.
    const schemaFile = join(config.storageDir, "bridge", "review-schema.json");
    const alignmentSchemaFile = join(config.storageDir, "bridge", "alignment-schema.json");
    await mkdir(join(config.storageDir, "bridge"), { recursive: true });
    await writeFile(schemaFile, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA)}\n`, "utf8");
    await writeFile(alignmentSchemaFile, `${JSON.stringify(ALIGN_OUTPUT_SCHEMA)}\n`, "utf8");
    const codex = new CodexAppServerClient({
      command: config.codexCommand,
      requestTimeoutMs: config.turnTimeoutMs,
      rpcTimeoutMs: config.rpcTimeoutMs,
      idleProcessMs: config.idleProcessMs,
    });
    const audit = new CodexCliAuditDispatcher({
      command: config.codexCommand,
      reviewSchemaFile: schemaFile,
      alignmentSchemaFile,
      timeoutMs: config.callbackTimeoutMs,
      // `codex exec --json` can emit substantial tool/warning JSONL before the
      // final agent message. Keep retention bounded while allowing real review
      // contexts to complete instead of truncating at the unit-test default.
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const manager = new WorkflowManager(store, codex, config, audit, bridgeStore, audit);
    const autoTriggerDisposer = registerAutoTriggerPrompt(ctx.systemPrompt, config.autoTriggerMode);
    const runtime = new BridgeRuntime(bridgeStore, ctx.agents, {
      pollMs: config.bridgePollMs,
      storageDir: config.storageDir,
      manager,
      workflowStore: store,
      terminalRelayTimeoutMs: config.terminalRelayTimeoutMs,
      openCodexDesktopOnReview: false,
      desktopOpenRetryBaseMs: config.desktopOpenRetryBaseMs,
      desktopOpenRetryMaxMs: config.desktopOpenRetryMaxMs,
      desktopOpener: new SystemDesktopThreadOpener(),
    });
    const disposers = createWorkflowTools(manager, config).map((tool) => ctx.tools.register(tool));
    const stopListener = ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
      await manager.onTurnStopping(agent, turn);
    });
    // Keep the CLI-visible session registry fresh as agents come and go.
    const createdListener = ctx.on("agent/created", () => void runtime.refreshSessions().catch(() => undefined));
    const disposedListener = ctx.on("agent/disposed", () => void runtime.refreshSessions().catch(() => undefined));
    runtime.start();
    return async () => {
      await runtime.stop();
      stopListener();
      createdListener();
      disposedListener();
      for (const dispose of disposers.reverse()) dispose();
      autoTriggerDisposer();
      // Manager teardown blocks new callback sends, aborts in-flight recovery
      // and its backoff, then cancels and awaits every Reviewer operation.
      await manager.stop();
      await audit.stop();
      await codex.stop();
      bridgeStore.close();
      store.close();
    };
  });
}

function resolveConfig(raw: Config): WorkflowConfig {
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
  const turnTimeoutMs = Math.max(10_000, Math.trunc(raw.turnTimeoutMs));
  return {
    codexCommand: raw.codexCommand || "codex",
    autoTriggerMode: raw.autoTriggerMode || "complex",
    plannerModel: raw.plannerModel,
    reviewerModel: raw.reviewerModel,
    plannerEffort: raw.plannerEffort,
    reviewerEffort: raw.reviewerEffort,
    maxReviewCycles: Math.max(1, Math.min(10, Math.trunc(raw.maxReviewCycles))),
    maxNoChangeReviewRounds: Math.max(1, Math.min(10, Math.trunc(raw.maxNoChangeReviewRounds))),
    reviewDiffMaxBytes: Math.max(1024, Math.min(1024 * 1024, Math.trunc(raw.reviewDiffMaxBytes))),
    turnTimeoutMs,
    // Control RPCs (thread/start, turn/start, thread/fork, collaborationMode/
    // list, unsubscribe, ...) get a TIGHTER independent timeout so the tool
    // budget is provable: every serial step is bounded, and slow RPCs can
    // never make the host pre-empt a tool before its own cleanup.
    rpcTimeoutMs: Math.max(5_000, Math.min(turnTimeoutMs, 60_000)),
    idleProcessMs: Math.max(0, Math.trunc(raw.idleProcessMs)),
    terminalRelayTimeoutMs: Math.max(0, Math.min(10 * 60 * 1000, Math.trunc(raw.terminalRelayTimeoutMs))),
    openCodexDesktopOnReview: raw.openCodexDesktopOnReview,
    desktopOpenRetryBaseMs: Math.max(200, Math.min(60_000, Math.trunc(raw.desktopOpenRetryBaseMs))),
    desktopOpenRetryMaxMs: Math.max(1_000, Math.min(60_000, Math.trunc(raw.desktopOpenRetryMaxMs))),
    storageDir: raw.storageDir ? resolve(raw.storageDir) : join(dshHome, "storages", "dsh-codex-workflow"),
    bridgePollMs: Math.max(200, Math.min(60_000, Math.trunc(raw.bridgePollMs))),
    bridgeMaxPayloadBytes: Math.max(64 * 1024, Math.min(16 * 1024 * 1024, Math.trunc(raw.bridgeMaxPayloadBytes))),
    callbackTimeoutMs: Math.max(10_000, Math.min(30 * 60 * 1000, Math.trunc(raw.callbackTimeoutMs))),
    callbackMaxAttempts: Math.max(1, Math.min(10, Math.trunc(raw.callbackMaxAttempts))),
    callbackRetryBaseMs: Math.max(200, Math.min(5 * 60 * 1000, Math.trunc(raw.callbackRetryBaseMs))),
    leaseTtlMs: Math.max(5_000, Math.min(60 * 60 * 1000, Math.trunc(raw.leaseTtlMs))),
  };
}

export { CodexAppServerClient } from "./app-server.js";
export { CodexCliAuditDispatcher } from "./codex-cli-audit.js";
export { AppServerCodexCallbackDispatcher } from "./app-server-callback.js";
export { BridgeRuntime } from "./bridge-runtime.js";
export { SystemDesktopThreadOpener, codexThreadUri } from "./desktop-thread-opener.js";
export type { DesktopThreadOpener, SpawnLike, SpawnedProcessLike } from "./desktop-thread-opener.js";
export { collectEvidence, isGitRepository } from "./evidence.js";
export { WorkflowStore } from "./store.js";
export { WorkflowManager } from "./workflow.js";
export { PLUGIN_VERSION } from "./version.js";
export type { AutoTriggerMode } from "./auto-trigger.js";
export type * from "./types.js";
