# 恢复句柄的原始身份与 attempt fencing 核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取 Temporal 的固定客户端与服务器源码。选取一个有明确定位语义、当前任务验证和测试的强案例；机制不同于此前 Activity 结果重放。本轮只新增本文，没有修改其它文件、运行上游测试/服务、调用模型或操作正式 DSH。

## 结论与来源

恢复句柄需要绑定原始业务身份，再以当前 attempt/token 验证一次执行的所有权。当前记录仍处于 waiting、当前 thread 可寻址，都不能独立证明它仍对应原任务和配置。status 的可恢复判断与 resume 的执行接纳应共用同一身份规则；读取当前记录时不得重建“原始”基准，掩盖 task/model/scope 已变化。

独立调研不承担本仓库故障复现。主任务随后实测的 Reviewer identity 红例与修复见[第二十三轮记录](../iterations/2026-10-06-twentythird-reviewer-recovery-identity.md)。下述原任务/模型/evidence 签名是本插件的核验方向，不是 Temporal 自动提供的内容比较功能。

| 固定来源 | 固定提交 | 许可 |
|---|---|---|
| temporalio/sdk-typescript | `8161cd1cac3567fa4722b9754c33328cb917154b` | [MIT][sdk-license] |
| temporalio/temporal server | `4db93cd73eb12f4aa12e244f6419b506cbd35dc0`，提交时间 2026-10-05 17:31:02 UTC | [MIT][server-license] |

## 原 execution 身份不能由最新记录替代

**Evidence。** SDK 的 [getHandle][handle]明确区分只传 workflowId 的最新 execution、传 runId 的指定 execution，以及 firstExecutionRunId 的 execution chain。获取 handle 本身不验证目标存在；后续操作才会返回不存在错误。

[firstExecutionRunId 选项][chain-option]的范围是某些 control 方法。[cancel 请求][cancel-client]传该字段，server 在[实际 workflow lease callback][cancel-server]比较原 chain ID，运行中的不同 chain 拒绝为 WorkflowExecutionNotFound。与此同时，[query 请求][query]只使用 workflowId/runId，没有传 firstExecutionRunId；不能把 control 的 chain guard 宣传成所有 status/query 都已绑定原 execution。

**Finding。** 上游 [workflow ID conflict policy 测试][sdk-test]保存带原 runId 的 handle，再以 TERMINATE_EXISTING 建立同 workflowId 的新 execution；原显式 handle.describe 仍显示原 run TERMINATED，新 handle 显示不同 run RUNNING。USE_EXISTING 则断言同 run。此 integration 测试只阅读，未在本地执行。

**Path 与边界。**

- 原 Reviewer 创建/采用时捕获其 scope/config identity；失败等待后查询 status 和执行 resume 都对照该基准。
- workflowId 相同只说明业务名字相同。query 指向最新 run 的默认语义不能用于本项目原 ephemeral thread 的恢复。
- firstExecutionRunId 标识 chain，允许同一 chain 中的 run 变化；本项目要求同一 thread/child 时必须再核精确句柄，不能借 chain 跟随新 run。
- 此来源不比较任务文本、模型/effort、cwd、计划或文件 fingerprint；这些条件必须由项目自己定义和保存。
- server 对已完成 cancel 可先返回幂等 noop；该 control 语义不构成任意旧句柄仍可执行模型的授权。

## 当前 attempt/token 在服务器 lease 内再验证

**Evidence。** [NewWorkflowTaskToken][token]包含 namespace/workflow/run、scheduledEventId、startedEventId/time、attempt、clock/version。服务器 [completion 接纳][admit]先按 token 的 workflow key 获取带一致性检查的原 workflow lease，再从当前 mutable state 取该 scheduled task；缓存缺失且 event ID 超前时要求重新加载。

[当前 task 验证][validate]在命令接纳前核查 execution 仍 running、task 存在且已 started、started identity/time、attempt 与 version。任一不满足则 NotFound；源码明确该位置未修改业务 mutable state。started/time/version 的部分比较以 token 字段非空为前提，不能说所有 legacy token 都具备相同强度。

**Finding。** 上游 [已完成与未开始 task 测试][notfound-test]向实际 history handler 提交旧/不合法 token，断言 NotFound；[stale cache 测试][stale-test]把 scheduledEventId 改为 4，读取持久状态两次后仍拒绝。它们使用真实 handler/mutable-state 逻辑和 mock persistence，不是本轮真实服务运行。

[分页 completion 测试][pages-test]在原 task 超时或 workflow 关闭后，按原 scheduledEventId/attempt 请求合并迟到 final page，断言 WorkflowTaskCompletionBufferLost。它证明过期 attempt 的部分结果不能默默合并到新执行；不证明 DSH 原任务文本或模型设置已被比较。

**Path 与边界。**

- immutable original identity 与 mutable attempt 分开保存。合法 continuation 更新 attempt/token 时，不改变原 task/config 基准。
- status 读操作先验证原 identity，再报告句柄/确认屏障可用性；resume 还须在领取 handle、每个 await 后和 SQLite 接纳 mutation 内复验当前 owner/attempt。
- task token 验证发生于服务端原 workflow lease 下；仅比较一个本地 snapshot 不提供等价的并发保护。
- scheduled task/version/clock 不等于模型配置 fingerprint，也不锁 live FS；已有 fingerprint 门禁仍需在恢复前与结果提交时运行。
- completion 接纳不代替取消 ACK/远端终止确认。旧 callback、未知 writer、进程丢失的 ephemeral thread 不得因记录仍 waiting 被替换。

## 本项目的最小身份契约与验收方向

| 层 | 捕获或验证的项目 | 处理原则 |
|---|---|---|
| 原始业务与配置 | 原 workflowId、session、cwd、task、mode/origin、createdAt、原 reviewerModel/effort、实际消费的计划/输入及证据基准 | 原句柄采用时捕获，后续不从变更记录刷新成“原始”身份 |
| 当前运行所有权 | 当前 phase/retry stage、reviewAttempt、原运行对象与实际 lease token/epoch | 每次接纳核查；合法转换只更新当前 attempt/token |
| status 可恢复性 | 当前记录仍匹配原基准，原 thread/child 存在，原中断确认条件满足 | 不匹配明确 unavailable 原因，不报告可直接继续 |
| resume 执行 | status 同规则，加 claim/CAS/await 后复验与当前 evidence freshness | drift/失去 owner 时拒绝，不发送模型、不消费周期、不重建替代线程 |
| claim 后仅 caller abort | 原身份未变化且原运行未开始新回合 | 恢复同一 retained 对象/归属，避免旧 finally 释放原 thread 或改写 DTO |

建议复现模型失败进入 waiting 后逐项改 task、cwd/session、mode/origin、model/effort、计划/证据和 attempt/token，再检查 status 与 resume 是否一致拒绝；整行/revision、不变模型调用次数、原 thread/child 身份与 lease 归属需精确断言。合法仅 attempt 更新的续跑仍复用原句柄；查询不得产生写入。另测 status 返回后到 claim/CAS 之间的 drift，以及 claim 后 caller abort，防止错误刷新 baseline 或无归属清理。

关联研究见 [动作路由](github-workflow-action-routing-patterns-2026-10-06.md)、[成功结果 checkpoint](github-review-checkpoint-patterns-2026-10-06.md)与[异步资源归属](github-async-resource-adoption-patterns-2026-10-06.md)。本文没有宣称本地缺陷已复现、生产修复完成或全部门禁通过。

[sdk-license]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/LICENSE
[server-license]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/LICENSE
[handle]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L1960-L1988
[chain-option]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L405-L416
[cancel-client]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L1706-L1717
[cancel-server]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/requestcancelworkflow/api.go#L26-L86
[query]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/client/src/workflow-client.ts#L1818-L1835
[sdk-test]: https://github.com/temporalio/sdk-typescript/blob/8161cd1cac3567fa4722b9754c33328cb917154b/packages/test/src/test-integration-workflow-start.ts#L50-L118
[token]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/common/tasktoken/token.go#L9-L30
[admit]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/respondworkflowtaskcompleted/api.go#L122-L158
[validate]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/respondworkflowtaskcompleted/api.go#L203-L212
[notfound-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/history_engine_test.go#L1113-L1187
[stale-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/history_engine_test.go#L1295-L1347
[pages-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/respondworkflowtaskcompleted/api_test.go#L1158-L1247
