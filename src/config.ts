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
  turnTimeoutMs: z.number().default(10 * 60 * 1000),
  idleProcessMs: z.number().default(15 * 60 * 1000),
  storageDir: z.string().default(""),
});

export type Config = ReturnType<typeof Config>;