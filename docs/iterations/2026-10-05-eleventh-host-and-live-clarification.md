# 2026-10-05 第十一轮：澄清中断与宿主、正式运行验收

本轮处理 native 输入在回答 RPC 之前被中止时的 pending 资格，扩展宿主澄清回归，并完成正式 DSH 的独立问答验收。固定官方源码和许可见[原生输入中断研究](../research/github-native-input-interruption-patterns-2026-10-05.md)。源码、宿主故障注入与真实运行的验证范围分别记录。

## 中断完成与停止等待的区别

本地等待者或 AbortSignal 中止，不能证明原生 request_user_input 已关闭。回答尚未发出时，负责结束原回合的路径需要实际 interrupt；本轮使用 interrupt RPC 已完成作为旧 wire pending 已关闭依据，之后再更新本地资格。

固定上游源码的顺序为：TurnAborted → 移除原 thread 的 wire pending → 回复 interrupt RPC → 处理 Interrupted 完成通知。因此 RPC 完成能够提供 pending 清理依据；它不表示客户端已先收到 UI 完成事件，也不免除当前 workflow/handle/owner 和取消、停止状态的检查。

答案已经提交后，父端 wait abort 不能撤销该答案，不得重复答复旧 requestId。若只有本地等待中止，原 turn 可能仍在运行；在 active turn 上 turn/start 可能 steer 原 turn，而不会建立新的 turn。短 followup 应基于实际中断/完成结果及原线程可用性。

## 已知定向红绿基线

文档子任务没有重复运行以下测试：

| 阶段 | 主任务提供的结果 | 范围 |
|---|---|---|
| native before-RPC abort 补丁前 | **4/4 红例** | 在原生回答 RPC 前发生 abort，原 pending 与续跑资格处理不正确 |
| 补丁后同组 | **4/4 通过** | 实际中断完成与本地等待中止分开处理 |
| 红绿日志和断言 | 原 unanswered writer 保持 active 时，原代码 manual resume 两次遇到 active writer；修后先 interrupt 原 thread/turn，恢复成功且 no writer conflict | 中断失败保原 pending/inputRun；中断期间 cancel/stop 不复原资源，实际 cleanup 一次 |

修复记录是否调用了 native answer 方法。未调用而发生中止时，独立 deadline 的 interrupt 不继承已中止的 caller signal；成功后才转入失败恢复等待。若无法确认中断，回到 `waiting_input`，保留原请求并报告固定诊断，不把它当已结束回合。cleanup await 后重新校验 owned、cancel 和 stop。

## 宿主脚本八个隔离场景

主任务报告扩展宿主脚本 **8/8 通过**：四个既有恢复场景，加四个澄清场景。它们使用实际安装的 DSH 服务和隔离测试数据/故障注入，不等同于正式 DSH 浏览器或真实模型验收。

| 分组 | 场景 | 验证目标 |
|---|---|---|
| 四个既有场景 | Planner 原线程恢复、Reviewer 原线程恢复、cancel、stop | 原身份保留与生命周期清理 |
| 四个新增场景 | native answer、native cancel、converted/completed-question answer、converted/completed-question cancel | 原 request reply 与短 followup 分别正确，取消不补建替代 child/thread |

宿主八例使用实际 DSH `0.1.7-rc.2` 的 ToolRuntime、AgentRegistry、SubagentRuntime、SessionProjectionRegistry。原 parent catalog 与 child messages 的 cold replay、原地址、waiting pin=1 和最终 release/end/dispose 各一次均验证。正常 native answer 使用 exact 原 pending/turn；converted/completed-question answer 在原 thread 追加短答案，不含完整原 task。两个成功场景的 A/low 设置保持。旧 ephemeral 丢失时不使用 SDK reconstruction 替代原运行。

## 正式运行计划与边界

重载前只读 Session list metadata 确认 runningIds 为空，原 PID **45264** 的 executable/commandline 与本任务创建的服务匹配；插件 Junction 实查指向 D 盘仓库。只重启该 owned 树，新 web PID **8828** 载入最新 `lib/`。认证交换 HTTP 303、带 cookie 健康检查 HTTP 200。此前 Playwright 命名浏览器已明确不在列表，再以同名重新打开并载入新的临时 auth state，未重复创建浏览器会话。

只创建一个独立临时验收会话：`session-1688dbff-1b6c-47f4-b3c1-32bd3e2db357`；workflow `d88eebbf-aa5e-4e30-8a9a-003de6389f46`；Codex child `6af05c45-113c-4a92-9fbe-430467eb4efc`。该验收不是旧 workflow 的恢复。

真实 Planner 在读取临时 README 后请求用户选择 sum/max。原 start JSON 为 `waiting_input`、native pending=true、原 turn `01a10c94-471c-7ff3-ad80-ac1f2ba69eb6`，wire 模型 `gpt-6-sol`、requested effort `low`。回答 `{calculation:["sum"]}` 后通过原 `continue` 完成三步计划，model/effort 不变；随后显式 cancel 防止进入实现。

实际调用计数：start=1、continue=1、cancel=1，review=0；Codex child 数=1，其原侧栏历史有两个正常回合，问题、短答案和计划都可重放，无格式损坏。原始 ephemeral thread ID 不对外持久化；精确 thread/turn 驱动由上述宿主 scripted case 验证，正式验收以 native pending、代码路径、单一 usage source 和 child 身份证据确认。没有声称从公开 DTO 直接测得隐藏 raw thread ID。

临时目录仍只有 README 和 Mnemon 插件元数据，没有实现源码。后续 Mnemon 的自动 checkpoint 若出现会按 provider/label 区分，不计作 Codex 替代 Planner。

截图及脱敏证据在忽略目录 `output/playwright/dsh-recovery/eleventh-clarification.png`、`eleventh-call-metadata.json`、`eleventh-event-summary.json`。截图捕获时临时隐藏第三方升级提示，不修改其配置；没有重写旧损坏日志。该新模型运行的原线程累计为 total **153982**、input **153401**、cached input **67072**、output **581**、reasoning output **150**；包含同线程转换，不含父 DSH/Mnemon，不作节省或费用结论。

## 最终门禁与实际验收

| 检查 | 需要记录的证据 | 当前状态 |
|---|---|---|
| native abort 四例日志 | 补丁前红例与补丁后 4/4 的实际日志 | **4/4 红 → 4/4 绿**；与已有澄清/提交竞争/原线程恢复组合 **60/60** |
| 宿主八例日志 | 8/8 的场景、运行环境与 receipt 位置 | 初次及最终 **8/8 通过**；新八例结果完整保留于最终 summary |
| `pnpm typecheck` | 类型检查结果 | **通过** |
| `pnpm test` / `pnpm verify` | 完整通过/失败/跳过数量与日志 | 最新 **696/696 通过**，失败 0、跳过 0，约 47.9 秒 |
| `pnpm release:check` | 发布、离线 doctor 与包审计 | **连续两次通过**，均 696/696、失败 0、跳过 0；残留异步／unhandled／关闭存储诊断均为 0；离线 doctor（五项跳过）、打包审计和临时 tarball 清理通过 |
| `pnpm host:check` / `pnpm host:recovery:check` | 最终构建后的兼容与恢复门禁 | **均通过**；九个工具完整卸载、peer/sidebar 契约通过；新版八例全部原 child/thread、catalog/messages 保留且 pending tools=0，两种澄清 answer 的原设置、pin 与一次清理均验证 |
| 正式 DSH 重载 | 重载前归属、实际新 PID、服务就绪及产物加载 | **通过**，新 PID 8828；当前健康检查 HTTP 200 |
| 唯一新临时 session 问答 | 原 child/thread，native reply 或 completed-question followup 的实际关系 | **真实 native 问答通过**，单一 Codex child、原 workflow、gpt-6-sol/low 保持；converted 路径只在宿主八例验证，没有额外真实模型调用 |
| 同一临时 session cancel | 已取消状态、原 pending/运行清理、无替代子会话 | **通过**，最终 cancelled/pending=false；没有实现或审查，running metadata 最终为空 |

源码研究、隔离宿主脚本和正式运行结果分别记录。没有观测到原 wire 中断结果时，不用 waiter abort 冒充清理完成；不复用上述结果声称旧 workflow 恢复，也不推算 Token 或费用。

系统临时目录日志：`dsh-eleventh-native-input-interruption-red.log`、`dsh-eleventh-native-input-interruption-green.log`、`dsh-eleventh-targeted-tests.log`、`dsh-eleventh-final-verify.log`；正式服务 stdout/stderr 和 auth state 不输出内容。最终门禁在 `dsh-eleventh-final-gates-65da5558-37e5-48eb-83d4-ebc666409e77/`，其中 scripted-local/browser=false 只描述门禁进程，正式 UI 实测由前述独立证据证明。
