# 前台原执行不可恢复与新审查轮次的接纳边界核验

核验日期：2026-10-06。本文复用 Agent Reach GitHub／`gh` 已读的 Temporal 与 TanStack Query 固定来源，由 TEMP 笔记整理。没有新增网络抓取、运行上游测试/服务、修改其它文档/源码/测试或操作正式 DSH。

## 已确认的本地边界与研究范围

主任务确认两类真实公开 RED：planned/review_only 的冷恢复通过 manager.stop 与 SDK.stop 确认旧物理进程结束，保留同 SQL row，再实际把原文件改为 v2；fresh Manager 对原 workflowId 的公开 review 仍被 no-in-process continuation 锁死，未创建新资源且 cycle 不变。相反，warm 路径的真实 SDK timeout/interrupt RPC 失败后，原 writer 仍 active；实际文件变化的 review 却启动新模型/thread/child并失去旧 handle。

这些事实来自主任务 probe 报告，本研究没有重新执行或把它们当正式模型/Token 测量。所需修复同时包括允许合法新轮次与阻止未确认终止的旧 writer；不能只放宽一个“有无 runtime handle”条件。修复与完整验收由主任务迭代记录归档。

## 固定来源与许可

| 来源 | 固定提交 | 许可 | 借鉴机制 |
|---|---|---|---|
| temporalio/sdk-typescript | `8161cd1cac3567fa4722b9754c33328cb917154b` | [MIT][t-license] | 原 execution 复用与显式新 execution 的不同语义 |
| TanStack/query | `d169ee87786c250ccc791f5b22c40141a489ec88` | [MIT][q-license] | 新注册独立构造、旧 cleanup 不删除替代实例 |

只借鉴机制，不迁移框架依赖或复制源码。

## Temporal：明确的新 execution 不伪造原 run

**Evidence。** [handle 定位][t-handle]区分 workflowId 的最新 execution 与 workflowId+runId 的指定 execution。新 run 不会使旧 runId 变成新的合法资源句柄。

**Finding。** [官方 conflict policy 测试][t-test]覆盖默认/FAIL 拒绝已运行 execution，USE_EXISTING 返回同 run，TERMINATE_EXISTING 明确创建不同 run；旧显式 handle 仍显示 TERMINATED，新 handle 为 RUNNING。测试已阅读，未运行。

**采用与边界。**

- 原 resume 与明确新业务 review 是不同接纳请求；前者只能沿原 thread，后者在旧运行已结束后捕获新 round 的身份、输入和有效设置。
- 该测试不覆盖工作区变化、原 App Server 进程丢失或 payload 自动比较，不能替代本项目原范围证据检查。
- TERMINATE_EXISTING 的抢占能力不迁移到本项目：当前 live lease/owner 或原 writer 的终止未确认时仍必须拒绝新 round。
- 相同 workflowId 保留业务历史，不证明新 round 仍是旧资源恢复。

## TanStack Query：新实例捕获当前配置，旧清理限定原实例

**Evidence。** [QueryCache.build][q-build]先按 queryHash 查询现存对象，只有不存在才 new Query，使用本次 options/defaults/state。[constructor][q-constructor]建立新的 options、observers 与 initial state；显式传入 state 才使用该恢复数据。

[remove][q-remove]只有 current Query === 请求清理的原对象才 destroy/delete/通知。不能通过共同 key 把旧注册的清理权限扩展到新注册。

**Finding。** [官方旧注册 no-op 测试][q-test]移除旧对象、建立同 key 新对象，再迟到 remove 旧对象；断言新对象仍在、没有 remove 通知。测试已读未运行。

**采用与边界。**

- 新 round 在合法接纳后建立新的原始 settings/identity/evidence 与 artifact 来源；旧 finalizer 不删除新 thread/child 注册。
- 显式 state/hydration 允许继承数据，因此不能概括成框架永不继承旧状态。本项目不得把未经验证的旧 artifact 当新 round 产物。
- QueryCache 不提供 SQL lease/权限、workspace fingerprint 或远端 ACK；cache/runtime map 缺失不能证明旧 writer 终止。
- 不把新 Query 的配置选择照搬成 LLM 行为；只借鉴新注册与原注册的身份分离。

## 本项目的新 round 接纳原则

| 当前可核事实 | 合法边界 |
|---|---|
| 原 thread/child、identity/settings/evidence 有效 | 普通继续沿原 run，保持原有效配置与句柄 |
| 旧物理进程明确结束，原 thread 不可恢复 | 原 resume 明确报不可恢复；真正新 review 可走独立新 round 门禁 |
| 仅进程内 recovery map 缺失 | 不证明旧 writer 已结束；核持久元数据、真实 lease与原进程状态 |
| 原 interruption ACK 未确认或另一 live owner 运行 | 无论文件变化或显式新轮次请求，都不能启动新模型或抢占 |
| 真实 workspace 变化 | 从原 latestReviewEvidence 的 kind/fingerprint/原文件 selection 核查；新 candidate 文件列表不单独充当变更证明 |
| 显式新轮次控制 | 必须是明确的 true，仅供 admission 决策；不得进入模型 prompt、authority 材料或 Reviewer 输入基准 |
| 新 round 已合法接纳 | 采用新 attempt/generation、当前明确输入/defaults和新的 artifact provenance；旧 scope 只用于诊断/历史，不伪造旧 ResumeInput |

原 latestReviewEvidence 可核原范围的变化，但不能补造未保存的旧 implementationSummary/testResults、ReviewerIdentity 或原模型上下文。新 review 使用本次明确 candidate 材料；原 continuation 仍锁定旧 settings。新 round 不继承旧 retained run 的有效配置，当前显式请求设置仍具有自身约束。

现有 review lease 在 prepare 之前取得，SQLite admission/CAS 仍必须比较实际 owner/token/epoch并在每个 await 后重核。原 scope 变化/显式新轮次的分类不能先强制 resume 不存在的句柄；也不能在旧中断未确认时 clear 原 recoverable handle、释放原 pin后直接新建。

建议保留 cold changed-scope 正常接纳、cold unchanged 默认拒绝、显式 true 对照、warm unconfirmed ACK 拒绝、live lease 拒绝五种真实入口验证。精确计模型/thread/child、attempt/cycle、原/新 settings、控制字段未进入模型材料，以及整行/revision与实际 lease。旧 cleanup只能处理自己注册，新 round 只创建一次。

关联背景见 [失败行动政策](github-workflow-failure-action-policy-2026-10-06.md)、[恢复身份 fencing](github-resume-identity-fencing-patterns-2026-10-06.md)与[共享 consumer 归属](github-shared-workflow-consumer-ownership-patterns-2026-10-06.md)。本文不声称生产修复完成、全量门禁或真实模型 UI 已验收。

[t-license]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/LICENSE
[q-license]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/LICENSE
[t-handle]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L1958-L1988
[t-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-integration-workflow-start.ts#L50-L118
[q-build]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/queryCache.ts#L181-L199
[q-constructor]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/query.ts#L304-L317
[q-remove]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/queryCache.ts#L235-L242
[q-test]: https://github.com/TanStack/query/blob/d169ee87786c250ccc791f5b22c40141a489ec88/packages/query-core/src/__tests__/queryCache.test.tsx#L422-L440

