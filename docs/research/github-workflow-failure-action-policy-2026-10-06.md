# 工作流失败后的行动能力与新业务轮次边界核验

核验日期：2026-10-06。通过已读 Agent Reach GitHub／`gh` 路线核验固定 Temporal 与 XState 源码。本文件由既有 TEMP 笔记整理，没有新抓取、修改其它文件、运行上游测试/服务、调用模型或操作正式 DSH。

## 本地背景与证据范围

主任务审计已确认真实公开接缝 RED：原 Reviewer 经 SDK retirement 后没有成功 checkpoint，恢复查询未新启动模型，但 status 返回 not_waiting；parent nudge 与实际 SQL notice relay 仍引导 submit。沿该指令以原输入/未变化的真实 evidence hash 调公开 submit，接受了新 submission，child 数 1→2、thread 数 1→3、模型 RPC 数 1→4，最后得到新 received 结果。

以上来自主任务真实宿主/客户端配本地可控协议进程的 probe 报告，本研究没有重新运行；调用数不当作正式模型或 Token/费用测量。它证明失败能力判断、提示与实际接纳的边界需要一致；不证明已丢失 ephemeral 原线程可恢复，也不把新模型产物描述成原回合继续。修复与完整验收由主任务迭代记录归档。

## 固定来源与许可

| 来源 | 固定提交 | 许可 | 核验机制 |
|---|---|---|---|
| temporalio/sdk-typescript | `8161cd1cac3567fa4722b9754c33328cb917154b` | [MIT][t-license] | failure cause/retryState、服务端明确的新 run 与原 execution 定位 |
| statelyai/xstate | `38dcaffb20ec7f3cbb10e6161d8f0ebacca33701` | [MIT][x-license] | error/done snapshot 恢复不重执行、当前 guard 决定动作能力 |

只借鉴失败信息保存与动作接纳，不引入依赖或复制框架代码。

## Temporal：原失败、策略重试与新 execution 分开处理

**Evidence。** [WorkflowFailedError][t-error]保留 cause/retryState。[result 的失败分支][t-result]只有服务端事件携带 newExecutionRunId 且 followRuns=true 才跟随新 run；否则抛原 failure/retryState。cancel/terminate 明确标 NON_RETRYABLE_FAILURE；ContinueAsNew 在 followRuns=false 时返回包含新 run ID 的独立错误。

[handle 定位规则][t-handle]说明仅 workflowId 会指向最新 execution，原 runId 才指定原 execution。相同业务 key 不能成为原模型线程存在或可恢复的证据。

**Finding。** [官方 conflict policy 测试][t-test]验证默认/FAIL 拒绝重复运行，USE_EXISTING 返回同 run，TERMINATE_EXISTING 显式创建不同 run；原显式 handle 显示 TERMINATED，新 handle 为 RUNNING。测试只阅读，未本地运行。

**边界。**

- 服务端 newExecutionRunId 来自已配置策略或显式请求；它不是应用丢失原 ephemeral thread 后的恢复许可。
- Temporal chain 跟随新 run 与本项目“同原 thread/child 继续”不同，不能用 followRuns 的默认行为强迫新 Reviewer。
- retryState 不自动验证本项目原 artifact、输入/evidence freshness 或调用者权限；failure 原因与能力需要项目自己的结构化元数据。
- 上游测试没有覆盖本项目 status、nudge、notice 或相同 hash 的 resubmit 接纳。

## XState：读取失败 snapshot 不自动重新 invoke

**Evidence。** [Promise actor][x-promise]分别保存 active/done/error/stopped；start 仅对 active 调用 promiseCreator。非 active 直接返回，迟到完成也检查当前 status。

**Finding。** [官方 snapshot 恢复测试][x-restore-test]保存 resolved/rejected snapshot 后重建并 start actor，createdPromises 都保持 1。成功 output 保留；错误 snapshot 保留 error 且 output 未定义。读取/恢复已失败状态没有暗中再运行昂贵函数。测试只读未运行。

[MachineSnapshot.can][x-can]查询合法 transition；[StateNode guard][x-guard]由当前 context/event/snapshot 决定动作。[官方 can 测试][x-can-test]验证 unknown/guard=false 被拒、查询 SPAWN 不实际 spawn。这样可将“是否允许该行动”与执行行动分开。

**边界。**

- XState 没有内置的 LLM thread/artifact availability guard，必须由业务定义。
- can 不提供跨 await 锁，也不独立核 actor processing status。phase 名字没有自动赋予动作权限。
- 机器显式 RETRY/reentry 可以新 invoke；这种新 invocation 不应被称为原模型线程继续。
- 固定源码、机器分支和测试才能说明行为；注释、旧 schema 或工具描述中的“可重试”文字不构成恢复能力的机器证明。

## 本项目应一致使用的失败行动政策

| 当前可核能力 | 明确的下一步 |
|---|---|
| 原 thread/child 可用，原身份/证据合法且允许 continuation | 原 workflow resume，不换线程，不复发已提交 native answer |
| 原 turn 中断未确认 | 仅重试原 pair cleanup，确认前不发新模型回合 |
| 模型未曾启动，startup/admission 可修复 | 原业务首次 dispatch 的显式重试，不虚构原线程继续 |
| 原成功 artifact 存在且 scope/freshness 可验证 | 恢复原 artifact 的下游校验/提交，不重做 native review |
| 原 thread 不可用且没有成功 artifact | 精确报告不可恢复原因，保留原失败记录；等待明确新业务轮次请求或合法新输入 |
| artifact 身份/证据已失效 | 明确失效原因与新轮次边界，不直接接受旧结果 |
| 另有 owner 运行或状态变化 | 查询/等待实际 operation，旧事件不自行新建 |

phase=executing/fixing 只描述业务位置；status、turn-stop steer、submission notice 和 submit/review admission 应使用相同的失败元数据和行动边界。原模型不可恢复时，相同 evidence 的默认重新 submit 应拒绝，不能清旧 error、生成新 UUID 并默默新启动。明确请求新业务审查与真实 evidence 变化的接纳规则须单独核查，不把泛“重试”自动扩展成新轮次授权。

后续回归应从真实 retirement/失败路径采集 status、turn-stop、SQL notice，再以 unchanged evidence 调公开 submit；精确断言旧 submissionId/记录/error、thread/child/model 次数与 lease。合法 pre-model retry、原 artifact 恢复、明确新轮次与 workspace changed 分别作对照。提示修正不替代接纳 guard，入口拒绝也不应继续给误导性新运行指令。

关联背景见 [动作路由](github-workflow-action-routing-patterns-2026-10-06.md)、[恢复身份 fencing](github-resume-identity-fencing-patterns-2026-10-06.md)与[成功结果 checkpoint](github-review-checkpoint-patterns-2026-10-06.md)。本文不声称生产修复完成、完整门禁或真实模型 UI 已验收。

[t-license]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/LICENSE
[x-license]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/LICENSE
[t-error]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/errors.ts#L28-L37
[t-result]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L976-L1028
[t-handle]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L1958-L1988
[t-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-integration-workflow-start.ts#L50-L118
[x-promise]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/actors/promise.ts#L144-L200
[x-restore-test]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/actorLogic.test.ts#L161-L220
[x-can]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/State.ts#L305-L321
[x-guard]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/StateNode.ts#L426-L475
[x-can-test]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/state.test.ts#L280-L370
