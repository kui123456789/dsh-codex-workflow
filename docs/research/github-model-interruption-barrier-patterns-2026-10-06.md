# 通用模型中断确认屏障与 Bridge 续跑核验

核验日期：2026-10-06。通过已读 Agent Reach 的 GitHub / `gh` 后端读取 Tokio 新案例，并重新确认官方 Codex 固定提交。研究区分“本地等待结束”“本地任务终止”和“原 server model turn 终止已确认”；本轮只借鉴机制，没有复制代码、引入框架、运行上游测试或操作正式服务/模型。

Bridge 审查没有原生澄清答案也会遇到 timeout/abort。它仍需要原 thread/turn 的确认屏障，不能把普通 timeout 文本送入自动 continuation 后，立刻在原 thread 增加第二个模型 writer。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 可核验机制 |
|---|---|---|---|
| tokio-rs/tokio | `b2636752450484955e7ad334bac678424d51bc4a` | [MIT](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/LICENSE) | abort 只请求取消，join 读取完成状态后才返回任务结果 |
| openai/codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | 正常原 turnId 的 interrupt 请求登记后，等待 TurnAborted 才回复 |

许可由固定文件核验，Codex commit API 已重新确认。本轮 Codex 引用针对普通模型 turn 的确认，不以[第十四轮原生答复](github-return-and-cancellation-patterns-2026-10-06.md)的 local waiting 状态替代它。

## Tokio：取消请求与任务完成读取分别实现

**实际源码。** [JoinHandle L227-L236](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/join.rs#L227-L236) 的 abort 调用 remote_abort；调用 abort 后 is_finished 仍可为 false。[harness L118-L126](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/harness.rs#L118-L126) 设置取消/通知状态并 schedule 任务，未直接将结果置为完成。

[JoinHandle Future L324-L353](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/join.rs#L324-L353) 读取任务输出；[harness L281-L284](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/harness.rs#L281-L284) 只在 can_read_output 允许时返回 Ready。[L422-L463](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/harness.rs#L422-L463) 对未完成任务登记 waker 并保持等待。其 [公开合同 L25-L27](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/join.rs#L25-L27) 保证观察到任务完成之前，任务析构已结束。

**借鉴与边界。** 资源复用前应等待拥有该资源的操作进入已确认终态。Tokio 这里证明的是同 runtime 的本地任务完成；它的 join.await、JavaScript Promise settled 或 ToolRuntime 等待工具清理，都不证明远端 App Server model turn 已终止。[L185-L193](https://github.com/tokio-rs/tokio/blob/b2636752450484955e7ad334bac678424d51bc4a/tokio/src/runtime/task/join.rs#L185-L193) 还明确取消可与正常完成竞争，已经运行的 spawn_blocking 也不能靠 abort 停止。本项目不引入 Tokio 或套用其本地任务保证。

## Codex：明确原 turn pair 的远端确认

**实际源码。** [turn_interrupt_inner L1599-L1627](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L1599-L1627) 以 threadId/turnId 查原任务、检查目标 active turn，再登记 pending interrupt 请求。[L1635-L1649](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/turn_processor.rs#L1635-L1649) 对正常 turn 的提交成功不立即回复；空 turnId 的 startup 请求是独立的 submission acknowledgement。

[TurnAborted L1203-L1219](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1203-L1219) 先清旧 pending，再通过 [L1563-L1575](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1563-L1575) 回复登记的 interrupt。正常 turn 的 RPC 成功具有这个固定实现的终止确认语义。

**借鉴与边界。** 自动 backoff/continuation 的 model admission 应要求原 pair 终态已确认。SDK 请求已超时、signal 已 aborted、客户端已删 waiter、best-effort helper 已返回，都不是该确认。实际安装 port 的确认及已观察原 pair 的终态条件由本仓库回归验证；本轮不从错误字符串推断任意 thread/turn，也不引入未公开查询 API。

## Bridge 的定向观察与本轮接入点

最初只读 [app-server-callback.ts](../../src/app-server-callback.ts) 后，root 接入了匹配原 Reviewer 的 typed marker；以下分别记录原路径与当前接入点：

| 入口 | 观察到的行为 | 通用 typed unconfirmed 的最小处理点 |
|---|---|---|
| visible startVisibleTurn 的 catch | 原路径清 active map 后按文本决定首次自动 continue | 本轮先检查 typed error；匹配原 Reviewer 时保留，不匹配时明确拒绝，禁止进入文本 timeout 重试 |
| 外层 run catch | 普通 timeout 转 waitInThread；rewrite/conversion 抛出的错误也到这里 | 本轮先识别 typed error，原 pair 保留 validatedText，foreign pair 明确报错 |
| RetainedReviewer / waitInThread | 原先保存 thread、signature、visibleText 和原 release closure | 本轮增加进程内 interruptionTurnId，与原 thread 构成待确认 pair；保留原 pin/ref/subscription |
| 下次 retained run | 原 thread 可用性已检查，claimed 后进入后续工作 | 本轮在 claimed + ensureRunning 后、authoritativeText 分支之前，先 cleanup 原 pair；未确认继续等待 |
| process lost / 请求变化 | 已有 lostSubmissions、retained signature 与原 thread 可用性拒绝 | 保留这些检查；未知 pair 或原进程失效不能静默落入 createReviewer |

最佳最小公共位置是 claimed 已成立、ensureRunning 已通过之后，进入任何 visible review/read-back/rewrite/conversion 之前。它覆盖只有 visibleText 的转换重试，也覆盖完整审查续跑；无需另造一个 Reviewer 调度框架。thread/create/configure/resume 的控制 RPC backoff 与模型调用屏障分别处理，不能将所有控制重试一概视为模型重发。

## CodexTurnInterruptionError 的处理合同

本轮使用的 [turn-interruption.ts](../../src/turn-interruption.ts) 区分以下情况：

- **已确认结束：** SDK 保持原 Error 诊断，现有“原 turn 已结束”的模型错误/backoff 行为继续遵循既有次数与预算。
- **结束未确认：** CodexTurnInterruptionError 保留原 cause/message 诊断及进程内原 threadId/turnId，供后续 cleanup；Bridge 先按类型拦截，不能只因 message 含 timed out 而自动启动模型。
- **只有文本或未知句柄：** 不解析/伪造地址，不把它降级成可以新建 Reviewer 的普通 busy 请求；明确报告原运行无法恢复或确认信息不足。

原 pair 不写入持久 JSON 以冒充跨进程恢复凭据。显示用的诊断前缀与 underlying cause 可分别保留；类型识别、句柄关联和确认布尔值不能从模型生成的文本猜测。

## 公共 admission 的建议顺序

1. typed error 返回时，验证 pair 属于本次受控模型调用，保存到同 submission/signature 的 RetainedReviewer；原可见文本、release closure 与资源归属保持。
2. 再次 send 时先解析原 retained handle 并校验请求、取消/停止、thread availability。存在待确认 pair 时，只尝试该 pair 的 cleanup RPC；插件不发新的 model start/review/conversion。
3. cleanup 未确认时继续等待，并保留同一 Reviewer 及 pair。确认成功后重核 latch、signature 和本 retained entry 的归属，才清除屏障并进入模型工作。
4. cleanup await 期间被取消、请求/owner 被更换或原 ephemeral process 消失时退出，遵循既有一次清理与 lost-submission 行为，不创建替代上下文。

这种持久 retry 重试的是 cleanup 资格，model request 计数在确认之前应为零；它不承诺 cleanup RPC 或服务端内部队列完全不会发生其他处理。模型 continuation 仍受已有自动次数、transient budget 和工作区证据门禁约束。

## 最小验收建议与限制

本轮新增 [callback-interruption-barrier.test.ts](../../test/callback-interruption-barrier.test.ts)，使用真实 CodexAppServerClient 和已冻结的本地 stdio 假 App Server。定向 **3/3 通过**，`pnpm typecheck` 通过：

- held ACK 时 send 尚未结束，原模型请求数为 1；释放失败后返回 retryable_busy 并保留原 Reviewer/pin。第二次 send 仍只重试 cleanup；再次失败不发新模型。确认成功后同 process/thread 返回 verdict，总共三个 SDK turn（初次可见审查、确认后的 continuation、结构化转换），writerConflicts 为 0，原 release/pin 各收尾一次。
- 等待 marker 时 cancel 使用原 thread/turn，重复 cancel 与 stop 不多发模型或重复释放原 claim。
- 原真实客户端回合先正常 completed，再在端口注入 foreign typed marker：即使原诊断含 timeout，仍明确拒绝，不新增 continuation/conversion/Reviewer，不清理猜测的 foreign pair；原 claim 收尾一次，未留下真正运行的模型 turn。

这些测试验证原 pair 路径和 foreign marker 的端口拒绝合同，不是生产 App Server、正式 DSH UI 或模型验收；foreign 场景也不是伪造实际 server 产生了外线程响应。不能将无法匹配的 typed error 当普通 timeout 放回自动模型重试，本文不扩大三例为全矩阵覆盖。

建议回归：普通可见 Reviewer timeout + unconfirmed；保留可见结果的 conversion timeout + unconfirmed；第一次 cleanup 失败后再次重试成功；false 确认前模型计数不增加且无新 Reviewer；true 确认保留原错误诊断；未知 pair、process lost、cancel/stop 不创建替代线程。断言同 thread/child、原 signature、原 pin/ref/release 一次，不用 fake hash 或新依赖代替驱动。

本地观察基于 `HEAD abb6174d283ced56590bee90b3511948e494b3f0` 加研究时共享工作区；CodeGraph 已先查询但索引不可用，随后只读这些入口。生产实现由 root 管理，本子任务仅新增研究与独立验收文件，没有修改生产源码或已有 fixture、操作正式服务或调用模型。SQLite/运行态归属检查不锁 live FS；ephemeral 原 pair 仅在当前进程可用。Agent Reach 更新检查时 v1.5.0 为最新，不推算 Token/费用。
