# 前台审查的阶段检查点与失败恢复模式核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取 LangGraph 与 Inngest SDK 的固定源码，并通过 Context7 的 resolve-library-id → query-docs 查询官方文档。本文记录研究证据与采用方向，**不声明生产修复或完整验收已经完成**。没有复制上游代码、添加依赖、运行上游测试/服务或操作正式 DSH。

## 本地问题与证据归属

主任务本轮实证报告确认 5 个新增 RED，并补充 reconciliation 后续失败探针。这里转述该报告；研究者没有重新执行本地探针，也没有把本地协议故障注入当成真实上游模型故障或 Token 测量。原始日志、确切计数、修复后的回归和门禁由[第 30 轮迭代记录](../iterations/2026-10-06-thirtieth-foreground-stage-checkpoints.md)另行归档。

| 主任务报告的观察 | 需要解决的边界 |
|---|---|
| readable 已完成，通用 conversion/alignment 失败后释放原 Reviewer；同材料再次审查会重新运行 readable | 保存成功阶段输出，恢复只执行失败阶段 |
| 私有 alignment 失败且中断 ACK 未确认，原 writer 仍 active；另一 Manager 的新审查能够越过原运行保护 | 保留真实 interruption handle 与持久阻塞信息，先确认原 writer 结束 |
| 已注册 Reviewer 后的权限/Schema 终态错误允许同材料重复审查；创建线程前启动失败作为对照 | 区分终态拒绝与尚未建立 Reviewer 的首次启动重试 |
| reconciliation 已产生修正内容，后续 conversion/alignment 失败缺少可继续的阶段句柄 | 保存修正后的 readable/normalized 输出，避免重新原始审查或再次无条件 reconciliation |

当前前台 `ReviewExecution` 将 readable、显示修正、conversion、alignment/reconciliation 和最终应用放在同一流程。Bridge 已有 `SubmissionReviewCheckpoint`，在复用 verdict 前核查原 submission identity、原文件 evidence 与 lease。源码对照仅说明接缝；本地故障与修复是否成立须由真实公开入口测试证明。

## 固定来源与许可

| 来源 / 范围 | 固定提交 | 许可 | 借鉴机制 |
|---|---|---|---|
| langchain-ai/langgraph | `2d942085e214ef6b99b6f54ed4d544a7c7c5ac56` | [MIT][l-license] | 按原 task ID 恢复已完成输出，失败任务继续执行 |
| inngest/inngest-js SDK 4.21.1 | `aff5f1f2d6b1b73f4a7c5069810703e49db08213` | [Apache-2.0][i-license] | 按步骤身份接纳确认保存的结果，不丢弃成功 buffer |

许可按固定文件读取，Inngest 此处仅指 SDK。只借鉴机制，不移植框架或服务。此前 [Bridge checkpoint 研究](github-review-checkpoint-patterns-2026-10-06.md)另行核查了 Inngest server 存储链与其许可证，本轮没有重复验证该服务链。

## LangGraph：恢复完成 task，执行未完成 task

**Evidence。** [`_reapplies_pending_writes` 与完成输出恢复][l-restore] 区分普通恢复和主动 replay：非 replay 时，把 checkpoint 内的成功输出按原 task ID 放回对应 task；失败/中断任务保留空 writes，供 runner 执行。[put_writes][l-writes] 按 task ID 更新 writes，明确保留输出归属。

**Finding。** 官方 [test_pending_writes_resume][l-test] 先令 `one` 成功一次、`two` 连续失败两次。在同一 `thread1` 上 `invoke(None)` 后，断言 `one.calls == 1`、`two.calls == 4`；修复 two 后，原 one 的 pending 输出与新 two 输出合并。测试已阅读，未在本机运行。

**Path 与边界。**

- 保存已经确认完成的昂贵输出；下游基础设施失败不使已完成 readable 失效。
- checkpoint 绑定原执行步骤；不得泛化成跨工作区、跨审查轮次的 LLM 缓存。
- Context7 返回的现行 [Functional API][l-functional]、[Graph API][l-graph]说明：恢复可从函数起点重放，完成 task/subgraph 的输出替代重算；node 本体和未完成 task 仍可重新执行。
- 非确定性值和副作用须放在独立 task；完成 task 的顺序变化可能错配缓存。普通 resume、主动 replay、显式新业务轮次不是相同操作。
- 上游支持的持久 checkpointer 不赋予本项目 ephemeral thread 跨进程生命期；本地缓存存在也不证明原 App Server thread 可寻址。

## Inngest：确认保存成功步骤后才继续下游

**Evidence。** [步骤 lookup][i-lookup] 使用最终 step ID；middleware 改 ID 会改变 memoization lookup。[handle][i-resolve] 重新读取 `stepState`，已有 fulfilled result 时让原 Promise 返回 memoized data。[memoization barrier][i-barrier] 区分用户函数已返回与服务端已确认保存，等待 handle 收到确认数据才放行。

**Finding。** 官方 [checkpoint 失败回归][i-test] 覆盖 seq-1/seq-2 成功、will-fail 失败且 checkpoint 服务也失败：fallback 返回已完成的两个 buffered steps，失败步骤未被当作 completed buffer。测试断言只出现前两步，will-fail 不在响应。测试已读未运行；此例不单独证明完整跨调用恢复或远端存储部署可靠。

**Path 与边界。**

- 已完成的 readable/normalized 输出应该有明确的保存点，不能只留下“曾完成”的进度消息。
- step ID 不是本项目的输入签名。相同名称不证明 task、plan、cwd、模型设置、changedFiles 和 evidence 仍匹配。
- Context7 的现行官方 [Retries][i-retries]、[Versioning][i-versioning]文档说明独立步骤重试和变更 ID 后重执行。文档链接是当前 main；精确 SDK 实现以固定 commit 为准。
- SDK 这条路径不能证明服务器 exactly-once、外部副作用只发生一次，或缓存丢失后仍可恢复。

## 活动 writer 与检查点是两项独立证明

LangGraph 的 [TimedAttemptScope][l-scope] 使用 `close()` 与 guarded_send 同锁，使超时后的晚 writes 不再进入状态；[超时处理][l-timeout] 关闭 scope、清理 writes 并发送 `bg.cancel()`。该代码不证明任意外部 LLM writer 已退出。

本项目必须保留 App Server/进程/DSH 的真实生命周期边界：

- observer timeout、Promise reject、取消请求或 map 缺失都不等于 writer 已终止。
- 未确认 ACK 时保留原 interruption handle，并通过既有 barrier 确认清理后才执行下游或新轮次。
- progress、checkpoint 写入和最终结果应用都复核 owner/token/epoch；旧 callback/finally 不删除后继实例。
- 进程丢失时，持久 completion marker 不补造旧 text/result/thread/child/context。原恢复报告 unavailable；明确新轮次仍走 [第 29 轮 admission 边界](github-foreground-new-review-round-patterns-2026-10-06.md)。

## 本项目的采用契约

| 条件 | 采用方向与验收要求 |
|---|---|
| readable 真正完成且显示契约通过 | 保存权威 readable；conversion 可恢复失败只继续 conversion，readableCalls 保持 1 |
| normalized 真正完成且 Schema 有效 | 保存 normalized verdict；alignment 基础设施失败只继续验证，normalizedCalls 保持 1 |
| reconciliation 已生成修正产物 | 检查点切换到修正文本/修正 verdict；后续失败不重新原始审查，不丢失原冲突信息 |
| 原 scope/settings/evidence/owner 不变 | 普通 resume 沿原 child/thread、原输入和有效设置，连续追加回合 |
| 原材料或上下文改变 | 每次 await 后重核，采原 changedFiles；仅替换候选文件列表不能制造真实变化 |
| 中断 ACK 未确认、另一个 owner 仍 live | 阻止下一阶段和新业务审查；保存原句柄，不以超时推断退出 |
| 已注册 Reviewer 后终态权限/Schema/非法线程失败 | 准确报告终态原因，禁止同材料静默 fresh；线程前启动失败保留首次重试语义 |
| checkpoint/ephemeral context 在当前进程不可用 | 不重跑 readable 掩盖缺失，不伪造原上下文，不新建替代 Reviewer |
| 最终接受结果 | 重新核原 evidence，CAS 内确认原 attempt/lease；只在成功应用时消费一次 review cycle |

自动 continuation 仍最多一次，不照搬上游默认重试次数。取消、停止与 lease 变化后的晚结果不得推进检查点或应用 verdict。等待恢复时保留必要资源；成功、终态错误或取消按捕获身份清理一次。

建议真实入口回归覆盖 conversion、alignment、reconciliation 后续失败、再次失败后的公开 resume、warm 未确认 ACK、cold process loss、注册后权限/Schema拒绝、线程前启动对照，以及并发 resume/cancel。计真实模型/thread/child/cleanup调用，断言原身份不变、cycle只提交一次；实现与完整门禁结论留在迭代记录，不由本文代替。

[l-license]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/LICENSE
[i-license]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/LICENSE.md
[l-restore]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_loop.py#L767-L783
[l-writes]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_loop.py#L430-L472
[l-test]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/tests/test_pregel.py#L891-L987
[l-functional]: https://docs.langchain.com/oss/python/langgraph/functional-api
[l-graph]: https://docs.langchain.com/oss/python/langgraph/graph-api
[i-lookup]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L2517-L2529
[i-resolve]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L2605-L2686
[i-barrier]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.ts#L1792-L1803
[i-test]: https://github.com/inngest/inngest-js/blob/aff5f1f2d6b1b73f4a7c5069810703e49db08213/packages/inngest/src/components/execution/engine.test.ts#L488-L539
[i-retries]: https://github.com/inngest/website/blob/main/pages/docs/features/inngest-functions/error-retries/retries.mdx
[i-versioning]: https://github.com/inngest/website/blob/main/pages/docs/learn/versioning.mdx
[l-scope]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_retry.py#L211-L233
[l-timeout]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_retry.py#L483-L518
