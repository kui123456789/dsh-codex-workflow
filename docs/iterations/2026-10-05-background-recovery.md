# 2026-10-05：后台审查恢复迭代

接续 [会话恢复迭代](2026-10-05-session-recovery.md)。本轮把同一提交的后台重试纳入单个 Reviewer 执行与释放关系，并补齐 [恢复能力诊断](2026-10-05-recovery-diagnostics.md)。设计依据来自 [已核验的 GitHub 机制](../research/github-workflow-patterns-2026-10-05.md)：OpenCode 按 key 合并执行、Codex 分离线程和回合、LangGraph 分离检查点与可用句柄、Goose 传播取消并等待派生任务清理。

## 证据 → 问题 → 实施

| 改动前可复现场景 | 问题 | 本轮改动 |
|---|---|---|
| 同一提交两次 send 通用模型失败，创建两条 Reviewer | 分类器收到带回合 ID 的包装诊断，未识别原失败原因 | 按 raw error/reason 分类；保留原 ephemeral Reviewer |
| 同一提交过载两次 send，创建两条 Reviewer、执行四个模型回合 | 暂时性错误提前 return，没有保留线程；继续提示重发初始任务 | 等待句柄保存线程、请求身份及释放闭包；原线程短指令继续 |
| busy 持久排程后 child 已被标记 completed 并销毁 | 第二次后台输出丢失原子会话展示 | 停泊 child，在原会话追加 continuation；成功、取消、失效时终结 |
| 停止发生于创建或 onThread 回调窗口，随后仍启动模型回合 | lifecycle 取消未进入创建和回合边界 | owner AbortController 与创建状态门闩；stop 等待 active 与异步 unsubscribe |
| 显示修正超时后缓存了不合规文本，恢复直接归一并通过 | 未验证的输出被当作有效检查点 | 仅保存通过四章节/语言契约的文本；转换失败只恢复已验证文本 |
| App Server 在第一次失败后已丢失，下一次又创建新线程 | 不可用句柄仍被报告为 retryable | 失效的 ephemeral 提交明确失败，重复请求不再建立替代线程 |
| 持久恢复正在执行但状态为 waiting，心跳未启动 | 数据库和现场运行表现不一致 | 租约校验后的 sending 更新恢复 running 与 heartbeat |

保留既有兼容性：新建 Reviewer 不 resume；旧持久 Reviewer 恢复失败不释放他人的订阅；同一持久线程的 refcount 与不同工作流保持独立；取消窗口中的私有 fork 在实际启动时仍被中止，原任务不被写入。

## 行为与接口

- 同一 workflow/submission 的相同请求共享一个执行 Promise；source/cwd/prompt/task/model/effort 等身份变化明确拒绝。不同提交可以并行。
- 每个保留 Reviewer 只占一个 process pin，继续不会重复累加；共享释放闭包使 cancel、stop、正常收尾只释放一次。
- 后台请求的可选 `onContinuation` 通知原 child 开启继续回合；`onVisibleReview` 传递验证后的可读输出，最终子会话保存真实审查正文。
- 内存保留的文本只用于转换恢复，不作为持久 verdict。最终 command 的 requestId/createdAt/内容仍先持久化，再进入原 SQLite 队列。
- `isThreadAvailable` 仅观察当前 App Server 进程内的已加载线程，不做 RPC 或启动进程。进程退出、idle shutdown、unsubscribe、stop 后旧句柄不可用。
- `status.continuation` 描述手动恢复能力，后台自动排程不冒充手动 resume。持久 running 状态本身不能证明运行仍在线。

进程重启的区别仍明确：手动 ephemeral continuation 不可恢复；后台持久 submission 可从存储的请求和证据开始新审查，不把新上下文冒充原会话续跑。本轮不改变这个既有持久恢复契约。

## 验证

```powershell
pnpm exec tsx --test test/callback-recovery.test.ts test/submission-recovery.test.ts
pnpm exec tsx --test test/app-server-availability.test.ts test/recovery-status.test.ts
pnpm verify
pnpm release:check
pnpm host:check
```

新增 callback suite 原始红基线为 1/17 通过；当前加入异步释放、显示契约和进程丢失回归后为 21/21 通过。公开 Bridge 集成 suite 为 5/5，通过真实 WorkflowManager、SQLite Store/Queue、CallbackDispatcher、ChildFactory 验证提交→等待→恢复→入队→应用，审查周期为 1。真实测试子进程可用性 suite 为 3/3；状态诊断 suite 为 11/11。测试不调用真实模型或用户数据库。

本轮最终门禁结果：

| 检查 | 2026-10-05 实测 |
|---|---|
| `pnpm verify` | 类型检查与构建通过；503 tests / 503 pass / 0 fail，用时 51.66 秒 |
| `pnpm release:check` | 连续两次 `RELEASE_CHECK_OK`；离线 Doctor 正常（5 项明确 SKIPPED）、打包审计通过、临时 tarball 清理 |
| `pnpm host:check` | DSH 0.1.7-rc.2；9 个工具注册及卸载成功；peerCompatible 与 nativeSubagentSidebarContract 为 true；隔离临时 storage |
| `git diff --check` | 通过 |

这些证据覆盖源码、构建、隔离传输与宿主契约。正式 DSH 界面、真实模型故障与 Token 使用尚未进行现场验收；本轮没有修改正式 profile 或重启正式宿主。

## 后续优先级

1. 真实 DSH 恢复演示与成本测量：核对原 child/thread、继续消息、故障注入边界与输入/缓存 token；量化节省前不声明比例。
2. 模型预算与诊断：将可见回合、conversion/alignment/reconciliation 分开记录成本与恢复原因。
3. 强化应用端口类型：缩小 Submission/Review Execution 的 AnyFn 接口，明确阶段与取消所有权。

持续优化目标保持进行中。
