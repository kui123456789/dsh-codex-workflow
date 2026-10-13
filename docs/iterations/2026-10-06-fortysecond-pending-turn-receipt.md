# 第42轮：启动回执前的协议错误归属

日期：2026-10-06。仓库 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`。接续第41轮已验证的原回合协议清理；保留现有修改和历史会话，不提交或发布。

## 真实失败与健康对照

独立本地上游先接受 `turn/start` 并实际启动 writer，推迟原 RPC 回执。回执前通过真实 stdout 发送缺少 `itemId` 的合法 JSON 输入请求，再返回原回执及有效完成消息。SDK 收到坏帧时 `rawPending=1`、`onStarted=0`、`turnWaiters=0`；随后返回 `completed` 和可用文本，没有原回合中断。这是错误被吞后的业务 RED，区别于第41轮宿主 fatal。

首次反馈含一个健康延迟回执对照和一个坏帧候选，诊断错误为0，全部诊断进程自然退出。坏帧与随后真实回执的 thread/turn 完全一致：实际 writer 开始14:58:09.090Z，坏帧写入09.119Z、SDK观察09.121Z，真实回执09.212Z，可用成功09.276Z。

证据 `%TEMP%/dsh-fortysecond-before-receipt-feedback.results.json` SHA256 `D8ECB7D255DCCDBF38723259D1B500D4A1AB80E928FF1D984375DDA818761A15`；真实坏帧260bytes，SHA256 `0ee2c8b11bf82ecc79e0787f027f7c255fa6296cf03bee3e28eb0860d1dfb117`。正式 DSH 未用于故障注入。

持久回归先于源码修复运行：`pnpm exec tsx --test test/app-server-pending-receipt-failure.test.ts`，旧源健康对照通过，坏帧用例断言 `usableText=false`，实际为true。原日志 `%TEMP%/dsh-fortysecond-pending-receipt-repository-red.log` 保留。

## 最小实现和边界

回执问题的生产改动仅 `src/app-server.ts`。启动请求在发送前登记冻结的原请求 ID、进程、源线程 owner 和方法；pending receipt 保留至原回复验证及回合登记完成，也覆盖 response 到 await 恢复的窗口。

错误帧只提供提示，不提供可清理句柄。已登记的唯一原回合优先；否则仅唯一当前原进程及源 owner 的 pending 操作保存提示。原 RPC 回复验证后，以真实 thread/turn 匹配最早错误，进入既有 terminal cleanup。按提示组合保留首错，避免先来的 foreign turn 提示遮住后来的有效错误。Detached review 使用回复返回的目标线程，而不是源线程。

成功文本不能覆盖已匹配的协议失败；失败 ACK 保留原子会话、线程、pin、主错误和 cleanup-only 恢复。没有新增模型继续预算、替代线程、全进程故障 latch 或 `-32602` 回复策略。

无 scope、多个候选、foreign tuple 不取得别人的恢复能力。原回执一直不返回、回执非法、收到回执前 timeout/abort 的未知 writer 完整处理未在本轮实现；不能据此推断远端停止或伪造 turn ID。研究和测试均须保留这个边界。

## 对旧诊断的核查

当前工具的 `resume.workflowId` 可省略，按当前父会话查找；`start` 先持久化记录，后创建子会话和线程。一次启动调用不是永久次数配额。可见子会话确实由 DSH `subagents.start()` 创建；由插件恢复入口驱动原 App Server 线程。可恢复失败能够在进程内保留句柄，进程丢失后 ephemeral 线程才不可恢复。父会话代写计划不是允许的恢复路径。

正式只读 metadata 找到用户引用父会话的两条历史 cancelled/failed 记录，当前无可用运行，原进程已历经重启。记录没有 Planner/Reviewer 持久线程字段，但 ephemeral 按设计不保存这些字段，字段缺失不能单独证明丢失运行态句柄。`status` 的无活动记录结果不能证明数据库不存在历史记录，也不能仅凭 corrupt 标签证明 App Server 线程丢失。没有更改或复活历史记录。

## 验证与交付

基线 `%TEMP%/dsh-fortysecond-baseline-d5553452-3c86-4570-9c63-3334f8e94189` 保存537个文件，不包含 dependency Junction。旧源 SDK SHA256 `A957FA866EEAB8AE39FFC26BED51D0C783C48C0982AB4D9441890F56C8B6E65B`。源码构建类型检查已通过；完整回归、门禁及受控正式重载结果完成后追加。

相关固定源研究见 [pending receipt ownership](../research/github-pending-turn-receipt-ownership-patterns-2026-10-06.md)。正式原 PID67176、411会话和111条 workflow 保留；没有真实模型费用或完整浏览器验收。持续优化目标保持 active。

## 首次相关回归及独立进程树问题

新增7个用例通过；测试 actor 的 detached 分支有一处 Promise 包装类型错误，修正后完整 typecheck 通过，detached 单项再通过。原真实 pipe 反馈以 after-only 脚本重跑，健康对照正常、坏帧变为原 `CodexProtocolError`，恰一次原 pair 中断、零新回合；原 RED 脚本和 artifact 未覆盖。

6组既有相关套件首次得到85个测试、84通过、1失败。保留失败目录 `%TEMP%/dsh-app-server-protocol-failure-5320WP`；失败发生在 actor/parent 各15秒的原进程树退出检查。业务日志完成原 pair ACK、唯一 unsubscribe/dispose、pin归零，但 actor 退出检查先失败，父测试的业务断言未完成，不能把它汇报为 Planner 用例通过。

实际捕获的第三个 PID 是仍在运行的 `biz_helper.exe`，出生比捕获的新父进程早271.5秒。Windows 旧数字 ParentProcessId 复用后使它误入本次测试树；这是 capture 时归属错误，区别于 capture 后 PID 被复用。没有终止该输入法进程，也不从这次证据反推第38轮旧失败原因。另行补 [进程树捕获修复](2026-10-06-fortysecond-process-tree-capture.md) 的真实证据和回归；原 SDK 修复 SHA256仍 `95844BBC0F723D02E1CC44252F920872E46D2C834AC65D63595BD8571EE44D97`，其7项用例未改弱。

## 最终冻结与门禁启动

补充修复后同一组既有套件加新增7项 pipe 和3项 census，共95/95通过，失败、取消、跳过均0，原 Planner 用例实际完成原业务断言；日志 `%TEMP%/dsh-fortysecond-related-final.log`，38.79秒。生产只改 SDK 和 process transport 两个文件，同行只读审查无阻塞项。

71个 source、149个 test/fixture 已冻结，125个完整测试文件以文件并发2运行，全部原内部并发、期限和断言保持。门禁目录 `%TEMP%/dsh-fortysecond-final-gates-de6b2025-00aa-4eaf-8f6c-9a895112f305`；`verify`、连续两次 `release:check`、`host:check`、`host:recovery:check` 和 diff 结果随后追加。正式67176仍411会话、running/waiting均0，未重载或故障注入。

## 最终门禁与正式重载结果

上节为执行中快照，后续门禁全部完成：

| 检查 | 实际结果 |
| --- | --- |
| `pnpm verify` | 1150/1150，369.30秒 |
| `pnpm release:check` 第一次 | 1150/1150，375.03秒 |
| `pnpm release:check` 第二次 | 1150/1150，373.01秒 |
| `pnpm host:check` | exit0，4.83秒 |
| `pnpm host:recovery:check` | exit0，7.90秒 |
| `git diff --check` | exit0 |

三次完整测试失败、取消、跳过及异步异常均0。两次 offline doctor 与pack审计通过、临时tarball清理完成；doctor的5项正式Codex检查按offline契约跳过，不当作真实模型验证。source/test冻结哈希差异0，211个构建文件随后冻结到 `%TEMP%/dsh-fortysecond-build-freeze.json`。原 RED 和85测试中1失败的退出现场保留，未用重跑结果覆盖原始证据。

重载前再次只读确认旧67176的完整命令、监听、411会话及running/waiting均0。额外验证实际DSH数字树中各父子出生顺序，11个进程实例均可确认归属后，才停止该原树并以原profile、参数隐藏启动75196。保存原11实例的出生证据，以原实例退出谓词确认全部已退出，未仅按数字PID判断或终止不相关输入法。

新75196监听 `127.0.0.1:3080`，认证HTTP200。411会话保持、原父会话metadata保留；111条workflow整体有序SHA256 `96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8` 不变。211个构建文件与receipt19个模块哈希差异均0，stderr fatal匹配0，running/waiting均0。

证据 `%TEMP%/dsh-fortysecond-reload-receipt.json`、`dsh-fortysecond-formal-verification.json` 和formal-metadata-before/after.jsonl。主问题真实pipe after反馈SHA256 `87E62D8558BD2C5799FED6A61CA0C70748339CDB97E3CD94092079D95083977F`；最终测试三文件SHA保持 `B09138A2A26DB3DBF5B26B196024A8B3C5923EBE8579F5010C62BEACA302FE5F`、`7D6311549AD2AA2B368DED1A00CF83561F1CC67DDE78F54C260250D7255182A7`、`4015D0EB5A49CA1D51323683F58976E2AC86A79C57D236CB3EB7C9D641AB5829`。

本轮只解决合法原回执随后返回的早到协议错误，以及门禁发现的Windows采集误归属；无回执、非法回执、pre-receipt abort的未知writer完整处置仍未覆盖。没有真实provider故障注入、Token费用或完整浏览器验收；保留历史corrupt会话、provider与配置，未commit/push/publish，持续优化目标保持active。
