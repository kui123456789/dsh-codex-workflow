# 第二十八轮：不可恢复审查的行动指引

## 真实错误闭环

沿用第二十七轮实际服务核验：PID 69208、3080 listener 匹配、409 sessions、无 running/waiting workflow；Git main/abb6174，历轮未提交修改保留。正式服务未动。

隔离 probe 复用真实 App Server 客户端、dispatcher、原生 subagent/session/projection 及真实 SQL：原 Reviewer 失租退休后，公开 recovery 正确拒绝原资源恢复、模型 RPC 保持 1，没有 completed checkpoint。此时 status 仍报 not_waiting；onTurnStopping 发出 finish approved plan + submit；真实 BridgeRuntime 将 SQL submission_notice 交付原 parent，末尾要求“修复环境或任务问题后重新提交”。

按这些提示调公开 submit，原输入与实际 evidence hash 均未变，仍分配新 submission：child 1→2、thread 1→3、模型 RPC 1→4，最终 received。多出的 RPC 为新可读审查、转换和 private authority，不是正式模型/Token/费用计量。真实改 changed.txt=v2 的对照也成功，说明旧路径没有区分恢复原故障和新业务输入。

原始证据 `%TEMP%/dsh-unavailable-review-routing-probe-20261006.log`；TEMP probe 源码已实际删除。没有上游模型调用、未读取正式聊天或 auth。

## 仓库反馈与边界

`test/bridge-unavailable-review-routing.test.ts` 修改生产源码前实际 **2 RED/1 正向 GREEN**：准确 status/stop/notice、同 evidence 默认提交零副作用、实际 v2 工作区的同 approved context 新审查。日志 `%TEMP%/dsh-bridge-unavailable-review-routing-red-20261006.log`。拒绝断言保留完整 row/revision/queue/events 与模型/线程/child 数，不只检查错误文本。

固定机制研究见 [失败行动政策](../research/github-workflow-failure-action-policy-2026-10-06.md)：Temporal 保存 failure/retryState 并明确新 run；XState error/done snapshot 不重复 invoke，行动由当前 guard 决定。两源只借机制，不加依赖；固定许可/源码/test范围在研究中，上游测试只读未运行。

本轮要共享不可恢复机器原因与行动判断：状态准确报原 thread unavailable；父收尾与 notice 不再诱导重实现、自动 resubmit 或代写审查。相同已核 evidence 的默认提交应拒绝；实际 evidence 变化或显式 newReviewRound 请求允许真正新轮次。此显式字段表示调用者意图，工具契约要求用户明确请求新业务轮次，不构成人类身份验证。

`SubmitInput` 的 newReviewRound 控制需与 ReviewInput 材料分离，pending 与模型 prompt 不保存这个控制字段。未知 legacy 失败和模型未启动的正常业务不能被泛 regex 拦截；历史受控诊断仅只读解释，不批量改写旧记录。第二十七轮源码基线 `%TEMP%/dsh-twentyeighth-production-baseline` 已保存。

以下后续章节记录实际修复与验收；以上红例验证期间正式构建仍为第二十七轮。

## 同一行动策略的补充红例

- `bridge-unavailable-result-routing.test.ts` 使用实际 SDK 可读审查、转换成功，再持有并失败真实 private authority RPC。确认 durable pending=true、原 verdict cache 确实存在后，只删除进程内 cache 模拟结果丢失；公开 recovery 自然产生 failed/no verdict/no cycle。修改该分类前实际 **2 RED**：status not_waiting，默认同 evidence 新 submit 仍被接受。日志 `%TEMP%/dsh-twentyeighth-result-routing-red.log`。该类精确报告已完成结果 handle_unavailable，不把原审查说成未运行或 thread 丢失。
- `bridge-terminal-review-policy.test.ts` 的一次真实 model RPC 权限拒绝发生于 Reviewer thread 已成功创建并注册后；其收尾释放原 thread/child，但旧默认 submit 又创建替代。实际 **1 RED/1 前启动正向 GREEN**，日志 `%TEMP%/dsh-twentyeighth-terminal-policy-red.log`。前 thread/start 权限拒绝没有创建 thread/model，应允许修环境后首次真正审查；没有泛化所有权限错误为不可恢复。
- 原 scope 的文件实际未变，先前已存在的另一个稳定文件被新 changedFiles 选中，仅因 fingerprint 不同便被当作工作区变化。`bridge-new-review-round-request.test.ts` 对该具体绕过实际 **1 RED**，日志 `%TEMP%/dsh-twentyeighth-scope-selection-red.log`。默认故障恢复必须按原 pending review scope 重新核验 evidence，不能通过换文件列表制造新变化。

这些先红例都保存真实原输入、actual SQL record/hash、SDK 模型/线程和 native child 数；模型使用本地协议，不涉及真实 Token 计费。首次结果测试的清理时序错误导致一次 test-only timeout，修正后取得两项确定性红例；未把该测试超时记成生产缺陷。

明确新轮次、summary/test wording 不绕过、机器原因存储往返、历史受控诊断只读解释与未知 legacy 不猜等后续正向/拒绝覆盖已补，首次运行在修后源码，不冒领旧代码红例。

## 实施

- 新 `submission-recovery-policy` 模块统一机器原因、行动文案和新轮次接纳。已有 submissionCallbackReason 保存 `original_reviewer_unavailable` 或 `original_review_result_unavailable`，不新增 SQLite schema/version。原 submissionError 保留主因；只有真实 typed failure 分支写机器码，旧受控完整文本配严格元数据只读解释，未知 provider/legacy 文本不猜。
- 生命周期状态使用既有 thread_unavailable/handle_unavailable，取消、插件停止及实际运行优先；普通终态残留 active map 继续按原 not_waiting 契约，避免把旧状态误报为真实执行。
- 收尾提示与实际 notice relay 都使用同一策略，不要求父会话重实现、自动重交或代写计划/审查。Notice wire format 与 idempotent delivery 不变。
- SubmitInput 的布尔 newReviewRound 是独立业务控制，剔除后才生成 pendingReviewRequest/模型材料。默认不可恢复路径核原 pending changedFiles 的最新 evidence，候选列表单独作为合法新轮材料；原 scope/evidence kind 与原因的身份在异步读取后和 prepared CAS 再核。
- 同内容默认拒绝发生在新 UUID、子会话和模型资源前，保持原 row/revision/error/queue/events。原 scope 的真实 evidence 变化或 explicit true 接纳新 submission；缺旧基线不能伪造变化。正式工具说明要求用户明确请求新审查，不把 true 用于故障恢复。
- 实际成功 onThread 注册的当前 run 发生 typed terminal permission/schema/no-verdict 等失败后，其已释放原资源准确标不可恢复；没有创建 Reviewer 的 startup failure 不套此规则。成功 completed artifact 丢失用独立 typed error，不说线程丢失或模型未运行。
- review_only 的工具说明在 auto-trigger off 时也说明省略 id 的 status/resume、原 turn cleanup 与禁止父会话代写。

独立最新公开路径、策略及工具组合 **31/31**，类型检查通过，日志 `%TEMP%/dsh-twentyeighth-new-independent-green.log`。新增共 15 场景：线程不可恢复 3、明确新轮与 scope 3、结果丢失 2、权限前后边界 2、策略 3、工具契约 2；其中先红例 6，余下为真实正向或修后接口覆盖。完整门禁、正式重载以实际结果为准。

## 最终门禁

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 929/929，256.93s，异步警告 0 |
| `pnpm release:check` 第一次 | 929/929，273.33s，离线 doctor/打包检查通过，异步警告 0 |
| `pnpm release:check` 第二次 | 929/929，254.13s，离线 doctor/打包检查通过，异步警告 0 |
| `pnpm host:check` | 退出 0 |
| `pnpm host:recovery:check` | 退出 0 |
| `git diff --check` | 退出 0 |

完整结果 `%TEMP%/dsh-twentyeighth-final-gates-437a2eb4-1c4c-4b3f-9ade-a777324700ec/summary.json`。源码作者最后相关组合 **155/155**、类型检查通过，新增公开边界与工具适配 **31/31** 已独立核验。未以测试覆盖或文案声明代替实际 SDK/状态/资源拒绝的证明。

## 正式重载等待

全部门禁结束时曾核验 PID 69208 与 3080 listener 匹配，409 sessions、runningIds=[]、waitingWorkflowCount=0。重载脚本的最后即时活动检查发现刚开始的新会话，主动抛出 `Live running/waiting workflows prevent reload`，没有执行 taskkill，也没有生成本轮 reload receipt。

再次原句柄查询确认 PID 69208 仍存活，sessions=410，runningIds 包含 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55`，waitingWorkflowCount=0。观察等待不代表该会话已结束；保留原服务和所有新会话活动，不重启、不发送消息或打断它。该等待时刻正式构建仍为第二十七轮，后续实际切换见下一节。

## 实际重载完成

随后持续查询同一实际服务/会话，直到权威 metadata 确认为 runningIds=[]、waitingWorkflowCount=0、sessions=411。没有将观察超时当终止，也没有打断活动；新会话及其子会话均保留。重载脚本重新核验后才停止旧 DSH 树，实际结果：

- 新 PID **52788**，旧 PID 69208 已退出；127.0.0.1:3080 listener 归新进程，认证 HTTP **200**。
- 会话总数仍 **411**，runningIds=[]、waitingWorkflowCount=0；仅查询 metadata 再确认等待期间新增的原 parent session ID 仍存在，没有读取其 title/聊天内容。
- 私有 state `%TEMP%/dsh-twentyeighth-formal.state.json`；receipt `%TEMP%/dsh-twentyeighth-reload-receipt.json` 记录新旧 PID 与 workflow/App Server/Planner/恢复政策/提交执行/生命周期/Bridge/工具/自动指引构建 SHA256。
- 复用 `dsh-recovery-20261005` 浏览器，加载新认证后标题 **DeepSeek Harness**；唯一 console error 为既有 wallpaper-engine 音频 404，warnings=0。
- installed host 与 11 个脚本化原线程恢复场景均 ok。本轮没有正式上游模型故障注入；等待期间的用户新会话活动与隔离验证分开，未读取其聊天内容或向其发消息。

本轮没有改 profile/credentials/历史 corrupt 会话，没有 commit、push 或发布；持续迭代目标保持 active。真实模型故障 UI 的现场验收不能由本地故障脚本代替。正式 stdout/auth 只保存私有 TEMP 文件，未输出 token/cookie/聊天。
