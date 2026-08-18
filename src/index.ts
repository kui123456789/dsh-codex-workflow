import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { CodexAppServerClient } from "./app-server.js";
import { Config as ConfigSchema, type Config as RawConfig } from "./config.js";
import { WorkflowStore } from "./store.js";
import { createWorkflowTools } from "./tools.js";
import type { WorkflowConfig } from "./types.js";
import { WorkflowManager } from "./workflow.js";

export const name = "dsh-codex-workflow";
export const inject = ["tools"];
export const Config = ConfigSchema;
export type Config = RawConfig;

export function apply(ctx: Context, raw: Config): void {
  ctx.effect(async () => {
    const config = resolveConfig(raw);
    const store = new WorkflowStore(config.storageDir);
    await store.init();
    const codex = new CodexAppServerClient({
      command: config.codexCommand,
      requestTimeoutMs: config.turnTimeoutMs,
      idleProcessMs: config.idleProcessMs,
    });
    const manager = new WorkflowManager(store, codex, config);
    const disposers = createWorkflowTools(manager).map((tool) => ctx.tools.register(tool));
    const stopListener = ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
      await manager.onTurnStopping(agent, turn);
    });
    return async () => {
      stopListener();
      for (const dispose of disposers.reverse()) dispose();
      await codex.stop();
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
  };
}

export { CodexAppServerClient } from "./app-server.js";
export { collectEvidence, isGitRepository } from "./evidence.js";
export { WorkflowStore } from "./store.js";
export { WorkflowManager } from "./workflow.js";
export type * from "./types.js";
