import z from "@deepseek-ai/schemastery";

const effort = z.union([
  z.const("low"),
  z.const("medium"),
  z.const("high"),
  z.const("xhigh"),
  z.const("max"),
  z.const("ultra"),
]);

export const Config = z.object({
  codexCommand: z.string().default("codex"),
  plannerModel: z.string().default(""),
  reviewerModel: z.string().default(""),
  plannerEffort: effort.default("high"),
  reviewerEffort: effort.default("high"),
  maxReviewCycles: z.number().default(3),
  maxNoChangeReviewRounds: z.number().default(1),
  reviewDiffMaxBytes: z.number().default(65536),
  bridgePollMs: z.number().default(1000),
  bridgeMaxPayloadBytes: z.number().default(1024 * 1024),
  callbackTimeoutMs: z.number().default(10 * 60 * 1000),
  callbackMaxAttempts: z.number().default(3),
  callbackRetryBaseMs: z.number().default(2000),
  leaseTtlMs: z.number().default(60_000),
  turnTimeoutMs: z.number().default(10 * 60 * 1000),
  idleProcessMs: z.number().default(5_000),
  terminalRelayTimeoutMs: z.number().default(60_000),
  storageDir: z.string().default(""),
});

export type Config = ReturnType<typeof Config>;
