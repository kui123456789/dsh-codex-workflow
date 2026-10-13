# 第十五轮：通用模型回合的中断确认屏障

## 实际问题与来源

第十四轮修复已提交原生答案后的继续机制，本轮检查普通 Planner、Reviewer 与 Bridge 回合。参考 [Tokio 和 Codex 固定源码](../research/github-model-interruption-barrier-patterns-2026-10-06.md)：取消请求不是任务终止证明，原远端 turn 的确认需要单独等待。本轮未复制实现、引入依赖或调用正式模型。

真实 `CodexAppServerClient` 接本地 stdio 协议夹具的初始组 **4 项中 3 项失败、1 项正常对照通过**。旧 `waitForTurn` 在 fire-and-forget abandon 后立即拒绝 caller；ACK 仍挂起时，原 remote writer 尚在运行。真实 Manager/SQLite/ChildSession 组初始同样复现 Planner/Reviewer 提前继续和取消竞争多发模型请求。

## 实施

- 模型 timeout/abort 先 await 原 turn interruption，再结束本地 waiter。已确认时保留原诊断和既有一次自动继续上限；未确认时返回 `CodexTurnInterruptionError`，保留 cause 与进程内原 pair。
- typed unconfirmed 前缀不进入 transient backoff 或自动模型 continuation。句柄字段不可枚举，不作为持久恢复凭据；不同 Reviewer pair 明确拒绝，不被 timeout 文本降级为普通 busy。
- Foreground Planner/Reviewer 将原 pair 保留在既有 waiting handle，manual resume 确认 cleanup、重核原 scope/owner/handle/cancel/stop 后，才再调用原模型线程。
- Bridge 保留同 submission/signature 的 Reviewer、文本、pin/ref 与释放 closure；后续持久 retry 先清理原 pair，转换失败重试仍可复用已取得的可见文本。取消/租约丢失/stop 优先收尾；caller-only abort 保留原 Reviewer供新 signal 恢复，首个 caller 仍收到中止。
- 迟到的原 terminal notification 也能确认结束，避免反复中断已结束 turn。cleanup 使用当前 child 的 raw RPC，不启动新进程；新进程清除旧 turn cache，旧 child 回调不进入新 transport。
- RPC ACK 的等待使用已有 control timeout/RPC reserve，不用短 cleanup margin 冒充其 deadline；本轮没有增加自动模型次数。

## 夹具阻塞的定位与修正

首次完整预检的唯一挂起 worker 是 `continue-recovery-admission.test.ts`；生产 DSH 独立健康。只结束已核验测试 PID 50460 后，其他 **775 项通过**。独立 15 秒限时组确认 availability case 在第二个模型仍等待时先使线程失效，标题却要求“进入 waiting 后失效”；新生产可用性检查正确拒绝它。夹具失去等待结果后漏释放 stale read gate，造成测试自身循环等待。

只修该夹具：在成功进入 waiting 后再使线程不可用，finally 总释放/还原读取屏障。**6/6 通过**，保留并加强原 thread/child/pin/原始 dispose 一次的断言，没有放松生产检查。较早 **784/784** 是预检结果，不作为最终最新构建结论。

第一次完整最新门禁另出现 **788/789**：真实故障进程恢复用例期望队列一行、实际零行。独立目标组连续三次通过后，用仅改变 fixture enqueue 延迟 100ms 的临时 actor 稳定复现零行；持久记录仍为 verdict_ready，并保留原 staged requestId。原因是 `recoverCallbacks()` 完成后台调度后，恢复 actor 立即读取队列并 `process.exit(0)`，早于实际后台 enqueue/received commit。本轮修正 fixture 的实际完成屏障，保留精确 identity、幂等和租约断言，不修改生产恢复语义。

修后 actor 等待同 submission/requestId 的真实 queue.inbox 与 record.received，再枚举和停止；测试还核对 producer 崩溃前 durable staged、其终止及 consumer 的 recovery-committed 报告。目标连续三次、进程故障组 **4/4** 与相同 100ms 强制延迟探针均通过。没有依赖固定睡眠，没有修改 TTL、lease fence 或生产恢复逻辑。

第二次完整门禁仍 **788/789**，此次是 settings-failure 中断标记等待：旧 fake review 以零延时自动完成，满载时终态先于 settings 失败；新客户端正确跳过中断已结束回合。夹具增加 opt-in HANG_REVIEW，并让同类注册失败/转换失败用例明确使用 HANG，保证其“仍运行必须中断”前提；42 项客户端测试全通过。真实迟到完成的独立协议测试继续验证“不重复 IRQ”，未恢复旧重复中断行为或删断言。

## 分层证据

| 验证层 | 定向结果 | 能证明的范围 |
|---|---|---|
| 真实客户端 + 本地 stdio server | **7/7** | abort/timeout 等待 ACK、失败确认保持原 pair、正常完成、迟到完成不重复 RPC、exit/stop 不 respawn |
| 真实 Manager/SQLite/ChildSession + 相同协议夹具 | **8/8** | Planner/Reviewer 原 thread/child/settings、failed ACK waiting 与 cleanup retry、确认后的单次 auto continue、cancel/stop/owner/scope 竞争 |
| 真实 CallbackDispatcher + 相同协议夹具 | **5/5** | 原 Reviewer 重试、未知 pair 拒绝、caller-only abort 的 failed/confirmed ACK 与显式取消分开处理 |
| 分类与既有准入/Callback 组合 | **11/11** 阶段验证 | unconfirmed 不进 backoff/auto continue，原 ID 字段不枚举，修后旧准入组保持单飞 |
| 实际安装 DSH 服务 + scripted application port | **11 个场景** | 原九例与普通 Planner/Reviewer 两例，失败确认不发模型，第三次确认后继续；原 native catalog/cold replay/pending tools/一次清理 |

真实客户端证据运行的是本地协议 server，不是生产 NPM App Server。安装宿主证据是实际 ToolRuntime/AgentRegistry/Projection/Subagent 服务配脚本化网关；不冒领真实生产 RPC 或浏览器验收。

## 边界

模型输出的文字不构成终止确认；未知或丢失原句柄不 reconstruction，不静默新建替代 Planner/Reviewer。当前进程的终态观察不能恢复重启后丢失的 ephemeral 上下文。本轮不迁移旧损坏日志、不推算 Token 节省或费用。

## 最终门禁与正式重载

| 门禁 | 最后源码与夹具冻结后的结果 |
|---|---|
| `pnpm verify` | **789/789**，失败/取消/跳过 0，85.43 秒 |
| 连续两次 `pnpm release:check` | 各 **789/789**；88.68/89.62 秒；离线 doctor 通过（5 项明确跳过）、包审计通过、临时 tarball 清理通过 |
| `pnpm host:check` | 实际安装 DSH 0.1.7-rc.2，九工具注册/卸载及 peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11**，普通模型中断的两个新增场景保持原 child/thread、设置与一次清理 |
| 异步与差异检查 | 异步/unhandled/关闭存储诊断 0；`git diff --check` 通过 |

最终日志目录 `%TEMP%/dsh-fifteenth-final-gates-f990287d-1419-4e7c-99d6-f2ab0a0f9aa0/`。之前的两次 788/789 与受控结束的挂起预检仅用于定位，未拿中间结果作最终验收。

正式重载前再核验无 running/waiting，PID 35552 的 executable/commandline 与本任务启动一致，插件 Junction 指向 D 盘仓库；只停止已核验进程树。新 **PID 5076** 第一次 20 秒观察未看到启动 URL，进程仍存活；随后同 PID 的监听和启动日志证明约 22 秒后完成启动，没有因观察超时再启动服务。认证交换 **303**、带 cookie 健康检查 **HTTP 200**。

复用 Playwright `dsh-recovery-20261005`，加载新私有状态后页面标题 **DeepSeek Harness**。receipt `%TEMP%/dsh-fifteenth-reload-receipt.json` 记录 Planner/App Server build SHA256 与同进程观察恢复。启动 stdout/cookie 状态不输出原文。没有创建正式模型调用、额外验收会话或替代旧 workflow；修改和记录留在工作区，没有提交、推送或发布包。
