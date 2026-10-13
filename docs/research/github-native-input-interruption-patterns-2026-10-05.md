# 原生澄清请求的中断与 pending 清理核验

核验日期：2026-10-05。使用已读 Agent Reach 的 GitHub / `gh` 后端，重新查询并确认官方 Codex 固定提交 `823ea830c0fd418b09ff02d36cad9a1fff66465b` 存在，再读取两组定向源码。许可为 [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE)。没有复制实现、引入框架、执行上游测试或操作正式 DSH。

本轮关注未回答问题、回答后的等待中止与实际 wire interrupt 的区别。正常澄清 reply/followup 的两条路径见[第十轮研究](github-clarification-lifecycle-patterns-2026-10-05.md)，模型设置和通用线程身份不重复展开。

## 机制一：先让任务观察取消，再清理等待通道

**证据链。** Core [tasks/mod.rs L925-L956](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tasks/mod.rs#L925-L956) 先取消任务 CancellationToken，等待任务退出或宽限超时，再调用 abort cleanup。[L999-L1013](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tasks/mod.rs#L999-L1013) 产生 TurnAborted 事件并刷新终态记录。[L537-L560](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tasks/mod.rs#L537-L560) 在任务处理取消后清理 pending；源码明确避免等待通道提前关闭，被在途审批当作模型可见拒绝。

**发现与采用原则。** 本地等待者 abort、pending map 删除和服务端 turn 中断是不同事实。负责中断当前回合的路径应实际发送 interrupt，并使用 RPC 完成结果更新 pending 资格；不能仅因调用者 AbortSignal 已中止，就宣称原请求已关闭或开始新的业务回合。

**边界。** 不复制 Rust 任务调度、宽限超时或存储实现。本项目当前 SDK port 和隔离宿主回归负责验证本地状态与 wire 结果的对应关系；上游源码不是正式 DSH 已完成清理的运行证明。

## 机制二：先移除 wire pending，再确认 interrupt

**证据链。** App Server [TurnAborted L1203-L1219](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1203-L1219) 先 abort_pending_server_requests，再回复 pending interrupt 请求，之后处理 Interrupted 完成通知。[interrupt 回复 L1563-L1575](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1563-L1575) 发送 TurnInterruptResponse。

清理入口 [outgoing_message.rs L215-L229](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/outgoing_message.rs#L215-L229) 使用结构化 turnTransition 错误；[L598-L629](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/outgoing_message.rs#L598-L629) 按 thread 移除 callback，再结束等待者。[request_user_input 回答处理 L1642-L1678](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1642-L1678) 遇到 turnTransition 直接退出；普通 callback 错误或 receiver 丢失则走向空答案提交。这些分支不能混作同一种中断证明。

**本项目依据。** 本轮使用已经完成的 interrupt RPC 作为旧 wire pending 已关闭的依据，而不是本地等待者 abort。固定上游顺序中，RPC response 发生在 wire pending 移除之后；它不等于客户端已经观察到随后发出的 UI turn/completed，也不能替代其余生命周期与归属校验。

**active turn/start 边界。** 官方 [v2 测试 L739-L755](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/turn_start.rs#L739-L755) 在 active turn 上再次 turn/start，返回原 active turnId，即 steer。不能仅凭发出了 turn/start 就声称开启了新 turn。需要保留原等待时回复原 request；需要结束原回合时先正式 interrupt 并确认 RPC 完成，再由当前资格决定短 followup。

## 答案已提交之后的等待中止

| 观察到的事实 | 合法解释 | 不应推断 |
|---|---|---|
| 答案已提交，调用者停止等待 | 原回答不会因 wait abort 被撤销，服务端可能仍在执行 | 答案未发送、原 turn 已结束或可以重复回答 |
| interrupt RPC 成功完成 | 本轮将其作为旧 wire pending 已关闭依据，再更新本地状态 | 仅 AbortSignal 中止即可获得相同依据 |
| 原请求已无效，但终态/中断结果未确认 | 重新核验当前运行资格或明确报告状态 | 构造新 requestId、自动新建 Planner |

本项目的本地 turn.respond 仍是适配器名称，正常原生答复实际为原 requestId 的 JSON-RPC response。模型失败后的原线程继续与用户显式取消 workflow 保持各自生命周期。原 ephemeral 句柄丢失时，不用 Codex SDK 的持久会话 reconstruction 或另一个框架的 checkpoint 创建替代上下文。

## 验证范围

上游 [pending 清理测试 L1594-L1626](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/outgoing_message.rs#L1594-L1626) 检查 user_input waiter 收到取消错误且原 thread 的 pending 列表为空；本轮仅核验测试源码。项目的 before-RPC abort 红绿、宿主八个隔离场景及正式新临时会话验收见[第十一轮记录](../iterations/2026-10-05-eleventh-host-and-live-clarification.md)。

正式运行与最终门禁由主任务填写；这些源码案例不证明旧 workflow 已恢复，不提供跨进程 ephemeral 恢复保证，也不推算 Token/费用。研究结束时 Agent Reach 更新检查为 v1.5.0 最新；写本文档时没有再次联网或调用模型。
