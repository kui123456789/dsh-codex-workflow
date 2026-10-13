# 第57轮：UTF-8 stderr分片与完整字符尾部

状态：第57轮完整验收与正式重载完成。verify及连续release两次均1280/1280通过，host加载/恢复及diff通过；正式PID130184，412个会话身份与111条workflow完整记录保持。首轮失败证据保留。总体持续优化目标active。

## 当前现场和实际RED

前一轮第56轮已完整串行验收、受控重载并核对正式数据，是实际进展。本轮再读PID120796/birth `2026-10-08T02:23:59.9336880+08:00`，412sessions/111workflows、available0/running0/waiting0、完整canonical/session hash及原parent/历史corrupt保持。HEAD仍abb6174，既有dirty工作保留。

真实本地backend先写“模”的两个字节 `e6a8`，父端明确收到这个不完整chunk后才写其余文本并actual exit42。旧SDK逐chunk String(Buffer)把原诊断变为 `��型连接中断，保留原会话继续处理。`。RED日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftyseventh-20261008/stderr-utf8-red.log`，现场 `%TEMP%/dsh-stderr-utf8-kvA9wF/utf8-result.json`，没有伪造事件或替换SDK方法。

SDK原child闭包增加UTF-8 StringDecoder，owner检查先于解码，actual exit生成error前结算已观察字节。原bounded stderr cap保持。第二项字符边界RED为UTF-16 tail裁切留下半个emoji；丢掉领先low surrogate后保持原16384单元上限，未增加model调用或诊断全文缓冲。

## 研究与验证反馈

[固定Node/Execa研究](../research/github-stderr-utf8-patterns-2026-10-08.md)保存本机Node24.14 source、文档和Execa encoding generator及许可，Context7核对write/end边界。不加依赖或复制实现，项目已有CLI StringDecoder路径保持。395份baseline及日志/固定源文件在本轮持久目录，依赖目录0；认证state/formal stdout仅TEMP不输出内容。

第一次3文件组合默认并发，多个native identity query返回不完整，原actor/cleanup按规则保持unknown，日志 `stderr-utf8-first-green.log`为实际失败，不因名称冒称GREEN。这些失败不能证明UTF-8逻辑错误或特定资源原因。无扩大native query或场景期限，改用仓库允许、上轮已采用的独立文件并发1。

串行原stderr/新UTF-8组合9/9、exit0，46.63秒，原65536字节late-pipe/current prefix/old marker控制保持。补充emoji/incomplete/bounded/half-surrogate的边界日志 `stderr-utf8-boundary-red.log`保留；中文case有初始birth缺失，测试把完整birth前置到fault之前，未伪造原证据。最终5/5、exit0，9.18秒，日志 `stderr-utf8-five-green.log`；typecheck/diff通过，相关串行控制正在原句柄执行。

SDK源码SHA256 `F553FCAE28A061D9203CEB8B5B23A66660885152A13102C561D461FBD5F4B0BB`。完整verify、连续release两次、host、host-recovery及diff通过，source/build freeze一致且正式idle后才重载。profile/provider/凭据、canonical/历史corrupt保持，未commit/push/publish。本地actual字节分片证明，不声称provider/Token费用/浏览器/Linux实机验收。

## 相关控制的真实未确认结果

原相关exec39864明确terminal exit1：79项中78通过、1失败，230.34秒，失败为既有stdout closed fixture最终等待原树退出，日志 `stderr-utf8-final-controls.log`。现场 `%TEMP%/dsh-output-close-VNTGDg/output-result.json` 的外层captured evidence只有processId125340、没有birth；原Readable确已关闭，RPC settled=true、pending0、available=false、原process stillAlive=true。不能据此把缺失出生证据当成已退出，也不能用它证明UTF-8断言失败。保留原规则和失败证据，单独串行原output-close与新UTF-8目标再执行，原清理和时限断言不放宽。正式没有重载。

最终原output-close与新UTF-8目标10/10、exit0，26.96秒，日志 `stderr-utf8-output-target.log`；正式PID120796保持，相关一项birth缺失未冒称已查明根因，未改生产proof规则。typecheck/diff通过。

## 完整门禁进行中

目录 `final-gates-4b016b98-b213-4239-b472-f7e37a588488/`，原exec96924，独立文件并发1（与上轮最终配置一致），各场景内部并发和时限不变。266份源码/测试/脚本freeze，每项完整verify/连续release/host门禁前后校验，预期1280项。SDK源码SHA256仍 `F553FCAE28A061D9203CEB8B5B23A66660885152A13102C561D461FBD5F4B0BB`。受控reload核对原PID120796及birth、六项完整门禁、source/build freeze和正式idle，只引用本轮目录；没有因观测等待到期重新运行原进程。

接续poll确认原exec96924仍running，266份freeze0偏差，正式412sessions/111workflows的完整hash及idle保持。verify运行中已记录2项失败：既有 `startReview interrupts ... thread settings fail` 与 `idle shutdown waits for an active turn ...`；本轮5项UTF-8及当前/retired stderr控制已通过。没有用局部通过放行。监视JS cell1989停止后，立即重poll实际gate句柄96924仍running，测试进程未中止；等待其完整终态输出以保留具体错误。

本轮运行中观察到可用内存低于1GiB，但未认定这是两项失败的确切原因，也没有停止用户应用或改时限。当前中途统计384项通过、2失败，不是完整结果。原完整链继续结算，正式未重载，总目标active。

## 原完整运行的终态与定向诊断

原exec96924已明确terminal exit1：verify共1280项，1277通过、3失败、cancelled/skipped均0、异步警告0，2053.93秒。后续release/host未运行，不能用本次结果放行重载。完整日志和summary保留在原 `final-gates-4b016b98-b213-4239-b472-f7e37a588488/`。

三项失败是 `startReview interrupts the reviewer turn when thread settings fail`、`idle shutdown waits for an active turn and releases the task after completion` 和 `a cold review_only waiting Reviewer admits actual changed evidence as a new business round`。错误栈均落在原进程树清理未确认，分别为SDK stop/idle cleanup路径；本轮5项UTF-8与原stderr-owner场景通过。原日志没有保存这三次失败的完整出生身份查询，因此不能把缺失采集、查询失败、实例仍存活或内存压力之一冒称确定根因。

外部 `cleanup-observer.mjs` 只观察原stop promise及已有证据，不查询OS、不改返回promise身份、不补造birth、不增加模型请求或清理重试。首次preload使用Windows反斜杠路径被Node拒绝，日志 `cleanup-target.log` 保留；改为真实file URI后，三项原失败测试加5项UTF-8场景8/8通过，17.99秒，无cancelled/skipped。日志 `cleanup-target-uri.log`、已有证据 `cleanup-target-observations.jsonl` 留存；该次可观察的清理持有完整原birth并成功。没有据此宣称上次根因已证明。

随后运行这三个原测试文件的完整相关控制，原场景预算和最终断言保持；生产源码hash和266份freeze不变，正式412sessions/111workflows及完整hash再次核对保持。诊断观察器仅在仓库旁证据目录，未进入生产或包文件。历史corrupt原子会话保留，未重建模型上下文。

## 控制中发现的展示采样误判

原exec50196明确terminal exit1：59项控制58通过、1失败，173.50秒；原3项清理场景通过，该次可观察stop均成功。新失败是既有 `visible Reviewer text streams before the turn finishes`：固定150毫秒采样为空，回合尚未完成。日志 `cleanup-controls.log` 和原证据 `cleanup-controls-observations.jsonl` 保留。

外部真实SDK探针给fixture控制RPC加入200毫秒延迟，原采样在156.83毫秒为空；实际两段消息在405.66毫秒到达、回合703.37毫秒完成，progress确实先于completion。探针 `reviewer-stream-sampling-red.log` / JSON保持；同样延迟加入原测试后，原150毫秒断言再次确定RED，日志 `reviewer-stream-test-red.log`。这证明固定观察时点会误判展示顺序，没有证明此前三项出生身份清理失败的根因。

仅该Reviewer测试和fake App Server改为事件屏障：真实delta完整到达后先断言原回合未完成及原文本，再以fixture专用RPC释放同一回合的completion。保留原5秒模型/控制超时、500毫秒完成延迟、真实pipe与完整文本断言；200毫秒RPC延迟锁定旧采样缺陷。测试不要求任意控制RPC都在150毫秒内完成，移除的是未经产品约定的固定采样点，没有放宽模型期限或清理证明。生产SDK及UTF-8修复未变。

定向原测试GREEN 1/1，3.97秒，`reviewer-stream-test-green.log`；typecheck及diff通过。随后原三个文件的完整59项控制在exec75840运行，尚未据此放行正式重载。相关输入完成后更新freeze只允许这两个已解释的测试文件变化，生产哈希保持。

## 更新输入后的完整链

原exec75840明确terminal exit0：三个完整文件59/59通过、cancelled/skipped均0，186.57秒，`cleanup-controls-after.log`；只读已有回执保留在 `cleanup-controls-after-observations.jsonl`，没有冒称原三项失败根因已确定。266份freeze原快照另存 `source-freeze-before-stream-barrier.json`，仅 `test/app-server.test.ts` 和 `test/fixtures/fake-codex-app-server.mjs` 两项有解释的变化；更新后0偏差，SDK源码hash仍为本轮原UTF-8修复。

新完整链原exec5979、目录 `final-gates-aaec2bbb-a1e6-45b0-9bd3-75464a1522f8/`。顺序仍为verify、连续release两次、host、host-recovery、diff；预期完整1280项、独立文件并发1，未跳过原失败案例。受控reload只引用这个新目录的完整结果，尚未执行；build freeze仍须最终门禁完成后生成。观察等待到期不创建另一个gate或正式进程。

门禁等待期间补充[中文DSH验收指南](../dsh-same-session-recovery.md)，从发布清单链接进入。提示词区分父回合中止、显式workflow取消、真实provider故障和Bridge后台恢复；按当前工具契约说明省略workflowId、原回执安全检查及中断确认，核对原workflow/thread/child身份。文档相对链接及diff通过，冻结输入0偏差。未创建新的正式验收会话或真实模型调用；该指南不把历史UI验收当作本轮已部署证明。

构建冻结操作另存 `freeze-final-build.ps1`，只接受本轮新目录六项完整门禁及三次1280/1280、0异步警告，核对266份源码后才允许保存217份最终build哈希和关联receipt。原未完成状态下实际调用被准确拒绝，`build-freeze-incomplete-guard.log`保留，build-freeze.json未写入；脚本解析0错误。成功生成清单仍须等待门禁终态，不把这个拒绝条件检查当成已生成或已重载。

新目录verify已明确exit0：1280/1280、fail/cancelled/skipped均0、异步警告0，2058.31秒，完整 `verify.log` 与 `summary.json`保留。此前3项清理失败案例在该完整运行通过，但此前查询失败的具体原因没有因此被证明。原exec5979继续执行release-1，未启动另一个门禁链；连续release两次、host、host-recovery及diff尚未得到终态，build freeze及正式重载仍未执行。

release-1等待期间通过Agent Reach GitHub/gh后端补充核对固定Execa提交中的管道测试：`test/pipe/streaming.js`的实际stdout事件观察发生在原输入端释放之前，对应本轮已修复的同回合事件屏障。4份源码原始字节与固定tree的Git blob哈希全部一致，许可、SHA256及tree SHA保留在 `github-sources/execa-test-synchronization-sources.json`。研究说明这次核对晚于本地修复和完整verify，且Execa部分IPC场景仍有固定等待，采用范围限于已指出的流事件顺序。没有据此宣称此前Windows身份查询失败原因已确定；当前冻结输入0偏差，原门禁链继续。

release-1已明确exit0：1280/1280、fail/cancelled/skipped均0、异步警告0，2040.19秒；`RELEASE_CHECK_OK`确认typecheck/test/build、offline doctor（5项明确skipped）、pack audit及临时tarball清理。原exec5979继续release-2，不创建另一条链。只读正式核查仍412sessions/111workflows、完整session/workflow哈希保持、running/waiting0、266份freeze0偏差；build freeze尚未写入，正式未重载。第二次release、host、host-recovery及diff仍待终态。

## 最终完整验收与正式加载

原exec5979已明确terminal exit0，最终证据为 `final-gates-aaec2bbb-a1e6-45b0-9bd3-75464a1522f8/summary.json` 及对应完整日志。原内部并发和回合预算保持，独立文件并发1。

| 门禁 | 最终结果 | 秒数 |
| --- | --- | --- |
| verify | 1280/1280，fail/cancelled/skipped/异步警告均0 | 2058.31 |
| release-1 | 1280/1280，RELEASE_CHECK_OK | 2040.19 |
| release-2 | 1280/1280，RELEASE_CHECK_OK | 1979.86 |
| host | ok=true，安装宿主0.1.7-rc.2，exit0 | 4.14 |
| host-recovery | ok=true，安装宿主0.1.7-rc.2，exit0 | 13.18 |
| diff-check | exit0 | — |

两次release的offline doctor均明确5项skipped，pack audit通过，临时tarball清理。最终build freeze在六项完整门禁结束后生成217条哈希及receipt；源码266份0偏差。未用早期局部GREEN或缺失出生证据放行。

受控reload原exec3228明确exit0：正式服务空闲时，校验原PID120796/birth及启动命令和listener，捕获11个原实例并确认全部退出；仅启动一次新PID **130184**，birth **2026-10-08T05:31:20.9656950+08:00**，监听 `127.0.0.1:3080`，认证交换303及健康HTTP200。认证state/formal stdout仍仅在TEMP且未输出内容。profile插件Junction和声明指向当前D盘仓库，linked SDK与本轮build一致。

重载后 `formal-verification.json` / `formal-plugin-provenance.json` 核对：217份build哈希、27个关键模块哈希0偏差，源码freeze0偏差；412个会话身份不变、原parent和历史child存在，111条workflow完整canonical记录不变，running/waiting0，stderr fatal扫描0。未把身份核对冒称所有会话消息逐字比对，也没有修复或重建历史corrupt模型上下文。

- Session身份SHA256：`579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`。
- Workflow完整记录SHA256：`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`；排序SQL和JSON recipe见formal metadata证据。
- 正式linked `lib/app-server.js` SHA256：`4D31EB6B177895462CECAA049514BE5E5135EF412C1BA65860AF0280B21BE79D`。

本轮证明本地真实UTF-8 pipe分片、同回合展示事件顺序、完整本地门禁及正式加载/记录保护。此前Windows查询失败具体根因仍未证明，真实provider自然故障、Token费用及Linux实机行为未由这些检查覆盖。provider/profile/凭据未修改，未commit/push/publish；持续优化总体目标保持active。
