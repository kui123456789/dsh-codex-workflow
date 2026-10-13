# 工作流状态驱动外部动作的合法路由核验

核验日期：2026-10-06。使用 Agent Reach 的 GitHub／`gh` 后端读取一个与当前问题直接相关的状态机案例：XState 的当前状态转换、非重入 invocation 与迟到结果过滤。只记录固定源码机制，不复制框架、引入依赖、修改其它文件、调用模型或操作正式 DSH。

## 结论与固定来源

外部 nudge/control 事件只能提示重新核查当前状态，不能单凭旧 phase/event 决定新建 Planner/Reviewer。等待用户输入、同线程等待恢复、启动条件可修正和已有 owner 正在运行需要不同动作；恢复元数据、mode、origin 与原句柄决定具体合法入口。

| 案例 | 固定提交 | 固定许可 |
|---|---|---|
| statelyai/xstate | `38dcaffb20ec7f3cbb10e6161d8f0ebacca33701`，提交时间 2026-10-04 15:04:14 UTC | [MIT][license] |

选择这一例是因为它同时有“查询不 dispatch”“当前状态 guard”“不重复 invocation”“退出后迟到结果过滤”的源码与测试；没有再增加只能提供一般描述的第二框架。以下上游测试仅阅读，未本地执行。独立研究不承担本仓库复现；主任务随后验证的本地红例、修复和门禁见[第二十二轮记录](../iterations/2026-10-06-twentysecond-turn-stopping-routing.md)。

## 从当前状态选择动作，查询不执行 action

**Evidence。** [MachineSnapshot.can][can]取当前 snapshot 的 transitionData，仅当存在 target 或 action 时返回可接纳；[StateMachine.getTransitionData][transition-data]以当前 snapshot.value 解析状态节点。[StateNode 转换选择][guards]逐项以当前 context/event/snapshot 计算 guard，首个通过者才被选中。

**Finding。** 上游 [.can 测试][can-tests]覆盖 unknown event 与 guard=false 时 false、guard=true 时 true；同组明确调用 `can(SPAWN)` 后 actor 没有 spawn。这证明动作可用性查询没有执行 transition action，适合展示恢复按钮/生成下一步指令前的判断。

**Path 与边界。**

- 以当前记录推导明确 action，再调用其合法入口；不能把 `phase=executing/fixing` 直接翻译成“开始新审查”。
- can 会运行 guard；用户编写的 guard 仍应保持纯判断。本例不提供数据库 owner 锁，也不保证 query 与实际 dispatch 之间跨 await 不变。
- can 本身没有检查 actor processing status，不能独立证明 actor 仍运行。[send 的 stopped 分支][stopped-send]另行拒绝事件。产品级 routing 也要单独检查 stop/cancel、原 owner、句柄可用与实际 lease。
- 继承转换或 wildcard 的配置会影响事件接纳；只有声明具体状态与 guard 才能拒绝错误动作，框架不替业务定义 waiting/retry 的语义。

## 正在运行时不重新 invoke，退出后过滤迟到结果

**Evidence。** [actor.start][start]对已 Running actor 直接返回。[状态退出][exit]先执行原 state 的 exit actions 和 invoke stopChild。[invoke 完成事件配置][event-id]绑定 `xstate.done.actor.<invoke id>`；[Promise actor][promise]只在 active 时开始，stop 请求 abort，then 的 resolve/reject 回调重新检查该 actor 的当前 status，非 active 不再 relay 结果。

**Finding。** [非重入测试][no-reinvoke]发送两次 UPDATE，action count 增加，而 invokeCount/entry count 仍为 1、dispose count 为 0。[立即退出测试][no-start]进入后同一轮 microstep 离开的状态不会启动其 actor。[迟到 snapshot 测试][late]先 deactivate，之后 Promise 才完成，inactive 状态未收到旧 snapshot。[独立 signal 测试][separate-signals]用同逻辑创建两个 actor，取消 p1 后分别 resolve，p1 保持 canceled、p2 完成。

**Path 与边界。**

- owned-running 的 nudge 不应重入创建流程；更新提示或等待原运行结果即可。重复事件不创建第二次模型任务的保证仍需要本项目的 admission/owner 检查。
- 已退出状态的原异步回调应重新核当前 owner/attempt/句柄；只凭回调携带的旧 phase 不能提交结果或生成新动作。
- Promise actor 的停止只发 abort 并丢弃迟到结果，未等待外部 Promise/远端 writer 真正停止。不能照搬为资源释放、模型 ACK 或安全 replacement 的证明。
- invoke id 是事件路由描述符，不是跨进程身份/权限证明。人为构造事件、复用 id、新 generation 或 wildcard 仍需要本项目自己的 owner/token/attempt guard。
- 未处理的 actor error 在[macrostep 分支][unhandled-error]可使状态机 error；不能概括为所有迟到/未知 error 都被忽略。
- 这些测试不含 DSH、持久 workflow、Planner/Reviewer thread 或 Token 开销，不能代替本项目入口复现。

## 本项目的路由核验表

下表是本项目应验证的行为，不是 XState 内置状态名称或对当前实现的通过声明。每次外部 nudge 后读取当前记录和进程运行态，再决定动作。

| 当前条件 | 合法动作 / 指令边界 |
|---|---|
| waiting_input，确有原澄清问题 | 展示原问题并接纳用户回答；在原业务与原句柄上执行 continue，不重做 start |
| processState=waiting + reviewing/planning retry marker | 检查原进程句柄与中断确认；指向原 workflow resume，同线程继续；不能由 parent 自行交付替代计划/审查 |
| 模型从未启动的 startup/admission failure | 保留原 workflowId，说明缺项/失败原因；修正后走原业务首次 dispatch，不虚构模型 continuation |
| owned-running / 已有 foreground或background owner | 查询/等待原操作，必要时只更新提示；不重复创建，不接管另一 owner |
| review_only 模式的执行或修复相位 | 使用该模式明确的原审查入口；不输出适用于 planned 执行阶段的泛化修改/重审指令 |
| cancelled、stopped、owner/attempt变化、证据失效 | 拒绝旧 action，读取最新状态；旧 event 不使记录复活或启动替代任务 |
| durable queued 但 caller 未收结果 | 跟随原提交生命周期与 origin；调用 rejection 本身不能授权新业务身份 |

建议在真实 onTurnStopping/工具入口注入等待恢复的记录、review_only 模式与旧 phase nudge，断言产出的指令明确选择 resume/continue/review/status 等当前合法通道，workflowId 与原句柄不变；重复 nudge 时模型/thread/child 创建计数不增加。事件生成后改变 owner/attempt/phase，再调用入口必须被当前 guard 拒绝。native cancellation 未确认时输出可查诊断，不能提示 parent 重新 start 或自行收尾。

关联边界见 [输入门禁](github-review-evidence-admission-patterns-2026-10-06.md)、[持久创建与执行接纳](github-durable-creation-admission-patterns-2026-10-06.md)与[异步资源归属](github-async-resource-adoption-patterns-2026-10-06.md)。工作区不被锁定；进程丢失的 ephemeral 原线程不能因状态路由而被重建。

[license]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/LICENSE
[can]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/State.ts#L305-L321
[transition-data]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/StateMachine.ts#L355-L369
[guards]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/StateNode.ts#L426-L475
[can-tests]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/state.test.ts#L280-L370
[stopped-send]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/createActor.ts#L732-L749
[start]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/createActor.ts#L515-L520
[exit]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/stateUtils.ts#L1516-L1525
[event-id]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/stateUtils.ts#L351-L367
[promise]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/actors/promise.ts#L144-L218
[no-reinvoke]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/invoke.test.ts#L577-L621
[no-start]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/invoke.test.ts#L2772-L2837
[late]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/invoke.test.ts#L1321-L1361
[separate-signals]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/test/actorLogic.test.ts#L292-L349
[unhandled-error]: https://github.com/statelyai/xstate/blob/38dcaffb20ec7f3cbb10e6161d8f0ebacca33701/packages/core/src/stateUtils.ts#L1725-L1743
