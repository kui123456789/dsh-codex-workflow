# 原运行有效配置与迟到进度写入的 fencing 核验

核验日期：2026-10-06。通过 Agent Reach 的 GitHub／`gh` 后端读取 Temporal 的配置保存与 heartbeat 接纳源码，并将 BullMQ progress 作为明确不具备同等保护的对照。只新增本文，没有修改其它文档/生产源码/测试、调用模型或操作正式 DSH；上游测试仅阅读，未执行。

## 结论与固定来源

原运行需要保存实际选定的有效配置，而不仅保存可能为空的用户请求字段。合法重试读取原配置；全局 fallback/default 变化不能悄悄改变已保留 run。另一方面，进度、elapsed、metadata、usage 等写入也属于结果接纳，失去 lease 的旧执行者不能依赖“仍有同 workflowId”继续写赢家记录。

本调研不代替本项目默认 Reviewer 配置变化、Bridge loser progress 的受控复现；主任务随后锁定的红例与修复见[第二十四轮记录](../iterations/2026-10-06-twentyfourth-settings-and-final-progress.md)。以下固定上游来源与本地验收的证明范围分别记录。

| 范围 | 固定提交 | 固定许可 |
|---|---|---|
| temporalio/temporal server | `4db93cd73eb12f4aa12e244f6419b506cbd35dc0` | [MIT][t-license] |
| taskforcesh/bullmq Redis progress 对照 | `71c9ca72f32108e21f8d339b95ff750606806f60` | [MIT][b-license] |

## Temporal：普通重试读取已保存的有效 Activity 配置

**Evidence。** [ValidateActivityScheduleAttributes][t-normalize]先验证并规范化 timeout/retry options，写回 schedule attributes。[ApplyActivityTaskScheduledEvent][t-snapshot]从原 scheduled event 保存 TaskQueue、ActivityType、timeouts、RetryPolicy 与 attempt=1 到 ActivityInfo。

[RetryActivity][t-retry]使用已保存 retry 参数计算 backoff，再调用 [UpdateActivityInfoForRetries][t-attempt-update]更新 attempt/version/schedule time、started state、failure 和 per-attempt flags；该普通路径不重新用全局默认填充上述原配置。[RecordActivityTaskStarted][t-start]读取原 scheduled event，同时从当前 ActivityInfo [返回 retry policy/attempt/heartbeat details][t-start-info]；稳定配置与会变化的执行元数据分别处理。

**Finding。** 上游 [默认 retry policy 测试][t-default-test]断言缺字段补默认、完整 policy 保持、部分配置仅补缺项。[MutableState retry 测试][t-retry-test]保存原 activity/type/queue/policy，调用 RetryActivity 后原 scheduled activity 的 attempt 变为 2、stamp 增加。[ActivityRetry 集成测试][t-poll-test]在两次 poll 中断言同 workflow 与 ActivityType，首次可重试错误后再执行第二次。

这些测试已阅读，未运行；没有找到并核实“修改 runtime defaults 后所有有效配置逐字段仍等于首次 snapshot”的完整测试。跨重试配置来源由上述源码链支持，不能把较窄的 type/attempt 断言扩大为全部设置的实测证明。

**Path 与边界。**

- 首次模型开始前解析 record 请求、manager fallback、App Server default 等实际选择，保存 effective model/effort 与原 run identity；状态查询和 resume 读取同一 snapshot。
- 原请求 model/effort 未指定与首次实际值是不同信息。仅比较两个 undefined 字段无法发现 resume 再读 fallback 后换了实际模型。
- 全局 defaults 的后续变更适用于新 run；已有合法 continuation 继续原有效配置。用户显式改变该 run 的输入/设置，应走既有 identity/freshness 冲突或新轮次规则。
- Temporal 的专用 update/reset/规则处理可以修改 Activity 状态；本文只讨论 ordinary retry，没有证明框架禁止所有配置变更。
- TaskQueue/ActivityType 是调度配置，不是 LLM model/provider；只借鉴规范化后保存及分层更新机制，不引入 Temporal 依赖。

## Temporal：heartbeat 写入前核当前 attempt

**Evidence。** [RecordActivityTaskHeartbeat][t-heartbeat]在原 workflow lease callback 中确认 workflow running、scheduled Activity 存在、token 与当前 task 匹配，然后才 UpdateActivityProgress。[token helper][t-token]核 started 状态、scheduled token 的 attempt、startVersion/version；不匹配返回 not found。[进度 mutation][t-progress]更新 heartbeat details、时间及 worker identity，因此这些 metadata 同样在接纳条件之后。

**Finding。** 上游 [attempt mismatch 测试][t-token-test]把原 token attempt=2 与当前 ActivityInfo attempt=3 比较，断言拒绝；改为相同 attempt 后接受。相邻测试还覆盖未 started 与版本不符。测试是 helper 单元测试，不是完整 late heartbeat/赢家整行不变的集成测试；完整接纳到写入顺序由 handler 源码支持。

**Path 与边界。**

- 本项目 progress/heartbeat/usage 的每个 SQLite mutation 都要比较原 scope、attempt、实际 lease owner/token/epoch 和当前可写阶段，不能只在长操作开始时核查。
- 已租约失败的旧回调应拒绝且不产生新的 revision/updatedAt；旧 finally 不覆盖新 owner 的 progress、error、timing 或 usage。
- Temporal 的 ByID 路径以空 scheduledEventId 定位当前 Activity，helper 因此不执行相同 attempt 比较；不能声称所有 heartbeat API 都具备原 token fencing。
- 版本比较有非空条件且允许兼容路径；它不检查本项目证据 fingerprint，也不锁 live FS。写入保护与模型取消 ACK 是独立边界。

## BullMQ progress：拒绝作为 lease fencing 正例

[Job.updateProgress][b-job]把 id/progress 交给 backend；[updateProgress Lua][b-progress]只检查 job key EXISTS，然后 HSET progress/XADD event。输入没有 worker lock token/epoch 条件。本固定 Redis 路径能更新存在的 job，但不提供本项目要求的迟到 loser 写入拒绝。

上游 [普通 progress 测试][b-test]覆盖数值/对象等持久更新及缺 job 报错；没有 token mismatch 场景。不能拿这些测试证明旧 worker 无法覆盖新 attempt，也不把 BullMQ 全部 backend 的行为概括成同一个实现。

## 本项目的最小采用与验收方向

| 对象 | 应保存/比较的事实 |
|---|---|
| 原 run settings | 首次实际选定 model/effort、原请求设置、配置来源及原 thread/child identity；不在 resume 时刷新成新 fallback |
| mutable attempt | 合法重新接纳后的 attempt/token/epoch；可变化但不得替换原 task/config baseline |
| waiting status / resume | 原 identity 与有效配置 snapshot 共用；缺 snapshot 的历史运行明确说明边界，不补造当时实际设置 |
| progress / elapsed / usage | 每次 transaction 内核当前 owner/token/phase；拒绝后整行与 revision 不变 |
| lease 丢失 / scope drift | 不提交旧 metadata，不消费审查周期，不用新模型/child 修补原 run |

建议受控测试：记录字段 model/effort 未指定、首次 runtime fallback 选择 A，等待后改全局 fallback 为 B；合法 resume 仍在原 thread 上用 A，status 不将 B 当首次基准。另在 loser gateway 的进度回调前由真实 coordination 替换 lease owner/epoch，再投递 progress/usage/finally，断言赢家整行、revision 和真实 lease 不变。正常 owner 的进度仍更新；调用计数区分原 native 回合、转换与新轮次。

关联边界见 [恢复身份 fencing](github-resume-identity-fencing-patterns-2026-10-06.md)、[动作路由](github-workflow-action-routing-patterns-2026-10-06.md)与[成功结果 checkpoint](github-review-checkpoint-patterns-2026-10-06.md)。本文不声称本地缺陷已复现、修复完成或全部门禁通过。

[t-license]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/LICENSE
[b-license]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/LICENSE
[t-normalize]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/command_attr_validator.go#L75-L138
[t-snapshot]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl.go#L4333-L4395
[t-retry]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl.go#L6939-L6972
[t-attempt-update]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity.go#L59-L90
[t-start]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/recordactivitytaskstarted/api.go#L139-L148
[t-start-info]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/recordactivitytaskstarted/api.go#L294-L310
[t-default-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/command_attr_validator_test.go#L661-L748
[t-retry-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl_test.go#L3261-L3327
[t-poll-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/tests/activity_test.go#L646-L672
[t-heartbeat]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/recordactivitytaskheartbeat/api.go#L41-L87
[t-token]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/activity_util.go#L58-L79
[t-progress]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl.go#L2110-L2127
[t-token-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/api/activity_util_test.go#L39-L50
[b-job]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/job.ts#L548-L556
[b-progress]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/updateProgress-3.lua#L4-L32
[b-test]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/job.test.ts#L371-L440
