# 第48轮：idle清理证明后才允许交接及后继启动

状态：修复、完整门禁、补充证据验证及正式重载已完成。正式DSH已加载第48轮PID105628；412sessions/111workflow及完整canonical记录保持。总体持续优化目标active，未commit/push/publish。下文保留阶段性失败及TEMP证据缺失记录，最终结果见末节。

## 真实反馈

`releaseThreadForExternal`等待的idleShutdown只关闭launcher。真实SDK/stdIO、launcher/backend两层回归先RED：交接返回后捕获树仍live，signal退出不等于backend退出。日志`%TEMP%/dsh-fortyeighth-handoff-tree-red.log`，证据`%TEMP%/dsh-external-handoff-tree-GjXHiC`保留；model0/订阅ACK1/捕获实例3。

候选为仅等待launcher、把订阅ACK当退出、后继启动绕过清理。现场ACK有效但backend存活，代码只await stopProcess，支持第一个；后两项作为边界覆盖，不伪称现场已创建新模型。

## 来源与实现

[固定Playwright/Execa及Node文档研究](../research/github-idle-process-retirement-patterns-2026-10-07.md)记录SHA、manifest、许可和限制。继续使用已有birth安全终止helper，没有复制外部实现、安装依赖或对未知PID强杀。

- idle退出保存原process/tree evidence，关闭launcher后证明捕获原实例全部退出。
- 失败保留idle retirement；后续明确start请求先接回原清理，无法证明时拒绝后继启动。
- 外部交接的初始等待及加入者均复用caller-only等待器，一个observer取消不撤销共享清理。
- 定时idle失败被内部清理状态保留并消费promise拒绝；永久stop接回它，失败后只重试原树且保持stopped标记。
- 新进程只由清理完成后的明确启动请求创建；不恢复失去原进程的ephemeral工作流。

## 验收

五个真实launcher/backend case全部通过：常规交接、实际终止helper进程拒绝后原树重试、并发start等待原树证明且只启动一个明确后继、永久stop失败后清理重试、observer取消。最后一项先RED后GREEN，原日志`%TEMP%/dsh-fortyeighth-handoff-observer-red.log`保留，初版实际SIGTERM退出及tree未结束的RED也保持。

最终SDK/初始化/stdio/fork/原生组合91/91通过，82.92秒，日志`%TEMP%/dsh-fortyeighth-final-target.log`；typecheck/diff通过。SDK源码SHA256 `AC4654B5F57FA90F347C4F2719A080312066FEA949DA66BBF7349232D97E76FC`。场景期限及业务assertion未放宽。

baseline `%TEMP%/dsh-fortyeighth-baseline-1a05b179-2680-4840-ae98-334dd49fb15e`有362份源码/测试/文档，依赖目录0。历史corrupt、canonical记录及profile/provider/凭据保持；Linux pidfd未在WSL执行，合成backend不是实际provider/Token/真实CLI文件锁验收。

完整链要求verify、连续两次release、host、host-recovery及diff，最终freeze匹配且正式无运行/等待workflow后才受控重载。任何后续新增会话均纳入重载前后数据快照，不能用旧数量覆盖。

## 完整门禁已启动

首次目录`%TEMP%/dsh-fortyeighth-final-gates-fdfc7a6b-90a3-4d83-99e1-25662b490568`。verify1214/1214、exit0通过，588.47秒；release1为1213/1214、fail1、exit1，650.11秒；取消/跳过/异步警告均0。原exec77024已确认terminal exit1，未进入release2或host。五个新原生case全部通过，唯一失败为旧callback receipt观测前置条件，见后节。文件并发2，场景原有并发/assertion/期限保持。受控重载helper须改为修正后新链，不能使用此次失败summary；当前尚未正式加载。

## 首次release与原回执的SDK观测前置条件

旧`callback visible-abort`失败为actor第87行的available=false断言。独立复跑GREEN（3.88秒）不能当修复。候选原因是backend gate与SDK消费时序、owner变化、idle清理干扰；该fixture idleProcessMs=0，随后真实backend将held原receipt延迟120ms，精确重放同一false/true断言，gateReceiptWritten1/realReceipts0/modelStarts1/available=false/pending=true，说明尚未发送的真实回执不能被当作SDK可继续能力。

原生SDK/stdIO RED日志`%TEMP%/dsh-fortyeighth-callback-receipt-red.log`，证据`%TEMP%/dsh-fortyeighth-callback-receipt-174ceb19-38cc-46a2-bd2b-962077b04264`。修改仅在actor原gate后使用既有sharedWaitFor读取dispatcher.availableContinuation，等待原回执真正ready，再执行原assert；不新增RPC、不增加模型继续预算、不放宽断言或deadline。生产SDK源码仍`AC4654B5F57FA90F347C4F2719A080312066FEA949DA66BBF7349232D97E76FC`。

相同真实120ms延迟GREEN，日志`%TEMP%/dsh-fortyeighth-callback-receipt-green.log`，证据`%TEMP%/dsh-fortyeighth-callback-receipt-green-6ce9899a-4ac9-441f-b1ef-7d216f42f844`。既有visible-abort case默认启用这项延迟，callback backend新增可选参数默认0；actor失败时保存安全合成states/wire以利复核。旧失败链及freeze保留，相关回调控制结算后重新冻结255份输入，从verify重跑完整门禁。

## 修正后的完整链

callback/Bridge回执控制16/16通过，38.12秒，日志`%TEMP%/dsh-fortyeighth-callback-receipt-suite-ready.log`；typecheck/diff通过。旧255份freeze保存在`%TEMP%/dsh-fortyeighth-source-freeze-before-sdk-receipt-ready.json`，修正后255份已重新冻结。新链目录`%TEMP%/dsh-fortyeighth-final-gates-41b22f0f-6710-450b-add5-0d64f6ae342d`，verify1214/1214、exit0通过，755.80秒，失败/取消/跳过/异步警告0；先前失败的visible-abort和五个原生交接case均通过。exec82769仍live，已进入第一次release，文件并发2。重载helper已改用本链目录，旧失败链引用0、语法检查0错误。正式第47轮尚未重载。后续接回同句柄，以summary及terminal exit记录其余结果，不用旧链的GREEN替代新链。

## TEMP证据缺失与原链持续结算

原exec82769仍live时，TEMP内verify原日志、summary、255份freeze和多份helper已不在；删除者与原因未确定，不能据此声称原进程结束。release1日志仍增长，随后原进程实际结算1214/1214、exit0，744.67秒，失败/取消/跳过/异步警告0，再进入release2。已把可读取的release1及原runner重新生成的summary保存到仓库旁`D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fortyeighth-20261007/`，保存当前255份输入hash为`source-freeze-after-temp-loss.json`；这是新现场freeze，不能称作原freeze的恢复。SDK源码仍AC4654...。

原正式stdout仍在，认证state缺失。既有runtime-smoke helper禁止把认证state写到TEMP外；首次请求被拒绝且未写入，随后按该契约从原log恢复state到TEMP，exchange303/health200，PID104552/birth仍匹配。认证state及stdout不复制到持久证据目录或输出。正式service未重启，未改profile/provider/凭据。原链继续接回同句柄，待release2及host完成后补齐缺失verify日志所对应的验证，再根据当前冻结输入及全部证据决定加载。

## 原链结算及补充验证

同exec82769已确认terminal exit0：verify1214/1214、755.80秒；release1同样1214/1214、744.67秒；release2同样1214/1214、702.57秒；host exit0、4.82秒；host-recovery exit0、11.21秒；diff exit0。三个全量运行失败/取消/跳过/异步警告0。两次release离线doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理完成。

仍可读取的release1/release2/host/host-recovery/diff原日志与重新生成的terminal summary已经保存到上述持久目录；原verify日志已缺失，不把口述或summary当作重新取得原日志。已启动`supplement-verify.ps1`对应的补充verify，exec56298仍live，日志为`supplement-verify.log`，采用新现场255份freeze，前后检查一致性。它只补缺失verify的可复核证据，没有因观察等待到期重启原链或重复两个已完成release。

持久目录的formal-metadata helper已恢复只读session与canonical SQL核查：412sessions、111workflow、原parent/child存在、running0/waiting0。重建hash配方明确为`SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id`结果的JSON.stringify及SHA256，当前`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`；该配方与失去的旧helper未比较，不能直接把新hash值当旧96a219...配方的延续，正式重载以同一新配方的前后快照比较。

已在持久目录准备新的controlled-reload及原树retire helper，语法检查0错误。要求原完整六项门禁、补充verify、255份新现场freeze、217份最终build freeze匹配，核对原PID104552的已知birth/启动命令/唯一listener及idle。复用已验证的Windows handle/birth终止helper，确认原树退出才启动新service；敏感stdout/认证state仍在TEMP。以下最终结果为补充验证完成后实际执行，不以准备状态代替部署证明。

## 最终门禁、补充证据与正式运行

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| 原链 `pnpm verify` | 1214/1214，exit0；原日志缺失，原进程输出及summary保留 | 755.80秒 |
| `pnpm release:check` 第一次 | 1214/1214，exit0；完整日志保留 | 744.67秒 |
| `pnpm release:check` 第二次 | 1214/1214，exit0；完整日志保留 | 702.57秒 |
| `pnpm host:check` | exit0；日志保留 | 4.82秒 |
| `pnpm host:recovery:check` | exit0；日志保留 | 11.21秒 |
| `git diff --check` | exit0 | 已记录 |
| 补充 `pnpm verify` | 1214/1214，exit0；持久目录完整日志及新freeze前后匹配 | 671.11秒 |

原链在同exec82769确认terminal exit0，补充验证在同exec56298确认terminal exit0；未因观测等待到期重启它们。四个全量运行失败/取消/跳过/异步警告均0；两个release的offline doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理完成。补充检查专门填补原verify日志缺失，未重复已完整保留的两个release。

补充验证前后新现场255份源码/测试/脚本hash匹配0偏差，最终217份build冻结后再执行重载。重载前metadata为412sessions、available0/running0/waiting0、111workflow、原parent及历史child存在；同新配方workflow哈希`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。全部会话ID排序JSON的SHA256为`579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`。

受控helper核对原PID104552/birth、完整门禁及补充验证、freeze、启动命令和唯一listener后，使用原Windows handle/birth终止helper清理捕获树11个原实例，独立证明全部退出，随后启动PID105628。新birth为`2026-10-07T12:23:39.5204040+08:00`；参数保持`web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303、authenticated=true、health200；唯一listener为127.0.0.1:3080。

重载后412sessions、全部会话ID hash、111workflow完整SQL记录hash、原parent及历史child保持；217份冻结build及新receipt的25个关键模块hash一致，stderr fatal0，activity仍running0/waiting0。新receipt额外记录app-server/workflow/planner三个模块，关键模块数因此由旧22增至25，不是旧receipt的恢复。

SDK源码SHA256仍`AC4654B5F57FA90F347C4F2719A080312066FEA949DA66BBF7349232D97E76FC`；`lib/app-server.js`为`9765E2204A6781A7C77507138C928628C08D45EBBDD9AE415390ADC97176CF65`，`lib/workflow.js`保持`4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。

正式receipt、before/after、完整新SQL hash配方、旧树证据和formal-verification保存于`D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fortyeighth-20261007/`，认证state/formal stdout仍只在TEMP，未输出或复制到持久目录。部分旧TEMP证据缺失是实际限制，未补造旧目录或原hash快照；剩余原链及补充验收提供当前源码验证证据。

host恢复验收使用已安装DSH服务、真实SDK/stdIO和本地合成上游，五个新增launcher/backend场景在Windows实际执行；不冒称真实provider故障、Token计费、CLI实际writer锁或浏览器交互验收，Linux pidfd未在WSL执行。未改profile/provider/凭据，历史corrupt或失去原进程的ephemeral会话未复建，未commit/push/publish。第48轮落地，总体持续优化目标保持active。
