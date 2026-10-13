# 第二十轮：前台审查启动失败的状态收尾

## 范围与实际问题

本轮覆盖公开 reviewOnly/review 在原生 child 创建、caller abort、ReviewObservation.begin 的真实 SQLite 事务失败、workflow cancel、manager stop 和 owner/attempt 被替换时的启动路径。目标是保留可寻址的原 workflow，并在模型尚未启动的失败后留下稳定、可再次接纳的业务状态。

主执行任务先运行两套新增测试，结果 **0/6 通过**。native factory 抛错、caller abort 与 begin 事务回滚后，durable 记录仍困在 reviewing；显式 cancel 后公开调用返回 rejection，没有返回最新 cancelled 记录；stop 后也留下 reviewing。归属替换用例还观察到原 row/revision 被晚写并进入模型路径。上述故障发生在 Reviewer 模型句柄建立之前。

## 根因与修复

[ReviewExecution.run](../../src/application/review-execution.ts) 原先把 child 创建和观察开始放在正常模型执行的异常收尾范围之外。reviewOnly 已保存原记录，一旦该启动段抛错，后续负责相位复位、归属检查和资源清理的 catch/finally 无法处理它。

- 启动时捕获原 session、cwd、task、createdAt、mode、phase 和 reviewAttempt。每个创建 await 后重新核查 cancel/stop 与当前记录身份；ReviewObservation.begin 在 SQLite mutation 内执行相同 guard。
- 为启动段建立独立 catch/finally。仍属原 owner/attempt 的失败恢复到原 fixing 或 executing 相位，写明确 error 与 `processState: "failed"`，清 retryState/activeTurnId；恢复原观察字段，不消耗 reviewCycles 或虚构模型恢复句柄。
- 并发取消优先返回当前、仍属原 scope 的 cancelled DTO；owner/task/attempt 已改变时拒绝，失败收尾不覆盖替代记录。
- 启动 catch 无论状态处理如何退出都停止本次 heartbeat，并清理本次 child。迟到句柄与 stop 仍遵守前一轮的 pending start 等待和创建者归属规则。
- 已存在的等待 Reviewer 在新 continuation 尚未开始时失败，则恢复同一个进程内 recovery 对象；原 record、child、thread 与 pin 保留。显式 cancel/stop 和原线程丢失不走此保留分支。

这里的 `processState: "failed"` 是启动诊断；workflow 的 phase 保持可再次 review 的 executing/fixing。它没有把 workflow 变成终态 failed，也没有宣称存在一个可发 continuation 的原 Reviewer。

## 六用例红到绿的证据

```powershell
pnpm exec tsx --test --test-timeout=10000 test/foreground-review-startup.test.ts test/foreground-review-startup-lifecycle.test.ts
```

主执行任务实测：修改前 **0/6**，修改后 **6/6**。用例来自真实 Manager/WorkflowStore SQLite、DSH Session/ChildSessionFactory/Provider，模型 gateway 为严格本地注入。

| 测试文件 / 场景 | 修复后断言 |
|---|---|
| [foreground-review-startup.test.ts](../../test/foreground-review-startup.test.ts)：native factory 创建失败 | 保留唯一原 workflow、原 scope、attempt/cycle=0；模型/thread/恢复表为零；修复 provider 后按原 id review 成功 |
| 同文件：caller abort 期间 raw 创建迟到返回 | 返回原 abort reason，迟到 child dispose 一次；状态可再次接纳；同 workflow 重试得到第一个真实 verdict |
| 同文件：观察开始事务失败 | 在实际 SQLite mutate 后抛错，验证全部进度字段与 revision 回滚；清理已创建 child；随后按原 workflow 成功 review |
| [foreground-review-startup-lifecycle.test.ts](../../test/foreground-review-startup-lifecycle.test.ts)：显式 cancel | 公开调用返回最新 cancelled DTO；cycle=0、无模型/usage；原 child 清理一次 |
| 同文件：stop 期间创建 pending | stop 在创建结束前不完成；原记录可查询且不再 reviewing/running；没有 child turn/start，store 关闭后重新读取内容不变 |
| 同文件：owner/task/attempt 被替换 | 原 caller 被拒绝；替代整行与 revision 精确保持；模型/thread=0，仅清理原 child |

正常重试严格断言同 workflowId 和 scope、最终 passed、reviewCycles/reviewAttempt 各为 1，只有一个可见 Reviewer 线程；创建的 child 与审查/转换辅助线程按原对象释放一次。失败路径检查 registry、active/auxiliary turns、heartbeat、recoverable run、foreground/background tasks、review flights、controllers 和 pin 清理，不能用幂等包装后的计数代替真实调用。

## 当前相关验证

主执行任务已实际执行 `pnpm typecheck`，退出码 **0**。相关回归组合 **122/122 通过**，失败、取消、跳过均为 **0**，包含：

- foreground-review-evidence、review-admission；
- workflow-resume、workflow-return-ownership；
- bridge-child-adoption、bridge-startup-lifecycle；
- model-interruption-recovery、recovery-status、start-boundary。

这些是本阶段局部与相关组合的证据；没有将其写成完整 verify/release/host 门禁或正式 DSH 重载结果。

追加必要用例 [workflow-resume.test.ts](../../test/workflow-resume.test.ts)：公开 resume 先领取 existing 句柄，再在 owned 读取返回前中止 caller。初始红例将原 `waiting` 记录改成 `failed` 并清掉 retryState，revision 从 9 变为 10。修复后整行不变、原 recovery 对象身份不变、未新增模型调用，原 child/thread/pin 保留；随后同 workflow resume 成功。两套启动文件加完整 workflow-resume 组合 **36/36**，类型检查再次通过。

## 来源、原线程与启动边界

[固定公开源码研究](../research/github-startup-state-finalization-patterns-2026-10-06.md)核验 BullMQ `71c9ca72f32108e21f8d339b95ff750606806f60`（MIT）的原 job 状态迁移、坏 child 隔离和 running 收尾，以及 Prefect `86cbe02fe1932964852dba7ef9eb2ab497ee85c9`（Apache-2.0）的 pre-execution crash 分类与 finally。上游测试只读，未执行；BullMQ 后续新 job 成功不被冒领为原 thread 继续，未 await kill 也不被当远端 ACK。Prefect 未覆盖所有普通启动异常的限制保留。

模型尚未启动时，原业务显式 retry 是修复启动条件后的首次模型 dispatch；没有原 thread 可继续。模型已经开始、被保留或终止未确认时，原 child/thread 与中断屏障的契约仍适用，不能用此启动诊断创建替代会话。六用例覆盖无 retained Reviewer 的首次启动路径，追加用例验证已领取的 retained Reviewer 在 pre-begin caller abort 后仍能同线程继续。

工作区不加锁，输入/证据 freshness 仍由既有门禁处理。此记录不声称真实模型故障恢复 UI 已验收，不估算 Token/费用，也不把当前阶段结果写成整轮结束。

## 最终门禁与正式重载

生产源码与测试冻结后完整执行：

| 门禁 | 实际结果 |
|---|---|
| `pnpm verify` | **844/844**，98.52 秒 |
| 连续两次 `pnpm release:check` | 各 **844/844**，101.62/101.26 秒；离线 doctor 与包审计通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer 与原生 sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，实际安装服务配 scripted-local 网关；不等同正式模型 UI 验收 |
| 异步和差异检查 | 三次全量失败/取消/跳过均 0；所有门禁异步警告 0；`git diff --check` 通过 |

日志：`%TEMP%/dsh-twentieth-final-gates-f324a36b-a241-4973-8df1-1f0f9e317d70/summary.json`。本轮新增 7 个回归，前一轮 837 用例保持通过；未终止测试进程，没有正式模型调用。

重载前再次核验正式 PID **56312** 的 executable/完整命令、3080 listener 和 web profile 的 D 盘 Junction。409 sessions，无 running/waiting；只重启已确认服务。新 PID **57136**，认证交换 **303**、带 cookie 健康 **HTTP 200**，3080 listener owner 与新 PID 一致；重查仍 409 sessions，无 running/waiting。

复用 Playwright 会话 `dsh-recovery-20261005`，页面标题 **DeepSeek Harness**。唯一控制台错误仍为 wallpaper-engine 背景音频 **404**，未改该插件。receipt `%TEMP%/dsh-twentieth-reload-receipt.json` 保存新旧 PID 和 workflow/App Server/Planner/ReviewExecution 构建 SHA256；认证值和旧聊天未输出。

当前契约核验还纠正了事故解释的边界：`resume.workflowId` 可省略；start 的一次调用指引不是永久配额；`no active` 不证明 durable failed 记录不存在；child 历史 `corrupt` 不证明后台 thread 已消失。线程未返回或当前进程/句柄已失去时仍不可伪造恢复，不由父会话代写计划。历史 corrupt 会话未修复，未 commit/push/publish，持续优化目标保持 active。
