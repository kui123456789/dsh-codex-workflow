# 持久记录创建与执行接纳之间的失败边界核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取固定公开源码。选取 Inngest 的分阶段状态创建/入队补偿，以及 BullMQ 单 job 的保存/入队脚本；机制不同于此前的结果 checkpoint 和重复任务身份研究。只新增本文，没有修改生产源码/测试/其它文档、调用模型或操作正式 DSH。

## 结论与证据范围

持久记录已创建，不代表执行已接纳；请求中止也不代表记录、租约或入队副作用没有发生。创建归属、业务记录身份、执行 lease 与真实模型 thread/turn 应分别核实。在模型尚未启动时，接纳失败应留下可查询且可再次接纳的原业务状态；已经属于原业务的资源或替代 owner 不能被迟到创建者清理。

本调研任务只读取固定上游事实，不承担本仓库故障复现。随后主任务实测 `createReviewOnly 保存 reviewing → await admitReview` 的本地红例与修复，见[第二十一轮验证记录](../iterations/2026-10-06-twentyfirst-review-only-creation.md)。上游机制和本地验收的证据范围分别记录。

| 案例 | 固定提交 | 固定许可 |
|---|---|---|
| inngest/inngest server | `6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a` | [SSPL-1.0][i-license]，含[第三周年生效的 Apache-2.0 future grant][i-future]；未将当前固定版本标成 Apache-2.0 |
| taskforcesh/bullmq | `71c9ca72f32108e21f8d339b95ff750606806f60` | [MIT][b-license] |

## Inngest：两域提交需要按实际创建归属补偿

**Evidence。** [schedule 创建分支][i-create]先检查 skipped，再调用 smv2.Create；只有本次真正创建新状态时 `stateCreated=true`。已有 identifier 会解析到实际原 run 身份；状态已 tombstone/GC 的情况另行拒绝。

随后以 function + idempotency key 构造[原执行 queue item][i-queue-key]，在另一步 [Enqueue][i-enqueue]。重复入队时，仅在本次新建状态的情况下核查队列实际 owner RunID：同 run 保留状态，别的 run 或没有可验证 owner 时才清本次新状态。永久 shard 路由失败也只删除本次新状态；Delete 失败返回其错误。普通 enqueue 错误，包括无法证明提交与否的请求错误，走 default 返回，不执行同样的删除补偿。

[状态 New 的幂等检查][i-cross-slot]明确在 run-state 创建脚本之外：state 按 run ID 分片，幂等 key 按 account 分片，cross-slot 限制使两者不能直接合并事务。[SET NX GET EX][i-reservation]把创建保留键绑定原 RunID；[new.lua][i-state-lua]另行保存 metadata/steps/events。这个保留键是幂等身份映射，不等于执行 lease、owner fencing 或模型活动证明。

**Finding。** 上游 [TestScheduleQueueShardNotFoundCleansFreshState][i-routing-test]有删除成功、状态已不存在、删除失败三个条件：实际 executor 调用配脚本化 state/queue，断言 Delete 一次及原路由/清理错误分类。[FastPath 调度测试][i-fast-test]覆盖 durable enqueue 成功、失败、duplicate，以及通知采用最终 backend item 与原 request/metadata snapshot；失败/duplicate 不发成功通知。测试仅阅读，未执行。

**Path 与边界。**

- 创建段必须记住自己是否创建了资源，失败补偿比较实际 identity/owner；不能只因自己曾尝试创建就删除原合法任务或新 owner。
- 记录与执行接纳跨两个事务/服务时，显式保存可重试阶段、原因和原 identity；恢复入口重新核查当前 owner、相位、输入与真实 lease。
- 已有相同幂等 key 只定位原 run，不能证明输入一致、已入队、正在执行或模型可继续。TTL 到期也不证明旧 writer 已终止。
- Inngest 默认 enqueue 错误仍可能保留状态；这里没有证明任何 abort 都会自动落到稳定可重试状态。清理用独立 context 也不保证存储可用或清理成功。
- 上游 routing 测试没有运行 Redis，不证明跨进程故障恢复或两个提交之间崩溃时的最终状态；owner 相同/不同的 duplicate 分支由源码支持，不冒领为本轮完整集成测试。
- 本项目需要保留可发现的原 workflow；不能照搬删除新 run 的策略，把已向用户提供或可查询的原业务句柄抹掉。

## BullMQ：单 job 保存与入队在同一脚本接纳

**Evidence。** [addStandardJob][b-script]先校验 parent key，缺失时返回 -5；通过后处理身份、保存 job、推入 wait 列表并发 waiting 事件。[storeJob][b-store]写数据与 added 事件，[addJobInTargetList][b-wait]写队列与调度 marker。这条成功路径将单 job 的记录和入队交给一次服务器脚本，避免两个独立客户端 await 之间暴露仅保存了半个提交的正常中间状态。

**Finding。** 上游 [缺 parent 测试][b-missing-test]明确等待 add rejection，随后读取 `orphan-child-id`，断言 job 不存在。[addBulk 部分失败测试][b-bulk-test]同时包含有效 job 与缺 parent 的 job，断言有效项存在、无效项不存在，成功项 ID 映射正确。测试已阅读，未执行。

**Path 与边界。**

- 能在本项目已有 SQLite 事务中完成的记录相位、创建意图与实际 lease 接纳状态，应放进同一受 owner/token guard 保护的 mutation；不要先宣称 reviewing/running 再依赖另一次 await 取得执行权。
- Lua 的隔离执行不等于遇到运行时错误自动回滚之前所有 Redis 写入。缺 parent 用例靠前置拒绝防止保存；bulk 用例还明确不保证整批全有或全无。
- 脚本提交 queued/waiting 不等于用户 processor 已开始；客户端未收到返回也不能断言脚本未执行。该边界不能直接合并外部 DSH child 创建或 App Server RPC。
- 队列去重/脚本 key 没有自动验证本项目 caller 权限、输入/evidence freshness 或当前工作区；业务门禁仍需本项目实现。
- 该来源没有演示本项目 SQLite `save→admitReview`、原 workflow retry、模型零调用或原 thread 不替换的场景。

## 本项目的最小核验与状态原则

| 窗口 / 条件 | 原记录与资源的原则 |
|---|---|
| 创建尚未提交 | 校验当前输入与 caller；失败不发布 running/模型恢复状态 |
| 记录已提交，执行尚未接纳 | 保留 workflowId 与 creation identity；显式可再次接纳的业务相位，当前取消/停止/归属失败原因可查 |
| 接纳失败或 caller abort | 事务内重核原 owner/context 与创建 token；仅收尾本次取得的 lease/临时资源，不覆盖替代记录 |
| 接纳已提交，caller 未收到返回 | 按实际 durable 状态与 ownership 决定恢复，不能按调用者的 rejection 盲目再创建 |
| 同原业务再次接纳 | 使用同 workflowId，复验当前输入/evidence/phase/lease；模型从未启动时才执行首次 dispatch |
| 原模型已开始或终止未知 | 保留同原 thread/turn/child 与 cleanup owner，确认前禁止替代；已有成功结果按 checkpoint 路径恢复 |

建议先用可控边界复现：保存原记录之后、lease/CAS 接纳之前分别注入 abort、denied、stop、owner/phase 变化和接纳事务失败。断言原记录可寻址、未留下虚构 reviewing/running、模型/thread/child 为零；原业务修正后可以再次接纳；整行/revision、实际 lease owner/epoch/until 的断言区分没有取得资源与取得后释放。再测“接纳成功但响应丢失”，防止错误补偿或重复业务身份。

这组原则借鉴事务接纳与按创建归属补偿，不复制框架依赖，也不把通用幂等 key 当模型同会话恢复凭据。关联边界见 [启动状态收尾](github-startup-state-finalization-patterns-2026-10-06.md)、[输入门禁](github-review-evidence-admission-patterns-2026-10-06.md)与[异步资源归属](github-async-resource-adoption-patterns-2026-10-06.md)。

[i-license]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/LICENSE.md
[i-future]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/LICENSE.md#L561-L567
[b-license]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/LICENSE
[i-create]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/executor.go#L1531-L1585
[i-queue-key]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/executor.go#L1722-L1748
[i-enqueue]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/executor.go#L1821-L1923
[i-cross-slot]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/redis_state.go#L253-L295
[i-reservation]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/redis_state.go#L398-L438
[i-state-lua]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/state/redis_state/lua/new.lua#L20-L56
[i-routing-test]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/schedule_queue_shard_test.go#L23-L110
[i-fast-test]: https://github.com/inngest/inngest/blob/6a2b98ccc6c0dc661b0f3eb74f4e3013d7d2e11a/pkg/execution/executor/schedule_fast_path_test.go#L24-L118
[b-script]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/addStandardJob-9.lua#L74-L125
[b-store]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/includes/storeJob.lua#L29-L35
[b-wait]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/includes/addJobInTargetList.lua#L8-L10
[b-missing-test]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/flow.test.ts#L6498-L6524
[b-bulk-test]: https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/tests/flow.test.ts#L6461-L6494
