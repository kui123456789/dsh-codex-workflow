# 第十四轮：已提交答案后的中断确认与返回归属

## 范围与参考机制

参考 [固定源码研究](../research/github-return-and-cancellation-patterns-2026-10-06.md) 的 Codex 原 turn 中断回复链与 VSCode Chat 原 model/request 核验。只采用机制，不复制实现或引入依赖。

本轮处理原生答案已经通过 RPC 提交、调用者等待随后中止的 Planner 路径。它与“RPC 尚未调用就中止”不同：已答 request 不可重新恢复为待答，也不可用本地 abort 假定服务端原 writer 已停止。

## 实际红例

- 提交后中止组初始 **3 项中 2 项失败、1 项正常对照通过**。SDK 的真实代码以 fire-and-forget 启动 abandon，随后立即拒绝本地 waiter；测试复刻这一时序，让原 remoteActive 保持到 ACK。
- 未确认中断时旧 status 宣称 available=true，实际 manual resume 对原线程额外发送两次 turn/start，并产生两次 active-writer 冲突。原答案只发送了一次，因此不是重复答案 RPC 问题。
- 公共返回组初始 **3 项中 1 项失败**：owner 改变并 cancelled 后，Planner raw cancelled 快返回交付新 owner 的私有任务。已有计量刷新实际上只合并同 owner 用量；仅 flush 期间换 owner 的对照早已安全，没有把旧 whole-record 风险冒充现状。
- 只读复审又复现 cleanup await 后 same-owner task 改变并 cancelled 的 scope 快返回，补全身份检查后该单例红转绿。

## 实施

| 原请求状态 | 未确认中断的处理 | 可继续条件 |
|---|---|---|
| 未提交答案 | 保留原 native request，恢复 waiting_input | 回答原请求，或确认原回合中断后走原线程恢复 |
| 已提交答案 | 不恢复 pending；保留原 child/thread、短答案、pin 与原 turn marker | resume 只重试原 turn 清理；确认后才发送新模型回合 |
| 原 App Server 丢失 | 明确报告原句柄不可恢复 | 不构造替代线程 |

`RecoverableWorkflowRun.interruptionTurnId` 仅在进程内保存。status 返回 `interruption_unconfirmed`，保留原句柄；Tool description 与 auto-trigger 指令明确允许 resume 重试这一清理操作，禁止在确认之前发送模型回合或重答旧 requestId。确认等待之后仍复核 owner、原 scope、当前 handle、取消和停止。

Cancel/stop 对待确认 marker 的原 thread/turn 先中断，再按已有一次清理机制释放 child、subscription 和 pin。确认失败的 repeated resume 不消耗句柄、不写新失败相位、不调用模型。

Planner cancelled 快返回先检查完整 captured identity；公共 foreground 用量 wrapper 也检查结果所属会话与原调用会话一致。合法原 owner 取消仍可返回完成业务 DTO 和最新同 owner counters；计量刷新不替换业务结果或混入新 owner 用量。

真实 Review 快返回回归进一步发现，失去归属的 final observation 虽不改业务字段，原 no-op callback 仍让 SQLite 增加 revision/updatedAt。期望身份不符时改为事务内拒绝，沿既有 cleanup catch 收尾，保留新 owner 的整行记录；没有增加 Store 框架或放宽测试。

## 定向证据

- Submitted-answer 组 **8/8**：等待 ACK、未确认 cleanup retry、正常原设置恢复、首次 cleanup 中 cancel/stop，以及 manual cleanup 期间 owner/handle/cancel 变化；SDK 请求数、答案次数、writerConflicts、原资源释放均验证。
- 原未提交中止四例与返回组组合初次 **10/10**，保留第十一轮确认失败恢复原请求的断言。
- 工具/自动触发政策与 submitted-answer 组组合 **34/34**。
- 公共返回组最终 **6/6**：合法同 owner 计量、刷新期间换 owner、Planner foreign cancelled、原 scope 变化、真实 Review 路径和独立 wrapper 防线；不以 stub 防线替代真实业务路径。与既有前台证据组合 **29/29**，整行 revision/updatedAt 断言保留。
- 安装宿主脚本新增第九个 `submitted_abort` 场景，初次 **9/9 通过**：真实 ToolRuntime 将 caller signal 传入原 native answer，清理后物化 AbortError；故障中断不清除模拟原 writer，status 严格返回 `interruption_unconfirmed`；manual resume 的第二次清理 ACK 后才允许继续。原 child/thread、model-A/low、冷回放、catalog、pendingTools=0 与一次清理均通过。

## 边界

本地父等待结束不证明 wire turn 已终止；本轮确认采用已核验的非空原 turnId interrupt RPC 语义。空 turnId 的 startup interrupt 仅是 submission ack，未用作结束确认。本轮不迁移旧损坏历史，不把新独立场景当旧 workflow 已恢复，不增加正式模型调用，也不估算节省费用。

宿主脚本使用 scripted application port，不运行真实 App Server 或其后台 abandon。精确 fire-and-forget 时序由 submitted-answer 单元组复刻当前客户端源码；两类证据分开报告。

## 最终门禁与正式重载

| 门禁 | 最后源码冻结后的结果 |
|---|---|
| `pnpm verify` | **768/768**，失败/跳过/取消 0，62.74 秒 |
| 连续两次 `pnpm release:check` | 各 **768/768**；66.09/66.38 秒；离线 doctor 通过（5 项明确跳过）、包审计通过、临时 tarball 清理通过 |
| `pnpm host:check` | 实际安装 DSH 0.1.7-rc.2，九工具注册/卸载与兼容/sidebar 契约通过 |
| `pnpm host:recovery:check` | **9/9**，最后新增 submitted_abort 的原 child/thread、设置、冷回放与一次清理均通过 |
| 异步与差异检查 | 异步/unhandled/关闭存储诊断 0；`git diff --check` 通过 |

最终日志目录 `%TEMP%/dsh-fourteenth-final-gates-0cb19206-d44d-4fb6-a362-ae765994e60e/`。前置 765 项结果未包括最后整行返回测试，不用它支持最终结论。

正式重载前再次核验无 running/waiting，旧 PID 49132 的 executable/commandline 与本任务启动一致，插件 Junction 指向 D 盘仓库；只停止该已核验进程树。新 **PID 35552** 加载当前构建，认证交换 **303**、健康检查 **HTTP 200**。复用 Playwright `dsh-recovery-20261005` 并加载新的私有 cookie state，页面标题 **DeepSeek Harness**。

重载 receipt `%TEMP%/dsh-fourteenth-reload-receipt.json` 记录 Planner build SHA256。stdout/cookie 状态含私有认证信息，不输出原文；没有创建正式模型测试、额外会话或替代原子智能体。修改留在工作区，没有提交、推送或发布包。
