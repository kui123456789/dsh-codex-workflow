# 审查成功结果的 checkpoint 与下游恢复模式核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取公开固定源码；选取 Inngest、Temporal 两个机制案例。本文只记录证据与采用方向，没有复制框架源码、添加依赖、修改生产代码、运行上游服务/测试或调用模型。

## 结论与采用范围

昂贵步骤的成功结果已经进入可恢复状态后，下游解析、校验或持久化失败应保留该结果；恢复入口可以重新执行下游阶段。复用必须绑定原业务轮次、结果归属和输入证据，不能仅凭字符串任务 ID 命中。结果 checkpoint 与正在运行的 thread/turn 是两种资源：结果可重用不证明原 writer 已终止，也不赋予 ephemeral thread 跨进程恢复能力。

## 固定来源与许可

| 项目 / 范围 | 固定提交 | 固定许可 |
|---|---|---|
| inngest/inngest-js SDK | `aff5f1f2d6b1b73f4a7c5069810703e49db08213` | [Apache-2.0][i-license] |
| inngest/inngest server，补齐同案例的存储链 | `6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a` | [SSPL-1.0，并含第三周年生效的 Apache-2.0 future grant][is-license]；没有据此把当前固定版本标成 Apache-2.0 |
| temporalio/sdk-typescript | `8161cd1cac3567fa4722b9754c33328cb917154b` | [MIT][t-license] |
| temporalio/sdk-rust，TS SDK 固定 gitlink 对应的 Core | `2deeab98d64a6bc1fac4eab5a942e7889acf8077` | [MIT][tc-license]；[.gitmodules][t-submodule] 核实仓库地址 |

许可按固定文件读取。本项目只借鉴结果保存与恢复条件，不迁移服务、SDK 或代码。

## Inngest：先提交成功步骤，再处理下游失败

**Evidence。** [SDK lookup][i-lookup] 用[身份 hash 函数][i-hash]计算的 `sha1(step ID)` 查询 `stepState`；[完成步骤的 handle][i-resolve] 将内部 handler 设置为返回 `result.data`，继续 resolve 原步骤 Promise，成功步骤的用户函数不再次运行。[HTTP 请求接纳][i-request] 把请求的 `steps` 还原为 data/input/error 状态，并把原 `ctx.run_id` 传入新 execution。

服务器 [SaveResponse][is-save] 以 account 所选 shard、function/run 和 step ID 定位记录；[Lua 保存分支][is-lua] 对同值重复保存返回幂等结果，对不同值返回 duplicate，不覆盖旧结果。随后 [LoadSteps][is-load] 从 Redis 读取已保存输出。[SaveStep adapter][is-adapter] 区分幂等保存及 Redis 已写入但调用超时的重试分支。这条链将结果从当前 JavaScript 对象移到可再次读取的运行状态。

**Finding。** 下游普通函数错误发生时，[function-rejected handler][i-flush] 先 force-flush 成功步骤；checkpoint 暂时失败时，[fallback][i-fallback] 将全部 buffered 成功步骤返回 executor，而非丢弃。上游测试 [engine.test.ts][i-flush-test] 明确覆盖“两步成功后函数体抛错”和强制 flush 失败；[integration/retry.test.ts][i-retry-test] 断言上游 `aAttempts=[0,1]`、下游 `bAttempts=[0,1]`，下游重试没有再次运行已成功的 a。测试已阅读，未在本地执行。

**Path 与边界。**

- 把模型成功输出保存成独立 checkpoint，再运行展示/Schema/freshness 校验，校验异常保留输出。
- SDK 的 hash 输入只有步骤 ID；它没有自动比较闭包、模型配置或工作区内容。相同 ID 的复用仍需本项目的输入/证据签名。
- 进程重新建立 execution 可以接纳原 run 的已保存步骤；服务器存储仍须存在。仅函数返回、仍在本地 buffer、Redis 数据丢失或状态已删除，不足以保证可恢复。
- [cancelOn 转换][i-cancel-config] 生成服务器取消条件；[executor 取消路径][is-cancel] 停止后删除该 run 状态。该机制不证明任意外部 writer 已退出，也不能把已取消 run 当无条件继续的缓存。
- Lua 防重复写入保障的是记录操作；外部副作用发生后、结果入库前的故障仍可能重复执行外部动作。

## Temporal：从历史完成事件恢复结果

**Evidence。** 固定 Core [完成事件处理][tc-event] 读取 `ActivityTaskCompletedEventAttributes.result`，[ResolveActivity 命令][tc-resolve] 携带原 seq 与结果。TS SDK [resolveActivity][t-resolve] 按 seq 找 pending completion，解码历史 payload 并 resolve。Activity 的 [schedule 命令][t-schedule] 携带 seq、activityType 和序列化 arguments；Worker [按 activation.runId 分组][t-run]。因此复用属于同一 execution/history 的步骤，不能只用业务 workflowId 当跨 run 的内容缓存键。

**Finding。** [handleWorkflowFailure][t-failure] 将普通 Error 记为 Workflow Task 错误；取消、ContinueAsNew、TemporalFailure 及配置的终态错误另有处理。普通下游校验错误可以只失败当前 task，保存的 Activity 完成历史仍能供重放使用。这不证明终态失败、新 run、reset 或新输入自动沿用旧结果。

上游 [无 Activity 注册的 replay Worker 测试][t-replay-test] 先获取完成历史，再成功重放；[新 Worker 查询同一 handle][t-new-worker-test] 在第二个 Worker 没有 Activity 注册时仍能从历史重建。[错误策略测试][t-error-test] 覆盖普通 Error 导致 task failure；[不兼容代码 replay 测试][t-incompatible-test] 断言 DeterminismViolationError/ReplayError。这些测试已阅读，未执行；没有找到并核实一个同时覆盖“昂贵 Activity、下游验证异常、恢复成功、调用计数为一”的完整测试。

**Path 与边界。**

- 成功结果必须已进入可重放历史；外部调用刚返回的瞬间仍可能没有 checkpoint。
- 代码、步骤顺序与历史要兼容；已读路径不证明自动比较 arguments、代码哈希或工作区快照，本项目必须自行核查 freshness。
- [取消选项][t-cancel] 明确区分 TRY_CANCEL 与 WAIT_CANCELLATION_COMPLETED：前者可立即报告取消，后者仍可能因 Activity 不 heartbeat/忽略取消而阻塞。取消状态不等于外部终止确认。
- [Local Activity 至少一次边界][t-local] 明确 task retry 可能再次执行本地步骤，即便 maximumAttempts=1；不能泛化为外部副作用 exactly-once。
- 第二个 Worker 的历史重建支持恢复运行状态；本轮未亲测崩溃恢复，也不支持声称 DSH App Server 的 ephemeral thread 跨进程存活。

## 本项目的最小 checkpoint 契约与验收方向

| 条件 | 本项目应明确的行为 |
|---|---|
| 上游已确认成功，下游失败 | 保留原始成功输出、checkpoint 阶段与失败原因；恢复直接从下游阶段读取原结果 |
| 身份与 owner | 至少绑定 workflowId、审查轮次、owner session、原 thread/turn 的 provenance；调用者不能加入别人的 checkpoint |
| 输入或证据变化 | 重新比较规范化输入、模型/配置、证据 snapshot signature 与校验版本；不满足复用条件时明确冲突/失效 |
| 取消、stop 或上游终止不明 | 阻止后续接纳；仍在运行的原 pair 留在创建者 cleanup owner，中断确认后只释放一次 |
| 进程恢复 | 持久成功结果与原 provenance 可以单独验证；没有原运行态 thread 时明确报告边界，不伪造线程或静默创建替代 Reviewer |

建议回归用真实接纳路径记录昂贵模型调用次数：第一次模型成功、下游失败、resume 后模型仍为一次；逐项变化 owner、输入、工作区证据、模型设置、校验版本时拒绝错误复用；取消后不提交结果；持久化失败保留 checkpoint 的原内容；进程恢复分别验证结果读取与旧 ephemeral 线程不可回挂。副作用与清理断言计真实调用，不能只用幂等包装后的计数。

本节是实现与验收方向，未对共享工作区当前实现或全部门禁作通过声明。取消确认和辅助资源归属的固定 Codex 源码边界见 [前一份研究](github-review-entry-and-resource-ownership-2026-10-06.md)。

[i-license]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/LICENSE.md
[is-license]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/LICENSE.md#L561-L567
[t-license]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/LICENSE
[tc-license]: https://github.com/temporalio/sdk-rust/blob/2deeab98d64a6bc1fac4eab5a942e7889acf8077/LICENSE.txt
[t-submodule]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/.gitmodules#L1-L4
[i-lookup]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L2924-L2989
[i-hash]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L3354-L3362
[i-resolve]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L2608-L2686
[i-request]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/InngestCommHandler.ts#L2276-L2327
[is-save]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/redis_state.go#L1074-L1114
[is-lua]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/lua/saveResponse.lua#L23-L50
[is-load]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/redis_state.go#L739-L784
[is-adapter]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/v2_adapter.go#L695-L743
[i-flush]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L1427-L1447
[i-fallback]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L968-L1010
[i-flush-test]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.test.ts#L603-L709
[i-retry-test]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/test/integration/retry.test.ts#L14-L60
[i-cancel-config]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/InngestFunction.ts#L197-L221
[is-cancel]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/executor.go#L2180-L2209
[tc-event]: https://github.com/temporalio/sdk-rust/blob/2deeab98d64a6bc1fac4eab5a942e7889acf8077/crates/sdk-core/src/worker/workflow/machines/activity_state_machine.rs#L491-L507
[tc-resolve]: https://github.com/temporalio/sdk-rust/blob/2deeab98d64a6bc1fac4eab5a942e7889acf8077/crates/sdk-core/src/worker/workflow/machines/activity_state_machine.rs#L308-L318
[t-resolve]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/workflow/src/internals.ts#L712-L722
[t-schedule]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/workflow/src/workflow.ts#L216-L275
[t-run]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/worker/src/worker.ts#L2050-L2061
[t-failure]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/workflow/src/internals.ts#L1366-L1392
[t-replay-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-local-activities.ts#L474-L487
[t-new-worker-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-integration-replay-and-flags.ts#L46-L64
[t-error-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-workflow-fail-on-errors-policy.ts#L121-L130
[t-incompatible-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-replay.ts#L85-L118
[t-cancel]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/common/src/activity-options.ts#L29-L60
[t-local]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/common/src/activity-options.ts#L198-L203
