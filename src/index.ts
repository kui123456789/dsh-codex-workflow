import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { writeFile, mkdir } from "node:fs/promises";
import { CodexAppServerClient } from "./app-server.js";
import { BridgeStore } from "./bridge-store.js";
import { BridgeRuntime } from "./bridge-runtime.js";
import { CodexCallbackDispatcher } from "./codex-callback.js";
import { Config as ConfigSchema, type Config as RawConfig } from "./config.js";
import { REVIEW_OUTPUT_SCHEMA } from "./schemas.js";
import { WorkflowStore } from "./store.js";
import { createWorkflowTools } from "./tools.js";
import type { WorkflowConfig } from "./types.js";
import { WorkflowManager } from "./workflow.js";

export const name = "dsh-codex-workflow";
export const inject = ["tools", "agents"];
export const Config = ConfigSchema;
export type Config = RawConfig;

export function apply(ctx: Context, raw: Config): void {
  ctx.effect(async () => {
    const config = resolveConfig(raw);
    const store = new WorkflowStore(config.storageDir);
    await store.init();
    const bridgeStore = new BridgeStore(config.storageDir, config.bridgeMaxPayloadBytes);
    // The review output schema file: prepared by the plugin (outside any
    // sandbox) and passed to the read-only Codex child via --output-schema.
    const schemaFile = join(config.storageDir, "bridge", "review-schema.json");
    await mkdir(join(config.storageDir, "bridge"), { recursive: true });
    await writeFile(schemaFile, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA)}\n`, "utf8");
    const codex = new CodexAppServerClient({
      command: config.codexCommand,
      requestTimeoutMs: config.turnTimeoutMs,
      idleProcessMs: config.idleProcessMs,
    });
    const callback = new CodexCallbackDispatcher({
      command: config.codexCommand,
      schemaFile,
      timeoutMs: config.callbackTimeoutMs,
    });
    const manager = new WorkflowManager(store, codex, config, callback, bridgeStore);
    const runtime = new BridgeRuntime(bridgeStore, ctx.agents, {
      pollMs: config.bridgePollMs,
      storageDir: config.storageDir,
      manager,
      workflowStore: store,
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
      // Manager teardown blocks new callback sends, aborts in-flight recovery
      // and its backoff, then kills and awaits every callback child.
      await manager.stop();
      await codex.stop();
      bridgeStore.close();
      store.close();
    };
  });
}

function resolveConfig(raw: Config): WorkflowConfig {
  const dshHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
  return {
    codexCommand: raw.codexCommand || "codex",
    plannerModel: raw.plannerModel,
    reviewerModel: raw.reviewerModel,
    plannerEffort: raw.plannerEffort,
    reviewerEffort: raw.reviewerEffort,
    maxReviewCycles: Math.max(1, Math.min(10, Math.trunc(raw.maxReviewCycles))),
    maxNoChangeReviewRounds: Math.max(1, Math.min(10, Math.trunc(raw.maxNoChangeReviewRounds))),
    reviewDiffMaxBytes: Math.max(1024, Math.min(1024 * 1024, Math.trunc(raw.reviewDiffMaxBytes))),
    turnTimeoutMs: Math.max(10_000, Math.trunc(raw.turnTimeoutMs)),
    idleProcessMs: Math.max(0, Math.trunc(raw.idleProcessMs)),
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
export { BridgeRuntime } from "./bridge-runtime.js";
export { collectEvidence, isGitRepository } from "./evidence.js";
export { WorkflowStore } from "./store.js";
export { WorkflowManager } from "./workflow.js";
export type * from "./types.js";
