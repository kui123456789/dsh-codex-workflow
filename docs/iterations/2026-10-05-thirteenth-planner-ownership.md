# 第十三轮：Planner 异步结果与原运行归属

## 范围与固定来源

第十二轮完成 Reviewer 最终证据复核后，继续检查 Planner 的相同异步写入边界。参考 [Temporal 与 VSCode 的固定源码研究](../research/github-planner-run-ownership-patterns-2026-10-05.md)：结果属于同一 workflow ID 不等于可以完成当前操作；返回后检查和最终 mutation 内检查都需要成立。本轮只借鉴机制，没有复制源码、增加依赖或移植上游框架。

## 已复现问题

真实 WorkflowManager、SQLite、Session 的初始新组为 **10 项中 9 项失败、1 项合法恢复通过**。模型或转换等待中改变 owner、cwd、phase 后，旧 `ready` 仍写计划并注入执行提示；旧失败可能启动下一回合、写 waiting 或覆盖新记录为 failed。另一个既有取消竞争用例发现，resume 的 native input commit 被取消后虽然原资源释放，activeTurn 仍残留，重复 cancel/stop 对已释放同一回合共发送三次 interrupt。

## 实施

- 新增小型 `planner-run-identity.ts`：捕获并冻结 workflow ID、session、cwd、task、createdAt，独立于后来解析的模型设置。
- Planner 在模型返回、继续回合前及启动/等待/失败事务中核验原身份与合法相位；Planner 可见回合和受控补全拒绝不同原线程。
- `acceptPlannerOutcome` 在转换前后、补全后以及 ready/needs_input/failure 的 SQLite mutation 内使用相同身份和取消/停止检查。未接纳的原生问题不进入 pending map。
- 只读复审实际复现转换读取返回前 owner 改变、弱回复分支仍发送第二个可见补全请求。补全 RPC 前再读取原身份，回归由 visibleTurns=2 红转为 1 绿；最终写入原本已有保护，本次补的是额外模型调用。
- failure catch 不把被替换的记录标成当前业务失败，也不注入计划。合法失败仍只自动继续一次，之后保留原 child/thread/model/effort。
- waiting 与 clarification 句柄保存冻结身份。用户未提交答案时改变 task/cwd，不重新用新记录给旧线程授权；status 返回 `identity_changed` 并保留原句柄。缺失原身份返回 `handle_unavailable`，不构造替代智能体。
- 非 retained 的 resume 总会清除 active cancel target。退订、原始 dispose 与 pin 仍各一次。

## 保留原生输入中止契约

首轮完整预检 **739/743**，四例失败指出新 signal 检查提前阻止 `waiting_input` 的领取事务，绕过第十一轮的确认中断/恢复路径。修正后领取事务仍只接受原 identity 和 waiting_input；RPC 前的取消由后续检查处理，先确认中断，无法确认则还原原请求。没有把本地等待取消当成 wire 已终止，没有降低原断言。相关 native boundary 与新归属/commit 组 **28/28 通过**。

## 定向验证

- 原运行归属 **19/19**：模型/转换返回身份变化、迟到失败、恢复/回答等待时 owner 变化、waiting task/cwd 变化拒绝驱动旧句柄、受控补全前的调用检查，以及合法同身份恢复。
- 最终 mutation 与 registration 竞争 **6/6**：ready/native input/converted failure/register 的写前变化与 stop；实际 Session/child frames、记录 revision、调用数、原资源清理均验证。
- 终态 native-input cancel **2/2**：重复 cancel/stop 的 interrupt 仍恰好一次。
- status **32/32**：新增 task/cwd/createdAt 漂移与缺失身份的只读能力诊断；不消费原句柄、不发模型 RPC。

## 边界

身份为原 Planner 的 workflow/scope，不是工作区内容快照、模型名称或跨进程恢复 token。它不锁 live FS，也不创建可跨 App Server 重启恢复的 ephemeral 线程。原 input/resume 单飞、SQLite 原子更新和取消终态规则继续适用。现有损坏子会话没有迁移，正式环境没有增加真实模型调用。

## 最终门禁与正式重载

本轮从 2026-10-05 延续至 2026-10-06 凌晨，保留开始日期作为文档文件名。

| 门禁 | 最后一次源码冻结后的结果 |
|---|---|
| `pnpm verify` | **754/754**，失败/取消/跳过 0；62.12 秒 |
| 连续两次 `pnpm release:check` | 各 **754/754**；64.98/65.24 秒；离线 doctor 通过（5 项明确跳过）、包审计通过、临时 tarball 清理通过 |
| `pnpm host:check` | 实际安装 DSH 0.1.7-rc.2，九工具、peer、sidebar、卸载契约通过 |
| `pnpm host:recovery:check` | 八场景通过，原身份、设置、native replay、pending tools=0、一次清理 |
| 异步与差异检查 | 异步/unhandled/关闭存储诊断 0；`git diff --check` 通过 |

最终日志目录为 `%TEMP%/dsh-thirteenth-final-gates-c2efe5f9-8eae-4970-9dfc-ad920a5e1cc3/`。较早 753 项结果没有覆盖末尾补全前检查；上表仅使用更新后 754 项结果。前置红例、原生输入回归和修后日志分别保留，不以中间绿例冒充最终验收。

正式服务重载前只读 metadata 再次确认无 running/waiting，PID 48952 的 executable/commandline 与本任务启动一致，Junction 指向 D 盘仓库。只结束该进程树，最新构建加载为 **PID 49132**；启动认证交换 **303**，带 cookie 健康检查 **HTTP 200**。复用既有 Playwright `dsh-recovery-20261005`，重新加载私有临时认证状态，页面标题 **DeepSeek Harness**。没有发起真实模型或新建验收会话。

重载 receipt 为 `%TEMP%/dsh-thirteenth-reload-receipt.json`，记录最新 Planner build SHA256。启动 stdout、cookie 状态不输出原文；原用户数据和损坏历史未迁移。修改与验收记录留在工作区，没有提交、推送或发布包。
