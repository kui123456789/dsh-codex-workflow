# 第43轮：调用方等待与原启动回执的独立生命周期

状态：本轮修复、完整门禁与正式重载已完成。日期：2026-10-06开始，2026-10-07验收。实际仓库位于D盘；原有修改保留，总体持续优化目标保持active。下文保留各阶段失败与收尾过程，最终结论见末节。

## 原因与真实反馈

第42轮修复了合法回执随后返回前的早到协议错误。本轮补齐调用方先超时/取消的窗口：普通RPC settlement删除pending条目，`requestRegisteredTurn`的finally删除receipt；原模型仍运行，却失去原requestId的迟到回复路由。

本地真实SDK、stdio和native DSH夹具先接受原 `turn/start` 并暂缓原回复。调用方取消后，旧实现返回planning/waiting、`continuation.available=true`；公开 `WorkflowManager.resume` 再发送启动请求，被仍活动的原任务拒绝。真实迟到原回复也未被adopt。没有第二个模型实际运行的证据，不声称已测出Token费用。

证据 `%TEMP%/dsh-fortythird-feedback-cf18d46c-49ab-4d93-8e8c-4537f14adc2f`：backend73672、actor77372，原RPCid4→取消→新RPCid6且originalActive=true→真实lateid4、adoption0。健康延迟回复对照通过，所有诊断原进程退出。前两次prototype的Windows ESM路径和错误phase期待属于harness错误，原件保留，不计为业务RED；正确正常phase是executing。

持久回归在生产修改前运行：`pnpm exec tsx --test test/start-receipt-lifecycle.test.ts`，健康1通过、取消和超时2业务失败。取消错误宣告可继续；超时没有返回可发现的等待记录。原日志 `%TEMP%/dsh-fortythird-start-receipt-red.log` 保留。

## 已采用的合同

- SDK保持普通RPC pending/timer/abort-listener单次结算，同时保留原已提交model-start的独立reply路由和不可序列化能力；不重新发送原prompt，也不凭消息字段编造turnId。
- 新`CodexTurnReceiptPendingError.operation`非枚举。冻结原进程、源thread owner及请求身份；`status/evidence/resume/cleanup/finished`只处理那个原请求。late reply登记真实state，恢复使用新调用方回调，不执行已中止的旧回调。
- Planner/foreground Reviewer/callback持原child、pin、stage、配置和一次自动继续预算。waiting记录只存安全bool/process guard；原输出可能已完成，但交接前不删除恢复owner。
- `resume`没有回执时有界报pending，ready时接回原回合；取消或stop只清理原pair，或以捕获的原实例树退出证明释放。正常clarification通过metadataOnly交接同一pin。
- private auxiliary seed保持原purpose/thread/pin；nested alignment不冒认外层seed。completed确认模型结束，seed在整个work完成后才释放。

## 研究与证据边界

[固定来源研究](../research/github-observer-cancellation-operation-receipt-patterns-2026-10-06.md)对比MCP和Temporal。MCP删除超时后的handler只是限制；Temporal依赖预先确定的durable workflow/run identity及服务端协议，不能直接当作App Server恢复实现。SDK不重启丢失的ephemeral进程。

原复现子任务连续两次被模型服务按可能的网络安全风险拦截，主任务转为直接执行同一普通本地生命周期测试，未请求绕过权限或修改正式服务。

## 当前验证

- 新原回执完整回归19/19通过：Planner正常、abort、timeout、cancel、stop，foreground native/conversion/alignment，callback visible/rewrite/ephemeral或persistent conversion、cancel、stop、timeout、原实例退出。
- 相关Planner/Reviewer既有控制加8新用例55/55通过；callback旧44加11新用例55/55；SDK目标59/59及4独立真实pipe控制通过。
- 当前`pnpm typecheck`通过。新的19项当前日志 `%TEMP%/dsh-fortythird-receipt-current-target.log`，27.12秒；相关日志 `%TEMP%/dsh-fortythird-planner-review-target.log`，53.12秒。
- 初版审查fixture缺`TEST GAPS`合同标题，修正测试输入而非生产显示规则。实际发现并修复alignment在消费原结果前清恢复owner造成新seed；该场景重新验证通过。

基线 `%TEMP%/dsh-fortythird-baseline-a3cf8b96-e384-4920-830e-41c0298d7e49` 不包含dependency Junction。SDK当前SHA256 `CBE7C574F523BE1094E12C26F3C8BD4A10F2F960DC8226E58F95B420C8BE4D7A`，新operation模块 `49B727CBCCEF9A503D8A10F4635C9715E07D8A498AAC9170E3278371DB4A8670`。

## 收尾前待办（现已完成）

完成全应用同行审查，锁住二次observer取消后ACK不发送completion的恢复分支、native input的metadataOnly资源交接、submission端到端durable等待标记与取消清理。补齐README/CHANGELOG/工具及检查说明后，冻结源码与测试，运行verify、连续两次release、host和host-recovery、diff；门禁通过且正式idle才可受控重载。

正式DSH PID75196仍运行第42轮构建，认证health先前HTTP200；本轮再次只读activity为411sessions、running/waiting0。未重建`lib/`、未正式模型注入或重载、未commit/push/publish；历史corrupt会话及111workflow不改。完整本轮修复交付仍未完成。

## 最终应用审查后的补充进展

审查发现并修正了三个具体生命周期问题：cancelled行的清理被`ignoreCancelled:false`压制而留下durable等待marker；pending resume在取消交接窗口中由执行方和Lifecycle重复释放child/pin；Reconciliation的恢复三元分支没有统一包装阶段异常。新增`receiptCleanupClaimed`仅表示Lifecycle在实际证明后取得资源清理权，执行方finally据此不重复释放；已完成cap之后的普通终止错误则正常释放。

新增真实控制两项：暂停恢复的第一次SQL update再取消，未确认ACK时仍pin1/child未dispose，确认后仅释放一次；接回原模型完成结果后转换给非法JSON，进入failed并释放child/pin。取消API返回其较早快照，测试重新读取canonical row核验marker去除；转换失败允许按既有合同抛错并读取canonical failed行，不为测试改写生产合同。

最新全部新回归21/21通过，31.81秒，日志 `%TEMP%/dsh-fortythird-receipt-reviewed-target.log`；typecheck和diff检查通过。同行对上述具体修正已复核，无新的明确blocker。SDK/core/55既有相关控制的前述结果保留，未用新记录覆盖原RED。

本轮仍需完成检查说明更新、原生输入和submission端到端的交接验收、完整1171项套件及两次release/host门禁，之后才可重载。正式75196在最新只读activity中仍411sessions、running/waiting0，`lib/app-server.js`仍第42轮SHA256 `F4951772C6C49E34270662CB7B427F69AD002828C91A004CD89D086964819F54`。

## 最后交接验收

新增原生交接2/2通过：原回执接回`needs_input`后只回答原request一次；再次observer abort与失败ACK后，下次恢复即使确认ACK没有completion通知，也合法继续同thread。fixture曾漏传退出核查的root processId，业务结果原本通过；只修fixture参数，不计为应用RED。

Bridge全应用夹具发现两项实际RED，原证据分别保留在`%TEMP%/dsh-bridge-start-receipt-evidence-etfvQn`与`%TEMP%/dsh-bridge-start-receipt-evidence-Bpm8B4`：取消cleanup已确认但durable等待marker未清；observer先退出等待则marker缺失，且producer的进程census尚未完成时冻结了无证据guard。修正为先等待原operation evidence、按原session/submission/lease保存marker，确认原guard后仅清它自己的marker；Lifecycle追踪异步清理。

父会话收尾的注入提示另有真实RED：`pnpm exec tsx --test --test-name-pattern='unconfirmed original start receipt' test/workflow-stopping-route.test.ts`，1项失败，原提示把pending归入普通unavailable。新增专门回执分支，说明pending只检查原请求、late reply接回同turn、invalid只清理。新回执和收尾控制35/35通过，39.87秒，日志`%TEMP%/dsh-fortythird-final-target.log`。既有Bridge ownership与guard控制16/16通过，11.90秒，日志`%TEMP%/dsh-fortythird-bridge-guard-target.log`。

README、CHANGELOG和工具/自动触发说明已区分foreground resume与Bridge原submission后台重试；回执接回发送0个新的model-start RPC，不把它写成重复发送continuation。工具文字既有29/29通过，未修改旧断言。同行发现的直接取消与跨stage guard交接窗口正在用真实夹具补证；本段不预告完整门禁或正式部署结果。

上述最后两条反馈已闭环：直接取消的真实RED保留在`%TEMP%/dsh-bridge-start-receipt-evidence-yeiZjy`，原子会话在无可用回执时被提前销毁，模型pin仍1。`takeChild`现在先检查原submissionController的任务所有权，由任务finally或stop等待结算后清理。跨stage真实RED保留在`%TEMP%/dsh-bridge-start-receipt-evidence-mR8aBQ`：原visible RPC18已completed，conversion RPC34仍pending，却持旧epoch1的guard。现在只有前一operation的真实`finished()`证明允许同步确认旧guard并接入新generation；generation拒绝也不能跳过observer/live/heartbeat收尾。

原Bridge4项10.02秒全部通过；新增跨stage与这4项合计5/5通过，类型检查通过，最后只读审查无剩余具体blocker。新增跨stage测试`test/bridge-start-receipt-generation.test.ts`及独立backend不改既有fixture或期限。当前SDK与operation核心hash保持前述值；本轮源码、夹具和脚本248份已冻结到`%TEMP%/dsh-fortythird-source-freeze.json`。完整门禁日志目录`%TEMP%/dsh-fortythird-final-gates-af77b81d-eebe-4e38-8d9e-deb41ed0eb89`；开始运行verify、连续两次release、host、host-recovery和diff，不以启动门禁代替通过结果。

## 首次完整门禁暴露的夹具假设

首次verify发现两项既有夹具不再命中声明的窗口，两项均先独立复现失败并保留日志，再修正测试触发条件，未改SDK语义或放宽时间/断言：

- `app-server-callback.test.ts`的visible→fork取消测试默认让conversion在0ms完成。真实TEMP追踪`%TEMP%/dsh-callback-latch-order-8f3d51e39a2845c4b82e3e85efafa8e7`证明completion登记order14先于onStarted order15，exactCompletion为true；SDK合法省略已完成turn的interrupt，两条subscription各释放一次且未交verdict。只给此控制增加fake-only保持conversion活跃标记，原10秒等待及exactinterrupt/2 distinctrelease断言保留。独立复跑1/1通过，日志`%TEMP%/dsh-fortythird-latch-active-green.log`；原失败日志`%TEMP%/dsh-fortythird-latch-regression.log`保留。
- `foreground-new-review-round.test.ts`的launcher退出控制用第一个进程树查询触发kill。第43轮在提交时已开始原receipt的census，因而旧hook在failed ACK前杀掉transport。独立失败日志`%TEMP%/dsh-fortythird-launcher-capture-repro-751848a4-cebf-4e72-93cb-4babc988c005.log`保留。现在额外观察真实interrupt拒绝后才在真实execFile query存活时触发，原backend存活、durablebarrier、replacement拒绝、0新增model/thread/child和完整row不变均通过。独立1/1通过，日志`%TEMP%/dsh-fortythird-launcher-capture-green.log`。

两处只是使原控制测试其声称的active/failed-ACK窗口，源码hash未变；typecheck与diff再次通过。修正前冻结文件保留为`%TEMP%/dsh-fortythird-source-freeze-before-fixture-correction.json`，当前248份重新冻结。首次失败门禁不能计为成功发布门禁，须从verify重新执行整条链。

首次verify最终1179项、1177通过、2失败，447.07秒；取消、跳过、异步警告均0，两项失败正是上述已单独修正的夹具。保留整条失败门禁及summary。修正后重新执行门禁目录`%TEMP%/dsh-fortythird-final-gates-3e885e64-5b08-4c6d-9b31-7d34d67d9682`。

## 最终验收与正式运行

文件并发固定为2，场景内部并发、原时间界限与业务断言保持。最终248份源码/测试/脚本与冻结记录相符，未修改源代码以迁就两项旧夹具假设。

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1179/1179，exit0 | 435.79秒 |
| `pnpm release:check` 第一次 | 1179/1179，exit0 | 440.44秒 |
| `pnpm release:check` 第二次 | 1179/1179，exit0 | 441.82秒 |
| `pnpm host:check` | exit0 | 4.04秒 |
| `pnpm host:recovery:check` | exit0 | 7.06秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行的失败、取消、跳过与异步警告均0。完整summary位于上述最终门禁目录。release中的offline doctor按合同跳过5项真实Codex连接检查；实际SDK/stdio/native DSH的故障回归使用本地合成上游，不冒称真实provider、计费或浏览器复测。

正式DSH在重载前411sessions、running0、waiting0。已按原Node入口及`web --host 127.0.0.1 --port 3080 --no-open`参数受控重载，PID75196→86496，新进程出生时间`2026-10-07T02:12:23.4085070+08:00`。认证exchange303、health200且authenticated=true；listener为127.0.0.1:3080。捕获的旧树11个原进程实例均按birth证据确认退出。

重载后411个会话与111条canonical workflow保留，原parent metadata仍在；workflow完整哈希仍`96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8`。214份冻结build文件和receipt内21个关键模块hash全部一致，stderr fatal匹配0；activity仍running0、waiting0。

正式build：`lib/app-server.js` SHA256 `2C4CF3AD15A08608B488A096E301B347F82975555E14E298AA18065C669A80BA`；`lib/workflow.js` SHA256 `4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。重载receipt及verification保存在`%TEMP%/dsh-fortythird-reload-receipt.json`和`%TEMP%/dsh-fortythird-formal-verification.json`；认证state与formal stdout不纳入仓库或公开证据。

本轮处理调用方停止等待与原模型操作仍被托管的交接；等待回执的恢复不发送新model-start，原回执真实到达后接回原turn，普通可恢复失败继续原thread。失去原进程的历史ephemeral或corrupt子会话不重建，不由父会话代写结果。未commit、push或publish；本轮已完成，总体优化目标保持active。

