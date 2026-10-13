# 原回合中断确认与公共返回归属核验

核验日期：2026-10-06。通过已读 Agent Reach 的 GitHub / `gh` 后端重新确认两个固定提交，并定向读取官方源码及许可。本轮研究取消请求与回合结束确认的区别，以及异步辅助工作之后的归属复核。只采用可核验的机制，没有复制实现、增加依赖、执行上游测试或操作正式服务/模型。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 本轮源码机制 |
|---|---|---|---|
| openai/codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | 非空原 turnId 的 interrupt 延迟到 TurnAborted 回复 |
| microsoft/vscode | `182f2f5bf96b741fd0212115400a32a2c5298c26` | [MIT](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/LICENSE.txt) | Chat 回调重取当前 model，异步清理只操作原 request |

固定提交存在性及 LICENSE 已核验。VSCode 本例是 ChatService 的会话/model 实例检查，与[第十三轮](github-planner-run-ownership-patterns-2026-10-05.md)的 inline 请求版本机制分别记录。

## Codex：取消令牌不等于原 server turn 已结束

**请求与确认。** [turn_processor.rs L1599-L1627](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L1599-L1627) 区分空 turnId 的 startup interrupt 和正常 turn interrupt；正常路径先检查 active turnId，拒绝错误目标，然后登记待回复请求。[L1635-L1649](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L1635-L1649) 中正常 turn 提交成功只返回 None，RPC 稍后回复；startup 提交成功立即返回 response。

**终止链。** Core [tasks/mod.rs L925-L956](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tasks/mod.rs#L925-L956) 先取消 CancellationToken，等待任务结束或宽限超时，再执行 abort cleanup；[L999-L1013](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tasks/mod.rs#L999-L1013) 随后发 TurnAborted。App Server [L1203-L1219](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1203-L1219) 先关闭原 thread 的 pending，再回复 interrupt；实际 response 发送见 [L1563-L1575](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1563-L1575)。

**可采用的边界。** 正常原 turn 的成功 interrupt RPC 是这个固定实现中 TurnAborted 之后的确认，能够用于更新旧 pending 的资格。调用者 signal 已中止、throwIfAborted 抛错、命令已发送或空 turnId startup response，都没有同样含义。RPC 成功回复和客户端随后观察到 UI turn/completed 的先后也应分别记录。

### 取消后的重试条件

| 已知事实 | 可接受的后续动作 | 需要保留的限制 |
|---|---|---|
| 原回合明确 completed/failed，原 thread 可用且原操作仍有资格 | 按既有模型恢复策略，在原 thread 上短 continuation | 保留业务设置、原 child 和失败次数上限 |
| 本地等待 abort/timeout，正常原 turn 的 interrupt 已确认 | 使用当前合法操作的新取消控制器继续或进入等待 | 旧已取消令牌不可复用；仍受全局 stop/cancel 和原归属约束 |
| interrupt 失败、超时或只做了 best-effort 请求 | 报告未确认状态，保留必要原运行信息 | 不把本地等待结束当作新 turn 资格，也不盲目 transient retry |
| App Server 退出，原 ephemeral 句柄失效 | 明确报告无法恢复 | 不 reconstruction 或新建替代 Planner |

第十一轮的[active turn/start 源码边界](github-native-input-interruption-patterns-2026-10-05.md)仍适用：active turn 上 turn/start 可 steer 原 turn，不能用它代替中断确认。取消令牌的局部状态只决定本地等待/调用权限；重试前还要确认原 server turn 状态，不能用 operation aborted 文本作为服务端确认。若之前已提交答案，中断等待不会撤销答案，后续不得重复回复旧 requestId。

固定上游源码证明上述回复顺序，实际安装版本与本项目 port 的确认语义仍需宿主/故障回归核验。本轮没有修改取消协议或 retry 策略。

## VSCode Chat：异步回调重新解析原会话对象

**会话身份检查。** [ChatService L1174-L1191](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts#L1174-L1191) 将派发推迟到 microtask；执行时重新从 sessionModels 取对象，并比较是否仍是捕获的原 model。请求完成后的 finally 再检查同一 model，才恢复 tracking。

**原请求清理。** [L2054-L2066](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts#L2054-L2066) 在 rawResponsePromise 完成后，只有 pending map 仍指向本次 cancellableRequest 才删除它，避免旧 finally 清掉新请求。

**适用建议。** 原业务动作返回以后，usage flush 或其他辅助 await 也会产生归属变化窗口。公共返回前用原调用者上下文重新授权/解析 owner，比较原 session/cwd/操作身份，再决定能补哪些字段；不要仅按 workflow ID 获取“最新记录”并替换整个已完成业务结果。

**边界。** 这个 VSCode gate 核验 model/request 实例，不能证明账号授权。DSH 的 dshSessionId、cwd 与公开工具返回策略需要在本仓库实现和回归中验证。本轮不迁移 VSCode 队列或 tracking 框架，也不把其每个异步入口都宣传为已有相同检查。

## 本项目当前返回与中断路径

本地观察基于 `HEAD abb6174d283ced56590bee90b3511948e494b3f0` 加研究时共享工作区。CodeGraph 已先查询但索引不可用，之后只读相关源码。以下是当前观察和候选验收范围，源码后续变化以主任务实际验证为准。

| 入口 | 研究时观察 | 最小建议/验收点 |
|---|---|---|
| [workflow.ts](../../src/workflow.ts) 的 interruptPlannerTurn | 使用原 thread/turn、线程可用性和 bounded cleanup 返回确认布尔值 | 未确认不能当作旧 pending 已关闭；测试中区分请求发出、RPC 完成与本地 signal abort |
| [app-server.ts](../../src/app-server.ts) 的 interruptBestEffort/abandonTurn | best-effort 捕获 interrupt 错误，随后本地 abandon 删除 turn 缓存 | helper Promise 完成不是可靠 server acknowledgement；自动重试前核验已确认的原回合终态 |
| workflow.ts 的 withObservedUsage | await flush 后仍 raw load，但当前已保留原 phase/result，只合并同 dshSessionId 的 observedUsage | 原先整份 latest record 替换会跨越 owner/phase 边界；这个风险已被当前计量投影收窄，不能再写成完整记录直接返回的现状 |
| 同一公共返回 wrapper | 辅助 await 之后的调用者授权、原 cwd/运行归属仍需按工具返回契约定义 | 将原 exec/期望身份带至返回边界；原归属失效时明确拒绝，不把新 owner 数据或未经约定的历史快照静默作为当前结果 |

计量更新属于辅助工作。公共返回保留已提交操作的业务结果，刷新时仅补经过归属核验的计量字段；相位/计划/问题/错误等业务字段不能借一次 raw load 被另一轮动作替换。是否允许归属变化后返回历史操作快照，也应由公开契约和测试明确，不能隐含在 fallback 中。

## 建议故障回归

- 阻塞 usage flush，在期间变更 store 的 dshSessionId/cwd，再解除：返回不得包含新 owner 内容，不能由计量刷新替换原业务结果。
- 原业务成功后只有同归属 usage 更新：业务字段逐项相同，只补允许的计量字段。
- wait abort/timeout 时，让 interrupt 延迟成功、失败或超时：成功确认前不发新的模型回合；未确认路径保留原线程而不创建替代。
- startup 空 turnId、错误 turnId 和正常原 turnId 分别验证；不要把 submission ack、取消令牌状态或吞错 helper 当成相同确认。
- 中断确认之后 owner/cwd/phase 或全局 stop 已变化：拒绝后续驱动和迟到返回，原 request 清理不删除其他操作的句柄。

这些是候选检查，不构成本项目完成、真实模型或正式 DSH 验收。SQLite 归属/CAS 检查不锁 live FS；本轮不改变模型设置、消费账本范围或费用口径。Agent Reach 更新检查时 v1.5.0 为最新版本。
