# 第十九轮：异步子会话创建后的接纳与清理

## 实际问题

原提交已经 durable queued，但 release/child 创建仍有 await 窗口。真实公开 Bridge + 原生 child provider 的主组初始 **2 红、1 正常对照**：归属和 task 改变后仍创建 child；raw Agent 返回的旧 child 会覆盖另一个合法 mapped handle。只断言旧 child dispose=1 会漏掉 map 被覆盖、替代句柄遗失的问题。

启动生命周期组初始 **2 红、1 正常对照**：插件 stop 先于未完成的 raw 创建结束；workflow cancel 后 submit 返回旧 executing DTO。正常对照明确了持久提交成功后 caller-only abort 仍继续原 child，不能把它误改成取消整个提交。

## 来源与机制

[固定 GitHub 研究](../research/github-async-resource-adoption-patterns-2026-10-06.md) 核验 CPython TaskGroup 创建返回后登记原 task 并重新检查 abort、退出等待真实完成；Effect 保护获取到 finalizer 登记的窗口，closed scope 的迟到释放实际执行。PSF-2.0/MIT 许可见固定文件。只借鉴 guard 与 awaited ownership，不复制框架、增加依赖或用取消请求代替远端 ACK。

## 实施

- `submit` 在方法边界登记 foreground 启动任务，stop 等待它完成转交或清理。开始接纳时合并 caller/lifecycle signal；durable preparation 成功后改用 manager lifecycle + startup lease controller，保持正常 caller-only abort 行为。
- 从 prepared 记录捕获原 submission 身份，核对当前 owner/context、queued 相位、token/epoch、实际 coordination lease。release 与 create 每个 await 后重核，再转交原 background task。
- child helper 只在检查成功且旧映射未被替换后登记句柄。未接纳资源由原创建者 dispose 一次，不删除或覆盖替代 handle。cancel 返回当前、仍属原 caller 的 cancelled DTO。
- `ReviewObservation.begin` 在实际 SQLite mutation 内执行 guard；进度/heartbeat 沿相同 guard。被拒绝的开始不改 row/revision/progress，不启动 timer。
- provider 的 raw Agent.create 可能忽略 abort；若句柄返回时 lifecycle 已中止，先 dispose 原 handle，再抛出，不写 child turn/start 或发布 provider child。
- 观察 CAS 失败后，若 child disposal 又抛错，嵌套 finally 仍释放两级 lease 并清自己的 row fence，防止异常跳过剩余清理。

## 证据

```powershell
pnpm exec tsx --test test/bridge-child-adoption.test.ts test/bridge-startup-lifecycle.test.ts
```

创建与 registry 使用真实 Session/ChildSessionFactory/Provider；模型 gateway 为严格本地注入，没有正式模型调用。最终主组覆盖 release 后归属变化、晚返回与 replacement、实际 review-start 事务窗口及正常提交；生命周期组覆盖 stop 等待、cancel 返回、caller-only abort 和 disposal 抛错后的真实 lease 释放。

初步组合 **20/20**、既有 checkpoint/submission/evidence/native child 组合 **27/27** 通过。追加 disposal failure 的红例确认 lease owner 仍 true，修后 false 且 record token/epoch/until 清空。完整冻结门禁另列，不把阶段通过数当最终验收。

最终两套新测试各 **4/4**。review-start case 将竞争插入真实 begin 的 store mutation，记录事务内部 `ReviewProgressOwnershipError`；公开 submit 的外层 own 检查返回 foreign-session 错误。整个 row/revision 保持替换快照，callback/Model/commands 为 0、原 child dispose 1，heartbeat 未登记。此前检查 mutator.toString 的屏障被 store proxy 包装遮挡，已改为明确 begin 操作与真实事务，未把未命中屏障当通过。

## 边界

持久 queued 并不证明 caller 已收到返回值；可发现的原提交保持已有后台恢复语义。工作区不被锁定，证据仍由第十八轮复验；进程内 ephemeral thread/result 丢失不重建。迟到的外部创建必须等真实句柄或明确终止，观察超时不等于停止。历史 corrupt 会话未迁移，没有修改用户模型/凭据配置，也未估算 Token/费用。

## 最终门禁与正式重载

首轮完整 verify 因旧 `review-admission` worker 挂起无法汇总；只核验并结束对应 PID 50084 的测试树后得到 **831/832、失败 1**（文件被结束），不是通过。独立原文件 15/15 可通过，额外非生产临时探针在真实 raw child 创建中加 350ms scheduling stall，证明 300ms lease 在模型之前过期；新增 post-create guard 正确拒绝，native calls/Reviewer 为 0、原 child dispose 1，但旧夹具永远等待未进入的 model gate。探针删除、原源码未改。

只修该租约丢失夹具的真实前提：正常 10s lease 进入实际模型等待后再用真实 coordination 替换 owner/epoch，仍等待 heartbeat 发现失效并拒绝旧结果。加入 operation-settlement 与开始 gate 的竞争，启动已拒绝会报告真实错误。生产 TTL/lease 护栏没有调大或放宽；DSH PID 56520 未被测试终止操作目标。

修后原 admission 全文件 **15/15**，真实 heartbeat 检测约 3.39 秒，保留原 row 字节不变、successor owner/epoch、child disposal 1、pin=0 的精确断言。临时低 TTL 探针文件已删除，类型与空白检查通过；随后从最后冻结版重新运行完整门禁。

| 最终冻结门禁 | 结果 |
|---|---|
| `pnpm verify` | **837/837**，97.25 秒 |
| 连续两次 `pnpm release:check` | 各 **837/837**，101.05/99.63 秒；离线 doctor、包审计、临时包清理通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，实际服务配 scripted-local 网关 |
| 异步及差异检查 | 三次全量失败/取消/跳过为 0；所有门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-nineteenth-final-gates-fc78f95d-f011-4059-8386-6e7c4473f523/summary.json`。前述被结束的文件预检只用于定位，最后完整门禁没有停止测试进程。

正式重载前再次核验 PID 56520 的 executable/完整命令、3080 listener、D 盘 Junction 和 409 sessions 无 running/waiting。只停止已确认服务树，首次新启动 **PID 56312**；认证交换 **303**、带 cookie 健康 **HTTP 200**。监听 owner 与新 PID 一致，重载后仍无 running/waiting。

复用 Playwright `dsh-recovery-20261005`，私有状态加载后标题 **DeepSeek Harness**；唯一控制台错误核验为已有 wallpaper-engine 背景音频资源 **404**，未改该插件。页面/API 健康不代替生产模型故障恢复 UI 验收。

receipt `%TEMP%/dsh-nineteenth-reload-receipt.json` 保存新旧 PID 与构建 SHA256；token、cookie、旧聊天未输出。未追加正式验收会话或模型调用，历史 corrupt 会话未迁移；变更留在工作区，未提交、推送或发布包，持续优化目标保持 active。
