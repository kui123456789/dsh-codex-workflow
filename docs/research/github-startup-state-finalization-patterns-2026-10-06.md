# 启动失败后的状态收尾与原业务重试核验

核验日期：2026-10-06。通过 Agent Reach 的 GitHub／`gh` 后端读取 BullMQ 与 Prefect 固定公开源码和测试。本文聚焦用户任务开始前的初始化失败、状态归类和本地运行标记收尾，不重复资源 acquireRelease 的一般机制。只新增研究文档，没有复制框架、引入依赖、修改源码/测试、运行上游服务/测试或调用模型。

## 结论与固定来源

模型未启动时，资源创建或接纳失败应保存原业务记录和失败阶段、收尾临时运行态，并允许原业务在条件修复后重新接纳。该分支不能写成“原模型回合失败，等待发 continuation”：没有原模型回合时，继续指令没有合法对象。模型已启动或 writer 状态未知时，必须沿用原资源及其确认屏障。

| 案例 | 固定提交 | 固定许可 | 证据范围 |
|---|---|---|---|
| taskforcesh/bullmq | `71c9ca72f32108e21f8d339b95ff750606806f60` | [MIT][b-license] | child 初始化失败隔离、原 job 状态迁移、worker/lock tracking 收尾 |
| PrefectHQ/prefect | `86cbe02fe1932964852dba7ef9eb2ab497ee85c9` | [Apache-2.0][p-license] | engine 上下文内 pre-execution BaseException 的 Crashed 状态与 finally；明确不涵盖所有 startup 异常 |

## BullMQ：初始化失败属于原 job，坏 child 不再复用

**Evidence。** [ChildPool.retain][b-retain] 等待 child.init，成功后重新确认 child 未退出再登记 retained；失败时不放回 free pool，调用 kill/remove 并重抛原初始化错误。[kill/remove][b-remove] 先移除本地 retained/free，再返回 child.kill Promise。

[sandbox 创建路径][b-sandbox] 在 retain 成功后才发送 Start；retain rejection 被传给外层 done Promise。因此 child 初始化失败不会先执行 job 的用户 processor。随后 [Worker.processJob][b-process] 将错误交给 handleFailed，finally untrack 原 job 的 lock tracking；[handleFailed][b-failed] 在可处理条件下调用原 job.moveToFailed。

[Job.moveToFailed][b-move] 根据[剩余 attempts/错误类型/backoff][b-retry-policy]将同一 `this.id` 放回重试或 delayed，或写 failed；[显式 Job.retry][b-retry]也针对原 job，要求存在、未锁定且处于预期终态。[Worker.run][b-run] 以 finally 复位 running，避免循环异常后永久标记 already running。

**Finding。** 上游 [init-fail-once 场景][b-test]用 fixture 的[模块加载异常][b-fixture]触发首次初始化失败，断言 failedReason 原文、free pool 为空，随后另一个 job 返回 `"ok"`。[未创建进程的初始化错误测试][b-pre-fork-test]断言原错误仍可见、free pool 为空。测试已阅读，未执行。

**Path 与边界。**

- 本项目应在原 workflow 上记录 child/provider 启动失败，清除本次启动中的临时标记；修复后重走首次 dispatch 接纳路径。
- 上述恢复测试是“后续另一个 job 成功”，不是原 job startup retry 的完整端到端证明。原 job 重试身份来自 Job.moveToFailed/retry 源码，不能混合两种证据。
- BullMQ 会重新创建 sandbox child；本项目只能借鉴原业务身份和坏资源隔离。已启动的 Planner/Reviewer 回合仍须保留原 child/thread，不据此自动替换。
- retain catch 中 kill Promise 只挂 catch，没有 await；本地池已移除不等于子进程物理退出。不可把它迁移成远端 ACK 或已完成清理证明。
- backend closing、锁丢失或状态迁移失败时，[handleFailed 的条件][b-failed]与[错误重试包装][b-process]限制该路径；不能声明任何启动故障都会可靠持久 failed。
- sandbox 在 Start 后才处理 signal；它不能证明取消期间模型零调用，也不适合作为本项目取消接纳顺序的模板。

## Prefect：pre-execution crash 收尾有明确覆盖范围

**Evidence。** [initialize_run][p-init]建立 client 与 flow-run 记录，内部 yield 包围后续 begin_run；其 BaseException 分支在记录尚未 final 时调用 handle_crash，已 final 的状态保持。[sync handle_crash][p-crash]写 Crashed 并保留原异常；[async handle_crash][p-async-crash]用 CancelScope shield 保护服务器状态写入。[sync finally][p-finally]报告 attempt conclusion 后清除 `_is_started` 和 `_client`；[async finally][p-async-finally]做同样收尾。

[引擎入口][p-start]先进入 initialize_run，再 begin_run，然后才进入用户 flow 的调用循环。恢复是否允许、下一次执行的相位仍由运行记录与 orchestration 策略决定，cleanup flag 本身不构成恢复授权。

**Finding。** [同步/异步 pre-execution 测试][p-test]把 begin_run 替换为抛出 `BaseException("Pre-execution error")`，确认唯一 flow-run 记录变为 Crashed。它们证明该特定启动窗口的状态落点，没有计用户函数/模型调用、client 清理或“修复后同 run 成功”的次数；本轮不补写这类验证结论。

**Path 与边界。**

- 明确“初始化/接纳失败”与“用户任务执行失败”的阶段，保存原异常并在退出路径复位本地 running/started 标记。
- initialize_run 中普通 Exception 仅重抛；flow-run 创建和 telemetry 启动还位于内部 try/yield 之前。该源码不提供覆盖全部启动失败的统一终态保障。
- finally 先报告再复位标记；本例未证实 report 本身失败时标记仍能复位。状态持久化、清理和本地标记复位应分别拥有必要的 finally。
- Crashed 是 Prefect 的状态策略，本项目可修正的启动条件应按自身 waiting/相位契约处理；不把该分类照搬成模型 continuation。
- 客户端无法写入状态、进程退出或外部 writer 未确认时，不能用本地标记归零推断持久状态或远端资源已完成。

## 本项目的最小采用与验收方向

| 失败阶段 | 状态与恢复动作 |
|---|---|
| 接纳/child/provider 失败，模型从未启动 | 保留 workflowId、输入与失败阶段；复位启动标记，进入明确可修正状态；原业务重走接纳后首次 dispatch |
| child 返回但本次启动被取消/失去 owner | 创建者清理该返回资源，等待原 start 与 cleanup settle；不发送模型回合 |
| 原模型已开始，失败可恢复 | 保留同 child/thread 和回合恢复 marker，按既有 continuation 屏障继续 |
| 原 writer 是否终止未知 | 保存同 owned pair 与 cleanup owner；确认前禁止新接纳/替代模型 |
| 已成功但下游状态提交/校验失败 | 保留成功 checkpoint，恢复下游；不重复模型调用 |
| 取消、stop、记录持久化失败 | 原记录的合法落点与清理错误分别可见；旧 finally 不能覆盖替代 owner，也不能伪报全部收尾成功 |

建议使用原 workflowId 回归：第一次 provider 启动拒绝时模型零调用、记录可寻址且稳定、本次临时运行态清理；provider 修复后原记录再次接纳成功；历史 running/started 不阻止合法重试。另测 child 迟到返回、状态写入拒绝、cleanup 拒绝、cancel/stop 与 owner 变化，计真实调用并区分模型从未开始和已有原 turn 的情况。

关联规则见 [输入门禁](github-review-evidence-admission-patterns-2026-10-06.md)、[异步资源归属](github-async-resource-adoption-patterns-2026-10-06.md)与[成功结果 checkpoint](github-review-checkpoint-patterns-2026-10-06.md)。本文只记录固定源码事实与采用方向，未对当前共享工作区实现、全部门禁或 DSH UI 作通过声明。

[b-license]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/LICENSE
[p-license]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/LICENSE
[b-retain]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/child-pool.ts#L40-L87
[b-remove]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/child-pool.ts#L90-L111
[b-sandbox]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/sandbox.ts#L20-L179
[b-process]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/worker.ts#L1050-L1128
[b-failed]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/worker.ts#L1195-L1236
[b-move]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/job.ts#L735-L820
[b-retry-policy]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/job.ts#L706-L721
[b-retry]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/job.ts#L1229-L1243
[b-run]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/worker.ts#L612-L640
[b-test]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/sandboxed_process.test.ts#L1823-L1881
[b-fixture]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/fixtures/fixture_processor_fail_init_once.js#L17-L24
[b-pre-fork-test]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/child-pool.test.ts#L119-L138
[p-init]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1178-L1279
[p-crash]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L892-L899
[p-async-crash]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1611-L1622
[p-finally]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1281-L1294
[p-async-finally]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L2022-L2037
[p-start]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/src/prefect/flow_engine.py#L1302-L1351
[p-test]: https://github.com/PrefectHQ/prefect/blob/86cbe02fe1932964852dba7ef9eb2ab497ee85c9/tests/test_flow_engine.py#L2631-L2690

