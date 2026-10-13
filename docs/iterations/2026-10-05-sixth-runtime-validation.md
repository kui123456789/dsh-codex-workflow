# 2026-10-05 第六轮：模型展示与原生持久回放

本轮完成工具结果展示精简、宿主 timer 范围检查及子会话原生工具生命周期修复。源码回归、发布门禁和正式 DSH 中的 Planner 中止恢复验收均已通过；真实模型与故障注入的验证范围分别记录。

## 已验证的改动与数据

| 项目 | 本次证据 | 验证范围 |
|---|---|---|
| 统计摘要展示 | 同业务 fixture、11 条原线程来源的模型展示由 **8721 → 1778 UTF-8 bytes**；1 条来源为 2374 → 1770 bytes | 真实 DSH ToolRuntime 的 canonical 值保持完整；默认 content 精简来源历史，计划、审查、证据和恢复字段逐项相同。这不是 Token 或费用测量 |
| 按需详情 | `codex_workflow_status` 的 `includeUsageSources:true` 展开原完整来源；默认只显示 summary/sourceCount | Manager SDK、CLI `show`、canonical value 和 SQLite 完整账本保留。PTC 主动打印 canonical 值仍可输出全历史 |
| 宿主 timer 上限 | `MAX_HOST_TOOL_TIMEOUT_MS = 2147483647`；超过该上限或非正/非有限 deadline 的 activation 被拒绝 | 测试验证拒绝发生在工具注册与存储创建之前；完整操作预算不会被悄悄缩短，也没有简单限制单次 turn 参数 |
| 原生工具回放 | 真正 JSONL `create → append → flush → close → 新 reader 冷读`；普通与 Zstandard 两种物理格式通过 | 读回经过 released V4 关系校验；实际 `ClientAssistantStream` 不触发 rebaseline，`BlockAssembler` 重组内容与持久 assistant message 一致 |
| 同会话继续 | 并行工具、未完成工具被中止、重复 completed 通知、长 item ID 与继续后的同 raw item ID 均覆盖 | native call ID 不冲突；广告的 ID/name/arguments 与 invocation 逐字匹配；turn 为 1/2，child ID 和原生侧栏 catalog 保持一个 |

展示方案与固定源码来源见 [工具结果研究](../research/github-tool-result-patterns-2026-10-05.md)。字节数据来自合成 fixture，未读取用户聊天或账本进行价格推断。

## 前次真实子会话损坏的原因

前次真实 Planner 已返回 `phase: executing`，但子会话持久化读取出现 `SessionPersistenceCorruptionError`，其底层错误为 **`has no advertised tool lifecycle`**。这说明业务规划结果存在，原生子会话历史仍不能通过存储关系校验。

生产端当时直接写入 `tool/call`，此前的 `assistant/message.content` 没有对应 `tool-call` 块。V4 读回要求先有同一 ID、名称和原始参数字符串的公告，再有调用及结果。内存 `Session.deriveMessages()` 和较浅的事件检查不能证明这个存储契约。

修复使用实际 Codex 工具通知生成原生 assistant tool-call 公告，保留原生工具卡片。所有待完成工具在 step 关闭前匹配结果；中断用错误结果明确闭合，之后的继续沿用原 child。流片段遵循 native step 生命周期，使真实客户端流重放与持久事件一致。

旧损坏用户日志未改写，修复不会自动为历史孤立调用补公告。旧子会话的数据处理属于单独迁移边界；本轮不提供修复旧日志的工具，也不以父会话生成替代计划或审查。

## 固定宿主依赖与隔离边界

新增测试开发依赖固定为 `0.1.7-rc.2`：

- `@deepseek-ai/dsh-session-persistence-jsonl`
- `@deepseek-ai/dsh-api-session-controller`
- `@deepseek-ai/dsh-tool-call-timeout-policy`

这使冷持久化、真实客户端流及 timeout policy 回归在只运行 `pnpm install --frozen-lockfile` 的环境中也能执行。没有增加生产 peer。关键测试从项目依赖解析，未依赖用户 HOME 下安装的 DSH，也没有因宿主缺失跳过关键回归。

## 本地启动器备份与运行准备

备份文件：`C:\Users\Z1803\.dsh\launcher\DeepSeekHarness.ps1.backup-20261005-200150`。

本轮只读核验备份：文件存在、**4230 bytes**、PowerShell AST 错误 **0**，SHA-256 为 `4B61DDF5EEE362AA5E0A9A523541515C3BB2A46A2C9154CDE2EF678B0F23FB38`。

启动器已可逆修改为优先使用 global `dsh.cmd` 的 web/profile web，保留 `0.1.7-rc.2` fallback；`Test-HarnessReady` 对受认证入口的 HTTP 401 返回 true。生产插件 Junction 实查指向 D 盘仓库。只重启本任务创建的 DSH PID 13792 及其子进程，新的 web 服务 PID 45264 载入最新 `lib/`；认证交换 HTTP 303、带 cookie 健康检查 HTTP 200。没有修改模型提供商或凭据。

## 验证与最终验收状态

| 检查 | 当前状态 |
|---|---|
| 展示与 ToolRuntime 回归 | 新 9/9、含既有工具组合 25/25 通过 |
| 原生持久化与继续回归 | 冷读/child/resume 组合 32/32；侧栏组合 12/12 通过 |
| 类型检查与 diff 检查 | 通过 |
| `pnpm verify` 完整源码门禁 | 初次 **618/618 通过**，约 46.3 秒；helper 最后四项回归加入后，两次发布检查内的最终 verify 均 **622/622**，失败 0、跳过 0 |
| 最终 `pnpm release:check` | **连续两次通过**，均 `RELEASE_CHECK_OK`；offline doctor、打包审计通过，临时 tarball 已清理 |
| 最终 `pnpm host:check` | **通过**；DSH `0.1.7-rc.2`、九个工具、peer 兼容、原生侧栏契约与卸载通过 |
| 最终 `pnpm host:recovery:check` | **四场景通过**：Planner resume、Reviewer resume、Planner cancel、Reviewer stop；每项一个 child、一次可见线程创建、native catalog/messages replay 通过、pending tools 为 0；两项 resume 断言原 thread 相同 |
| 最新产物在生产 DSH 的加载与真实 UI 工具显示 | **通过**；真实侧栏显示中止、继续指令及完成计划，原生子会话历史可读取，无格式损坏 |
| 真实 Planner 中止 → 原父会话 status/resume | **通过**；无 ID status/resume、原 workflow 和 child 不变、child 两个回合；实际 wire 参数已只读核验。原始 ephemeral thread ID 不对外持久化，精确 ID 复用由上述宿主故障注入验证 |
| 真实模型 Token 或费用下降 | **未测量，不作结论** |

完整源码门禁日志为系统临时目录中的 `dsh-sixth-final-verify-20261005.log`。最终门禁日志及 `summary.json` 在临时目录 `dsh-final-gates-017637e5-7eb9-47b4-91f0-c7ace4095a76/`；该汇总的 `browserUIVerified:false` 只表示门禁脚本未运行浏览器，独立 UI 验收如下。

## 正式 DSH 中的中止恢复验收

只创建一个独立验收父会话 `session-5da8505c-60d7-47cc-bf31-47529daae7ca`，在临时 demo 工作区运行只读规划。此验收不是对前次已取消或旧损坏会话的恢复。

- 原 workflow：`2c65f74c-d32f-4a99-a313-9a5ddcad044a`。
- 原 Codex child：`336f6472-2837-4122-a836-081695d2a6ad`。
- 等到真实 `plan.live` reasoning 后，通过原生 `session/cancel` 停止父回合；这一步没有取消 workflow。
- 在同一父会话发继续指令；真实 `status` 参数为 `{}`，结果为 `planning/waiting`、`continuation.available:true`。真实 `resume` 参数只有 `instruction`，没有 `workflowId`。
- 调用计数为 `start:1/status:1/resume:1/cancel:1`，审查为 0；原 child 的两个 `turn/start` 分别对应失败和成功，side panel 直接显示短 continuation 与 Planner 的完成计划。
- 完成后显式取消验收 workflow，避免进入实现。没有生成 demo 源码；Mnemon 自动生成的独立 checkpoint child 已按 provider/label 识别，没有误计为 Codex 替代 Planner。

截图及脱敏事件摘要保存在忽略目录 `output/playwright/dsh-recovery/child-recovery-after.png` 与 `child-recovery-events.json`。截图仅在捕获时隐藏第三方升级浮层和桌宠，没有修改插件配置。浏览器出现的单条 404 来自壁纸音频资源，与子会话生命周期无关。

这次 App Server 报告的原线程累计为 input **369093**、cached input **288512**、output **2133**、reasoning output **988**、total **371226**，来源数为 1、缺失数为 0；包含原线程上的内部转换。该数字不含父 DSH、Mnemon 或独立 fork，也没有可比收费基线，因此不声称节省 Token 或费用。
