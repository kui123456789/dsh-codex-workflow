# 第十六轮：审查入口路由与私有线程清理归属

## 可重现的问题

真实 `startExternalPlan → submit` 的 Bridge 工作流在 sending/retrying/received 时调用前台 `review`，旧代码会另外创建 Reviewer/child，并可能先消耗业务周期。初始入口组 **3 项失败、2 项普通 DSH 对照通过**。修后按 origin 路由，在归属校验后、资源创建前拒绝 Bridge 前台审查，持有 review lease 后重查；原合法 submit/background 流程保持可用。

一次正常前台审查后，私有 Alignment seed 的原订阅未释放。增加覆盖全处理范围的创建方 finally 后，正常路径通过，但严格网关进一步复现 **6 项中 4 项通过、2 项失败**：未确认的私有模型仍运行时直接退订，且 stop 找不到原 pair。网关明确拒绝对 active model 退订，防止夹具把 unsubscribe 伪装成模型终止。

## 机制来源

[固定 GitHub 研究](../research/github-review-entry-and-resource-ownership-2026-10-06.md) 核验 BullMQ 的共同 job/key 身份、VSCode 的 scope/资源转移，以及 Codex 的真实退订边界。Codex `823ea83` 的 `thread/unsubscribe` 只移除当前连接订阅；运行中的回合不会因此停止，上游测试明确保留正在运行的 turn。只借鉴机制，没有复制源码或增加依赖。

## 实施

- Bridge-origin 只走原 `codex_workflow_submit` 和后台审查；前台入口不把同步 review 偷换成异步 submit。外会话优先拒绝，不泄露 origin/phase，不写 lease 或创建模型资源。
- Alignment/Reconciliation seed 的创建方覆盖可读处理、结构化转换和重查，完成后只释放自己的线程。Reconciliation 使用内部 active-turn 注册，不计入原 Reviewer usage。
- 创建方在 thread/start 前持有独立 process pin，覆盖创建失败、模型处理、transient backoff 和嵌套重查；正常退出释放该 pin，未确认错误只转移同一已有 pin。
- typed 私有中断先在独立 cleanup deadline 下确认原 pair。仍未确认时转移到进程内 `auxiliaryTurns`，保留自己的 process pin，禁止 speculative unsubscribe。
- cancel/stop 对原辅助 pair 单飞重试清理，确认或原进程已丢失后才释放一次。辅助 pair 不借装成原 Reviewer 的恢复 marker，不自动重跑可见审查、不消耗 cycle、不应用 latestReview。
- 有未确认辅助 turn 时，前台准入、私有 seed 创建和后台 callback 调用均拒绝再发模型。拒绝保留 typed marker，避免 CLI fallback 绕过。
- `start` 文案补齐 cleanup-only resume 例外：丢失返回 ID 先无 ID status；`interruption_unconfirmed` 可重试原清理，确认前不发新模型、不重复已提交答案。

## 对用户粘贴诊断的核验

当前 start 在建线程前保存 workflow，status/resume 可省略 ID；`no active workflow` 也不证明没有终态记录。每任务一次的说明是防重复规则，不是失败后永久扣除的配额。caller abort 不等于 App Server 进程重启。原 child 多回合显示和原线程 continuation 已有回归覆盖。历史 corrupt 会话和丢失进程的 ephemeral 上下文没有被伪造或迁移修复。

## 分层证据与边界

正常 seed 释放用真实 `CodexAppServerClient`、本地 stdio 协议夹具、Manager/SQLite 和真实 DSH child factory 验证。失败/取消/未知确认用严格脚本化网关验证原 pair 与资源计数；不是生产模型调用。入口组使用真实公开 Manager/SQLite 流程，callback 是本地脚本化 port。安装宿主 smoke 与正式页面健康检查分别报告，不代替真实模型失败验收。

初步组合 **65/65** 通过，另原模型中断/authority/tools 组合 **53/53** 通过。最终冻结后的完整门禁与正式重载结果另补于下节；中间通过数不作为最终验收。

独立审查发现 Bridge callback 返回前已释放原 Reviewer pin，后续辅助线程的正常路径却未持有自己的 pin；默认 idle 5 秒短于第二次 transient backoff 的 6 秒。真实 Dispatcher/public Bridge + 严格 port 的红例在 `create-alignment pins=0` 失败。修后虚拟时间驱动真实 3/6 秒 backoff，并验证嵌套 alignment 同时持有两份独立 pin；原 callback 与三个 seed 共四份生命周期精确平衡，each thread release 一次，真实 apply 才 cycle=1。辅助组与该窄例初步 **10/10** 通过。

因发现这一具体遗漏，核验唯一预检 PID 48724 的命令后停止其进程树。taskkill 对两项退出中的子进程返回非零；随后逐个重查关联测试 PID，均已消失。正式 DSH PID 5076 未被目标操作，认证健康 HTTP 200、无 running/waiting。该预检没有最终通过计数，不能作为验收；后续门禁从最终冻结版本重跑。

## 最终门禁与正式重载

首个冻结版本 verify 在用量夹具挂起后，经核验只停止 worker PID 31096 才完成汇总：**798/806、失败 8**，异步警告 0，不能作为通过。失败集中在旧夹具：Bridge-origin 被用于前台用量用例；最后一个前台 barrier 永远不会触发；成功恢复仍只计算原 pin；通用 fake 用原 `source-thread` 代替私有 seed，并把故意失败的第一笔退订错误套到私有资源。独立限时用量组重现 10 通过/1 失败/1 取消，背景恢复组重现 4/5；按真实业务入口、唯一私有身份和资源归属修夹具，未放宽生产准入或清理规则。

夹具修后用量边界 **12/12**、背景恢复 **5/5**；通用 workflow 的独立整文件从 **114/120（同 6 项失败）** 变为 **120/120**。前台用量夹具明确使用已批准的 DSH 快照，没有把 Bridge 记录偷偷改 origin；开始屏障与操作 settlement 竞争，早拒绝会报告真实原因。通用 fake 为辅助线程分配独立唯一 ID，每轮原 Reviewer 与私有 seed 的释放数组精确核对；故意的退订失败仅针对原 Reviewer。保留取消、业务周期、原线程/child、用量字段、hold/backoff、外部 handoff 和 legacy/origin 零退订的断言。此前独立五套组合 **82/82** 和宿主 **11/11** 也通过；它们不代替最终全量结果。

| 最终冻结门禁 | 结果 |
|---|---|
| `pnpm verify` | **807/807**，86.21 秒 |
| 连续两次 `pnpm release:check` | 各 **807/807**，97.77/90.58 秒；离线 doctor、包审计和临时 tarball 清理通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2** 的工具/peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，原 child/thread 与一次性资源清理通过 |
| 异步与差异检查 | 三次全量失败/取消/跳过为 0；所有门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-sixteenth-final-gates-28266abc-816e-469a-a04e-1c4d9b5308c5/summary.json`。最后一次门禁完整结束，没有终止测试进程。前述被停止的预检和 798/806 仅为定位记录。

正式重载前核验 PID 5076 的 executable/完整命令及 3080 listener，Native metadata 无 running/waiting（409 sessions）；Junction 指向 D 盘仓库。只停止该确认的服务树，首次新启动 **PID 42020**。认证交换 **303**、健康 **HTTP 200**，listener 的 owner 与新 PID 一致；重载后仍无 running/waiting，没有追加验收会话或正式模型调用。

复用 Playwright `dsh-recovery-20261005` 载入新私有状态，页面标题 **DeepSeek Harness**。唯一控制台错误来自已有 `wallpaper-engine/scene-audio` 背景音频资源 **404**，刷新后仍为同一资源；本轮没有修改背景插件。页面连接和认证 API 健康不等于真实生产模型故障恢复验收。

receipt `%TEMP%/dsh-sixteenth-reload-receipt.json` 保存旧/新 PID、日志与私有状态路径、Workflow/App Server/Planner 构建 SHA256；启动 token、cookie 和旧聊天内容未输出。历史损坏会话未修复，进程重启丢失的 ephemeral 上下文未重建。全部变更保留在工作区，未提交、推送或发布包；持续迭代目标保持 active。
