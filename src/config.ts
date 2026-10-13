import z from "@deepseek-ai/schemastery";

const effort = z.union([
  z.const("low"),
  z.const("medium"),
  z.const("high"),
  z.const("xhigh"),
  z.const("max"),
  z.const("ultra"),
]);

// Keep the model field open for newer/custom Codex models while the Web
// settings page offers the models known by the current App Server as choices.
// `volatile()` makes the value live-editable through DSH Settings; the runtime
// keeps the reference and reads its current snapshot for each new turn.
const model = z.union([z.const(""), z.string()]);

const conversionTransport = z.union([z.const("app-server"), z.const("cli")]);
const conversionFallback = z.union([z.const("cli"), z.const("fail")]);

const autoTriggerMode = z.union([
  z.const("off"),
  z.const("complex"),
  z.const("always"),
]);

export const Config = z.object({
  codexCommand: z.string().default("codex"),
  autoTriggerMode: autoTriggerMode.default("complex"),
  plannerModel: model.default("").description("Planner 使用的 Codex 模型；留空跟随 App Server 默认模型").volatile(),
  reviewerModel: model.default("").description("Reviewer 使用的 Codex 模型；留空跟随 App Server 默认模型").volatile(),
  plannerEffort: effort.default("high").description("Planner 推理程度").volatile(),
  reviewerEffort: effort.default("high").description("Reviewer 推理程度").volatile(),
  conversionTransport: conversionTransport.default("app-server").description("结构化转换通道").volatile(),
  conversionFallback: conversionFallback.default("cli").description("App Server 转换失败时的处理").volatile(),
  maxReviewCycles: z.number().default(3),
  maxNoChangeReviewRounds: z.number().default(1),
  reviewDiffMaxBytes: z.number().default(65536),
  bridgePollMs: z.number().default(1000),
  bridgeMaxPayloadBytes: z.number().default(1024 * 1024),
  callbackTimeoutMs: z.number().default(10 * 60 * 1000),
  callbackMaxAttempts: z.number().default(3),
  callbackRetryBaseMs: z.number().default(2000),
  /** 1.1.1 transient-upstream retry policy (shared by the CLI audit, the App
   * Server turns and the submission callback). `server_overloaded` / 429 / 5xx
   * are TEMPORARY: the plugin now backs off and tries again inside these
   * bounds instead of ending the workflow and asking a human to redo the call.
   * Budget 0 disables the automatic retry entirely. */
  transientRetryBaseMs: z.number().default(3_000),
  transientRetryMaxMs: z.number().default(60_000),
  transientRetryBudgetMs: z.number().default(20 * 60 * 1000),
  transientRetryJitterRatio: z.number().default(0.25),
  reviewHeartbeatMs: z.number().default(15_000),
  reviewStaleMs: z.number().default(60_000),
  /** 1.1.4: bound on the round's Reviewer-subscription release. The cleanup
   * deliberately carries no business signal (a cancelled round must still
   * release), so it needs its own deadline instead — otherwise a hung
   * `thread/unsubscribe` would wedge the round's `finally`, and with it
   * cancel/teardown. */
  reviewerReleaseTimeoutMs: z.number().default(10_000),
  leaseTtlMs: z.number().default(60_000),
  turnTimeoutMs: z.number().default(10 * 60 * 1000).description("单次模型回合超时（毫秒）；完整工作流预算含多个回合、控制请求和重试，计算后须在 DSH 宿主期限范围内，超界配置会在工具注册前明确拒绝"),
  idleProcessMs: z.number().default(5_000),
  terminalRelayTimeoutMs: z.number().default(60_000),
  openCodexDesktopOnReview: z.boolean().default(true),
  desktopOpenRetryBaseMs: z.number().default(2_000),
  desktopOpenRetryMaxMs: z.number().default(60_000),
  storageDir: z.string().default(""),
});

export type Config = ReturnType<typeof Config>;
