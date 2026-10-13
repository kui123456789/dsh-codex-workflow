# 外部机制采用与验证状态

本页按时间顺序保留此前研究与验收现场，其中“当前”指对应段落记录时刻。最新源码采用与正式运行状态以[2026-10-10检查点](adoption-status-2026-10-10.md)和对应迭代完成证据为准。

这是对已有固定源码研究的整理，不是新的上游版本调查。最终核对日期为2026-10-09；第87轮cold projection修正已完整验收并受控加载，正式PID3436，第84轮及更早机制保持。固定提交和许可请进入对应报告读取，不能把候选或历史建议当成已部署功能。

## 当前交付状态

第84轮[Planner过程状态投影](github-planner-process-projection-patterns-2026-10-09.md)已完整验收。第86轮发现cold renderer缺陷；第87轮[稳定加载快照](github-cached-external-store-snapshot-patterns-2026-10-09.md)完成原6项RED、相关44/44、typecheck、verify/release各1496/1496、host/11恢复/diff及正式加载PID3436。414会话身份、111workflow、119queue、当前429文件全量哈希保持；实际服务字节包含新guard，详见[最终记录](../iterations/2026-10-09-eightyseventh-cold-projection-snapshot.md)。

第83轮新增[显式状态展示](github-workflow-state-presentation-patterns-2026-10-09.md)：13项回归原9失败/4控制，相关29/29及typecheck通过；原生summary UI暂停/完成提示与attempt标签通过，业务周期1。原verify/release各1481/1481，host/11持久回放/diff通过，正式受控加载PID36424、服务字节包含修正。414会话身份及111workflow/119queue前后保持；原428文件hash保持，新增会话文件无加载前字节清单，边界见[最终记录](../iterations/2026-10-09-eightythird-review-status-presentation.md)。[第84轮Planner暂停契约](../iterations/2026-10-09-eightyfourth-planner-waiting-view-diagnosis.md)在独立副本取得候选GREEN，尚未合入或加载，不能用Reviewer结果代替它。

| 机制 | 工作区状态 | 实际证据与边界 |
| --- | --- | --- |
| [日志持久化与独立读取](github-session-journal-retirement-patterns-2026-10-09.md) | 已完整验收 | 第78轮原host-recovery的11场景均通过`persistedColdReplay`；verify/release各1468/1468，host/diff通过。第76轮原release失败仍保留。 |
| [实际浏览器模块注册](github-native-client-registration-patterns-2026-10-09.md) | 已用于隔离验收 | Planner自动开栏通过；暴露Reviewer汇总页抢焦点。真实原生UI、轻量Agent工厂和脚本网关，不代表真实provider故障或费用。 |
| Reviewer优先选择最新审查的原child | [第78轮](../iterations/2026-10-09-seventyeighth-reviewer-sidebar-regression.md)已完整验收并受控加载 | 相关14/14、完整verify/release各1468/1468，异步警告0；候选全过程保持原标签。正式boot和服务client包含冻结修正代码。 |
| 初始化清理异常观察 | 保留原失败，没有生产修正 | [第79轮](../iterations/2026-10-09-seventyninth-initialization-cleanup-observation.md)8样本未复现，48原实例退出、模型0；第76轮143ms失败原因仍未知。 |
| 受控加载守卫 | [第82轮](../iterations/2026-10-09-eightysecond-final-gates-and-formal-load.md)执行通过 | 原formal11实例树退出，新PID57092出生身份与监听匹配；413会话、111workflow、119queue、428会话文件保持。217build及27关键模块偏差0。 |

第78轮原runner43236于08:53:10结束exit0；受控加载结果见第82轮。固定提交和许可见对应研究，真实provider自然故障、费用及完整AgentLoop组合仍需独立验收，历史corrupt child未恢复。

## 已完成验收与加载的历史机制

第74轮补充[续租timer的存储异常隔离](github-lease-heartbeat-error-patterns-2026-10-09.md)：实际第二SQLite连接BEGIN IMMEDIATE使旧心跳抛未捕获database is locked，丢失回调0；修复后原timer退休并通知owner一次。8项新回归、相关53项、typecheck及实际probe通过，活跃Reviewer原turn被取消、child释放，无新模型。5份固定源码/许可核对，生产只捕获heartbeat续租，显式renew/release及正式busy_timeout不变。完整verify/release各1463/1463、失败/取消/跳过/TODO及异步警告0，doctor/pack、host加载/恢复和diff通过；受控加载新PID41660，原11个实例退出，217份build及27个关键模块hash匹配、413个会话身份及111条workflow完整记录保持。前轮自然通知原因仍未定位，见[第74轮最终记录](../iterations/2026-10-09-seventyfourth-lease-heartbeat-errors.md)。

第73轮补充[共享Reviewer测试取消与原清理](github-test-context-cancellation-patterns-2026-10-09.md)：受控lease wait取消RED后，step观察原TestContext signal、after/finally合并close、先stop manager再等待原callbacks；六个原30秒用例和业务断言保持。初始6项5失败1控制，background路由纠正后的独立RED保留，最终7项及相关38项、typecheck/原probe通过；真实原生超时仍exit1但自然清理，不把取消改为pass。完整verify/release各1455/1455、失败/取消/跳过/TODO及异步警告0，doctor/pack、host加载/恢复及diff通过。217份生产build与正式版本完全一致，保留PID4448，health200、413个会话身份及111条workflow保持；测试改进通过原仓库链接生效。原自然通知时序未单独定位，原第72轮失败记录保留，见[第73轮最终记录](../iterations/2026-10-09-seventythird-shared-reviewer-test-cancellation.md)。

第72轮新增[后台验收的TAP环境入口](github-test-reporter-console-patterns-2026-10-09.md)。仓库release原来按实际exit判断；改进共享launcher以spec|tap环境选择ASCII汇总，显式参数优先，计数、skip/todo和真实失败退出保持。13项回归、typecheck及代码页936探针通过，6份源码/许可核对。原verify1448/1448及release1447通过/1取消记录保留；TAP入口随后连同第73轮清理修复完整verify/release各1455/1455、host/diff通过，计数直接解析、无编码修复。生产build不变，原DSH实例保持，见[第72轮记录](../iterations/2026-10-09-seventysecond-test-reporter-console.md)及第73轮最终证据。

第71轮处理[已接纳signal跨阶段的原取消原因](github-cli-firstcause-handoff-patterns-2026-10-09.md)：原caller/API取消先于stop时保持原因，匹配原signal与workflow/submission；新请求、身份变化和callback错误维持原规则。20项初始10失败10控制通过，修复后20及相关167全部通过，typecheck/原probe通过，8份固定源码/许可核对。完整verify/release各1435/1435、0异步警告，doctor/pack、host加载/恢复和diff通过。原release及正式进程中断后确认缺席，保留原日志和verify收据；后台补验收的实际exit0和乱码数字汇总独立审计，未重复已完成测试。一次冷启动的新PID4448，217份build及27个关键模块hash匹配、413个会话身份、428份session文件及111条workflow记录保持；原树未采集，未伪造退出证明。见[第71轮最终记录](../iterations/2026-10-09-seventyfirst-cli-firstcause-handoff.md)。

第70轮新增[完整CLI公开调用的取消责任](github-cli-pipeline-cancellation-patterns-2026-10-08.md)，延伸至成功输出保存及最终回调，已接纳callback结算后阻止下游模型及成功交付。真实RED为capture后再发第二个模型进程；初始16项12失败4通过，修复后16及相关147项全部通过，typecheck/真实probe通过，8份固定源码与许可核对。完整verify/release各1415/1415、失败/取消/跳过和异步警告0，doctor/包审计、host加载/恢复及diff通过。受控加载的新PID148600，原11个实例退出，217份build及27个关键模块hash匹配、413个会话身份与111条workflow记录保持。后续caller先取消再stop的原因覆盖已独立确认，模型请求0，待下一轮修复；见[第70轮最终记录](../iterations/2026-10-08-seventieth-cli-pipeline-cancellation.md)。

第69轮新增[CLI整个重试调用的目标取消](github-cli-retry-operation-cancellation-patterns-2026-10-08.md)，覆盖子进程已退出后的backoff空隙。初始15项13失败2通过、修复后15通过，另补2个控制；相关回归发现重复kill后已修正，顺序复跑131/131及真实probe通过。完整verify/release各1399/1399、失败/取消/跳过及异步警告0，doctor/包审计、host加载/恢复及diff通过；受控加载的新PID148336，原11个实例退出，217份build及27个关键模块hash匹配、413个会话身份与111条workflow记录保持。原取消范围延伸至整个retry，显式新调用仍可复用身份；详情见[第69轮最终记录](../iterations/2026-10-08-sixtyninth-cli-retry-operation-cancellation.md)。

| 本项目问题 | 参考机制 | 实现及验收入口 | 边界 |
| --- | --- | --- | --- |
| 失败后重建Planner/Reviewer | [OpenCode、LangGraph、Goose：稳定身份、运行归属、取消传播](github-workflow-patterns-2026-10-05.md) | [Planner身份](../../src/application/planner-run-identity.ts)、[Reviewer身份](../../src/application/reviewer-run-identity.ts)、[恢复测试](../../test/workflow-resume.test.ts) | 持久记录不能重建丢失的ephemeral模型上下文 |
| 下游失败重跑成功审查 | [Inngest、Temporal：成功步骤与下游失败分开](github-review-checkpoint-patterns-2026-10-06.md) | [前台checkpoint](../../src/application/foreground-review-checkpoint.ts)、[后台checkpoint](../../src/application/submission-review-checkpoint.ts)、[阶段恢复测试](../../test/foreground-review-stage-recovery.test.ts) | 工作范围、配置和证据必须匹配原结果；不是任意输入的缓存 |
| 默认展示重复用量历史 | [Codex、OpenCode、Goose：canonical值与展示投影分离](github-tool-result-patterns-2026-10-05.md) | [展示投影](../../src/tool-usage-render.ts)、[投影测试](../../test/tool-usage-render.test.ts) | 完整账本保留；UTF-8字节数不是Token或费用 |
| 累计通知被重复相加 | [用量来源与累计基线](github-usage-budget-patterns-2026-10-05.md) | [线程计数](../../src/usage-accounting.ts)、[持久用量测试](../../test/durable-workflow-usage.test.ts) | 缺少provider计数时保持未知，不估算真实账单 |
| 转换成功但释放失败 | [LangGraph、p-retry：保留成功结果并限制重试范围](github-completed-task-cleanup-recovery-patterns-2026-10-07.md) | [SDK fork结果与释放](../../src/app-server.ts)、[原回执测试](../../test/fork-creation-receipt.test.ts)、[第47轮记录](../iterations/2026-10-07-fortyseventh-completed-conversion-cleanup.md) | 同一输入/owner才可用原结果，清理不能回放模型或callback |
| launcher退出后backend还活着 | [Playwright、Execa：等待退出和清理](github-unexpected-launcher-exit-ownership-patterns-2026-10-07.md) | [原树采集](../../src/infrastructure/process-transport.ts)、[原实例清理](../../src/infrastructure/process-tree-cleanup.ts)、[第51轮记录](../iterations/2026-10-07-fiftyfirst-unexpected-launcher-exit.md) | 必须校验birth/handle，不复制bare-PID/group终止策略 |
| Windows信号探针EPERM不消失 | [libuv、psutil：独立存在性查询](github-windows-process-absence-patterns-2026-10-07.md) | [缺席证明](../../src/infrastructure/process-transport.ts)、[独立查询测试](../../test/process-absence-fallback.test.ts)、[第53轮记录](../iterations/2026-10-07-fiftythird-native-absence-proof.md) | EPERM、漏项和失败查询本身均不是退出证明 |
| 无stdio的异步spawn失败 | [Node、cross-spawn、MCP SDK：先持有原child再等待失败receipt](github-missing-stdio-spawn-patterns-2026-10-07.md) | [transport](../../src/infrastructure/process-transport.ts)、[隔离契约测试](../../test/missing-stdio-spawn.test.ts)、[第55轮记录](../iterations/2026-10-07-fiftyfifth-missing-stdio-spawn.md) | EMFILE/ENFILE是受控回放，没有耗尽正式系统句柄；有PID路径另外验证清理 |

表中“已实现”依据当前代码及各轮完成记录。第56至70轮完整门禁构成历史基线；当前正式运行以第71轮完整verify/release的两个1435/1435、host加载/恢复及受控冷启动证据为准，217份build和27个关键模块哈希匹配、413个会话身份、428份session文件及111条workflow完整记录保持。原中断进程树未采集，记录不声称原树退出证明。没有把这些门禁泛化为真实provider故障、Token计费、浏览器交互或Linux实机验收。

## 第56轮诊断流隔离已加载

[stderr诊断错误研究](github-stderr-diagnostic-error-patterns-2026-10-07.md)借鉴诊断通道与协议通道分离，并以Node事件契约确认必须消费Readable错误。当前代码已实现：健康stdin/stdout继续使用原owner；只有当前进程实际退出时才带固定诊断不可用标记；退休stderr不能污染后继。

相关96/96及stderr/缺席目标21/21通过，早期完整链的实际失败仍保留；未用局部结果放行。最终独立文件并发1的完整verify与连续两次release均1275/1275，内部并发、原时限和最终断言保持；host加载/恢复与diff通过。原进程结算exit0、freeze一致且服务空闲后才受控重载，该轮正式PID120796、数据身份和完整记录hash保持。未证明早期系统查询失败的确切根因。历史验收见[第56轮记录](../iterations/2026-10-07-fiftysixth-stderr-diagnostic-error.md)。

## 第57轮UTF-8诊断与展示测试已验收加载

[UTF-8分片研究](github-stderr-utf8-patterns-2026-10-08.md)已采用每原child独立StringDecoder及完整字符尾部，5个真实pipe场景通过。控制中复现固定150毫秒展示采样误判，改为真实消息与同回合completion的事件屏障，保留原模型超时及文本断言；固定Execa源码提供后续独立核对。相关控制59/59通过，最终verify及连续release两次均1280/1280、0异步警告；离线doctor（5项skipped）、包审计、host加载/恢复及diff通过。原链terminal exit0及正式空闲后受控重载，新PID130184/birth2026-10-08T05:31:20.9656950+08:00，217份build和27个关键模块哈希匹配，412个会话身份和111条workflow完整记录保持，插件Junction指向本轮仓库。首轮3项原清理确认失败证据保留，其系统查询根因仍未证明。真实provider自然故障、Token费用及Linux实机不由本轮证明。最终证据见[第57轮记录](../iterations/2026-10-08-fiftyseventh-stderr-utf8.md)。

## 第58轮退出后的诊断收尾已验收加载

[Node/Execa退出与流收尾研究](github-exit-stderr-drain-patterns-2026-10-08.md)对应真实RED：原进程exit42后60字节诊断完整到达，旧SDK却返回空尾部。当前已实施最多100毫秒的原诊断收尾和失效结算屏障，原线程立即不可用，后继与stop加入原失败后再处理原OS证据；17项诊断及71项生命周期控制通过。冻结275份代码和发布输入，verify及连续release两次均1284/1284、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复及diff通过。原门禁链exit0且正式空闲后受控重载，新PID130352/birth2026-10-08T07:49:43.9657780+08:00；旧11个实例已退出，217份build与27个关键模块匹配、412个会话身份与111条workflow完整记录保持。原未确认控制日志保留；诊断deadline不替代物理整树退出证明，真实provider自然故障、Token费用及Linux实机不由本轮证明。详见[第58轮最终记录](../iterations/2026-10-08-fiftyeighth-exit-stderr-drain.md)。

## 第59轮诊断摘要字节预算已验收加载

[Node/truncate/Execa字节预算研究](github-diagnostic-byte-budget-patterns-2026-10-08.md)对应实际RED：2048字节上限返回5422字节中文诊断。共享摘要现按真实UTF-8裁切头尾、保留完整code point，标记计入总预算并显示精确省略字节数；极小预算只保留完整前缀。完整局部32/32及真实本地CLI控制通过，终止分类仍读取完整原诊断且只启动一次。冻结276份代码及发布输入，verify和release均1289/1289、0异步警告；offline doctor（5项skipped）、包审计、host加载/恢复及diff通过。原链exit0且正式空闲后受控重载，新PID132660/birth2026-10-08T08:59:48.2582700+08:00，旧11个实例退出，217份build与27个关键模块匹配，412个会话身份及111条workflow完整记录保持。此契约限于共享摘要，未改变App Server字符尾部或另一处局部摘要；不证明Token费用、grapheme完整性或provider自然故障。详见[第59轮最终记录](../iterations/2026-10-08-fiftyninth-diagnostic-byte-budget.md)。

## 第60轮迟到重试接纳已验收加载

[p-retry/Node异步边界研究](github-retry-wakeup-deadline-patterns-2026-10-08.md)对应实际RED：50毫秒预算在210毫秒唤醒后仍接纳第二次操作。当前control、visible及CLI原sleep后先保留取消原因，再重查原deadline，不重复线程或重置独立continuation预算。14项定向、163项完整局部及真实CLI控制通过；首轮完整1301/1303，两项旧测试的时钟/截止假设失败。修正模拟、保持原配置后2/2及64/64通过，277份输入更新仅两项测试并保存原快照。最终verify/release各1303/1303、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复及diff通过。原链exit0且正式空闲后受控重载，新PID129228/birth2026-10-08T11:00:34.2682370+08:00；旧11个实例退出，217份build和27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。此修改不等于全任务硬截止、时钟回拨保护或真实Token费用节省。详见[第60轮最终记录](../iterations/2026-10-08-sixtieth-retry-wakeup-deadline.md)。

## 第61轮最终等待上限已验收加载

[p-retry/Coveo/cenkalti机制比较](github-retry-delay-ceiling-patterns-2026-10-08.md)对应实际RED：配置60000上限，抖动后75000导致65000预算提前耗尽。当前共享backoff计算在抖动和round后落实最终上限，保留负向抖动机制与原最低等待；7项新增控制旧实现6失败1通过，修复后7/7、5个完整相关文件169/169、typecheck及实际本地CLI通过。最终verify/release各1310/1310、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。首次重载因操作helper出生标识未更新而在信号前拒绝，证据保留；只修正操作helper并通过独立身份探针，应用冻结输入保持。空闲后受控重载的新PID139496/birth2026-10-08T12:19:03.6647040+08:00，旧11个实例退出，217份build和27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。没有增加依赖或更改独立continuation权限，不宣称墙钟硬上限或Token节省。详见[第61轮最终记录](../iterations/2026-10-08-sixtyfirst-retry-delay-ceiling.md)。

## 第62轮CLI保留字节预算已验收加载

[Execa/Node流输出研究](github-cli-output-byte-bound-patterns-2026-10-08.md)对应真实RED：CLI配置64字节却保留128字节emoji；旧9项新增控制8失败1通过。当前stderr data/end按真实UTF-8尾部裁切，stdout end补既有overflow检查并保留第一次取消原因。10项定向、typecheck、5个完整相关文件50/50及真实CLI/backend收尾验证通过。固定9份源码字节与Git blob核对，许可保留；没有新增依赖或改变原模型/线程归属。最终verify/release各1320/1320、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID142580/birth2026-10-08T13:38:23.6914740+08:00，旧11个实例退出，217份build和27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不把保留字符串预算泛化为总内存硬上限或完整诊断。详见[第62轮最终记录](../iterations/2026-10-08-sixtysecond-cli-output-byte-bound.md)。

## 第63轮CLI诊断流错误隔离已验收加载

[Execa/Node每流错误责任研究](github-cli-stderr-error-ownership-patterns-2026-10-08.md)对应真实RED：stderr Readable error使CLI宿主probe退出；初始7项控制6失败1通过，原6份actor有uncaught记录。当前持续消费每原stderr的错误，健康stdout照常返回；失败出口独立标记不可用且原分类保持，旧流不能污染后继。9/9、6个完整相关文件59/59、typecheck和真实probe通过，固定6份源码字节与许可保存。首轮完整1328/1329的既有Bridge取消时序失败保留；真实双路径探针确认第二取消加入旧flight，只补测试事件屏障后目标1/1、相关69/69通过，生产源码/预算不变。最终verify/release各1329/1329、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID133572/birth2026-10-08T15:23:20.0347900+08:00，旧11个实例退出，217份build和27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。被自动审批拒绝删除的负向probe目录保持留存；不等于修复坏管道、完整诊断或自然provider故障验收。详见[第63轮最终记录](../iterations/2026-10-08-sixtythird-cli-stderr-error-ownership.md)。

## 第64轮CLI输入/输出流错误归属已验收加载

[Execa/Node模型流失败结算研究](github-cli-model-stream-ownership-patterns-2026-10-08.md)对应真实RED：stdout error使原宿主probe退出，待完成stdin写入同样没有错误消费者。当前原stdin/stdout流错误和同步prompt end异常沿用原abort/close，首次原因和已接纳身份绑定保持，旧流错误不能杀后继。初步11项、相关70/70及真实probe通过；追加identity binding控制后最终相关71/71、typecheck通过。8份固定源码/测试/许可与Git blob一致，未增加依赖。最终verify/release各1341/1341、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID141052/birth2026-10-08T16:36:14.4061880+08:00，旧11个实例退出，217份build和27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不泛化为静默管道故障、后代整树退出或整个workflow永不重试。详见[第64轮最终记录](../iterations/2026-10-08-sixtyfourth-cli-model-stream-ownership.md)。

## 第65轮原CLI绑定的取消观察已验收加载

[Execa/Node观察寿命研究](github-cli-binding-cancellation-lifetime-patterns-2026-10-08.md)对应真实RED：CLI已exit1而原onThread保存仍暂停，caller取消被移除的监听器漏掉。旧9项控制2失败7通过，修复仅移动abort监听清理到原binding结算；首次pending cause、一次原保存、无额外kill和最终listener移除保持。9/9、typecheck、80/80相关控制与真实probe通过，9份固定源码/许可字节与Git blob核对，未增加依赖。最终verify/release各1350/1350、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID123048/birth2026-10-08T17:46:23.4318560+08:00，旧11个实例退出，217份build与27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不是原callback永不结算的硬时限或整个workflow所有取消语义改写。详见[第65轮最终记录](../iterations/2026-10-08-sixtyfifth-cli-binding-cancellation-lifetime.md)。

## 第66轮CLI等待者取消已验收加载

[p-queue/Node独立取消研究](github-cli-queued-waiter-cancellation-patterns-2026-10-08.md)对应真实RED：同Reviewer owner仍在运行，queued caller取消后不能返回；初始7项控制4失败3通过。当前原waitThreadIdle独立观察caller signal并清理自己的listener，owner进程/绑定与peer waiter不被取消。初始7/7、公开review/释放竞态2/2、最终相关89/89、typecheck及真实probe通过，固定9份源码/许可字节与Git blob核对，未增加依赖。最终verify/release各1359/1359、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID89636/birth2026-10-08T19:01:38.8152830+08:00，旧11个实例退出，217份build与27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不是新队列调度或workflow/submission cancel路由改写。详见[第66轮最终记录](../iterations/2026-10-08-sixtysixth-cli-queued-waiter-cancellation.md)。

## 第67轮同CLI线程的准入预留已验收加载

[p-queue/async-mutex同步占用研究](github-cli-thread-admission-patterns-2026-10-08.md)对应真实RED：原owner结束后两名同Reviewer waiter同时spawn，两个后继存活。正确观察的旧7项控制3失败4通过；当前原run同步预留已知thread的reservation，直到原close/binding结算再finally释放，取消ticket不能让后继绕过前驱。初步8项及stop控制通过，最终相关98/98、typecheck和真实probe通过，11份固定源码/许可字节与Git blob核对，未增加依赖。最终verify/release各1368/1368、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID146760/birth2026-10-08T20:24:50.4295430+08:00，旧11个实例退出，217份build与27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不是跨进程或整个业务round的互斥。详见[第67轮最终记录](../iterations/2026-10-08-sixtyseventh-cli-thread-admission.md)。

## 第68轮CLI待准入目标取消已验收加载

[p-queue/async-mutex/Node目标取消研究](github-cli-targeted-queued-cancellation-patterns-2026-10-08.md)对应真实RED：queued workflow尚无child，被原cancel漏掉；初始10项控制9失败1通过。当前按workflow/submission登记pending调用，独立Controller与caller信号合并，active child同步注册后交接，stop也能拒绝未准入调用；FIFO owner/peer及首个reason保持。初始10项和追加4项控制通过，最终相关112/112、typecheck及真实probe通过，9份固定源码/许可字节与Git blob核对，未增加依赖或提高Node最低版本。最终verify/release各1382/1382、0异步警告，离线doctor（5项skipped）、包审计、host加载/恢复与diff通过。空闲后受控重载的新PID139348/birth2026-10-08T21:57:12.7624400+08:00，旧11个实例退出，217份build与27个关键模块哈希匹配、413个会话身份与111条workflow完整记录保持。不等于永久workflow封禁或所有backoff gap的取消策略改写。详见[第68轮最终记录](../iterations/2026-10-08-sixtyeighth-cli-targeted-queued-cancellation.md)。

## 后续采用规则

### 第96轮终止优先级已合入，完整门禁运行中

[回调终止分类研究](github-callback-terminal-precedence-patterns-2026-10-10.md)在原8项6失败证据上同时处理inner OR和outer fallback两层。13项候选新增及真实9文件相关95/95、typecheck通过，源码/README/CHANGELOG/test4份base/candidate固定；主第95轮327输入和正式lib保持，prepared-candidate标记adopted false。未来1645全量尚未运行，不能冒作完整修复；见[第96轮候选记录](../iterations/2026-10-10-ninetysixth-callback-terminal-precedence.md)。

第95轮真实完整1632、host/11恢复/diff及精确正式22108验收后，原327输入和4份base/candidate再次匹配，备份后采用。第96轮唯一CLI21308/birthKey `win32:134360620545806580`在328输入副本执行1645预期链，observer29564仅记原exit，无提前部署。正式22108保持第95轮，分类修正尚未加载。

### 第95轮模型显示位置说明已完整验收并加载

[结果载体合同研究](github-subagent-output-destination-contracts-2026-10-10.md)确认两条模型指令仍称Desktop，与实际DSH child/sidebar冲突；Planner及共用Reviewer只改位置说明，生命周期与结构转换保持。既有实际调用检查2条RED、相关182/182及typecheck通过，4份base/candidate按hash合入，无新增test case。原CLI50548在327输入副本执行1632预期链，formal59112与canonical lib保持；observer41416只记录原退出。[第95轮](../iterations/2026-10-10-ninetyfifth-output-destination-contract.md)保留夹具timeout与真实provider未覆盖边界。

06:53原完整verify实际1632/1632、exit0，171文件/native累计/stream及原run/root独立核对；原50548继续release，327输入/4合入文件与217正式metadata保持。仓库外进一步确认callback的宽松timeout分支绕过原终止分类，6个控制产生第二次visible请求并转换；该后续缺陷尚未修正，不属于本轮已验收范围。剩余完整门禁及正式加载仍待原回执。

最终原50548真实exit0，verify/release各1632/1632、171native文件摘要和host/11恢复/diff通过。原59112树11实例退出后只交付原stage的workflow.js，217artifact hash匹配、map未写；formal22108/birthKey `win32:134360618604983240`认证HTTP200。414身份/429文件及111workflow/119queue保持，新提示词位置代码核对通过。callback终止分类仍是后续候选范围，未借本轮放行宣称已修复；见[第95轮最终记录](../iterations/2026-10-10-ninetyfifth-output-destination-contract.md)。

### 第94轮原native replacement已完整验收并加载

[显示attempt退役研究](github-native-child-replacement-patterns-2026-10-10.md)对应原公开factory7项6失败，候选五文件56/56及typecheck通过，native Client帧与none/zstd cold replay确认新snapshot不追加旧draft。5份base/candidate按hash合入，12项新增；唯一CLI24404在327输入stage执行1632预期全链，formal12176与canonical lib保持，observer48036只记录原退出。[第94轮](../iterations/2026-10-10-ninetyfourth-child-replacement-output.md)保留display attempt与model turn边界，尚未正式加载。

独立3110宿主与真实named Playwright浏览器已通过六阶段replacement/失败等待/刷新/原resume/释放后cold reload；thread/child/tab保持、创建各1、原turn2到3、释放一次。UI夹具采用轻量Agent与scripted-local gateway，六回执及截图hash保存，原UI树2实例退出。327验证输入与217正式metadata仍一致，原24404完整链尚运行；UI通过不替代完整放行或真实provider验收。

05:39原完整verify实际1632/1632、exit0，171文件/native累计/stream和原run/root独立审计通过；原24404继续release，正式12176及327输入/217metadata保持。后续发布、宿主、11恢复、diff和正式交付仍待原真实回执。

最终06:10原24404实际exit0，verify/release各1632/1632、171文件/native及host/11恢复/diff通过；独立browser六阶段回执已保存。原12176树11实例退出后交付同stageJS/map，formal59112/birthKey `win32:134360574937099440`认证HTTP200。327输入/217产物独立审计，414身份/429文件及111workflow/119queue保持。无真实provider调用，未冒称完整AgentLoop验收；[第94轮最终记录](../iterations/2026-10-10-ninetyfourth-child-replacement-output.md)保留准备错误、回滚与未覆盖边界。

### 第93轮部分失败输出保留已完整验收并加载

[DSH流收尾研究](github-interrupted-child-output-patterns-2026-10-10.md)对应实际8项6失败，候选相关44/44及typecheck通过，none/zstd真实cold reader保留失败buffer与原继续段。5份base/candidate按hash合入，旧字节保留；原CLI49844在326输入副本执行1620预期完整链，正式56144及canonical lib保持。交付脚本已准备并在门禁未完成时实际拒绝，没有提前替换或重载。[第93轮](../iterations/2026-10-10-ninetythird-partial-child-output.md)保留清理、取消历史标记及未覆盖边界。

04:25原完整verify实际1620/1620、exit0，170文件/native累计/stream及原run id独立核对；原49844继续release，326输入和正式217内容/metadata保持。持久queue实际inbox1是合法的定向未激活历史session请求，路由当前不可领取；它及cancelled历史标记保持原字节，双查真实Agent/待恢复/清理后才能交付。剩余完整链与正式加载仍待原真实回执。

最终原49844真实exit0，verify/release各1620/1620、170文件/native及host/11冷回放/diff通过。独立326输入/217产物/HMR metadata审计后只交付已测JS/source map，原56144树11实例退出，formal12176/birthKey `win32:134360530770948370`认证HTTP200。414身份、429文件及111workflow/119queue保持，历史cancelled及休眠inbox未动。实际served client及新child模块hash核对通过，未做真实provider/浏览器验收；详见[第93轮最终记录](../iterations/2026-10-10-ninetythird-partial-child-output.md)。

### 第92轮原生测试回执已完整验收

[Node语义摘要机制](github-node-test-summary-receipt-patterns-2026-10-10.md)已复现实际合法dot误拒与断言前zero-exit误放行；新模块真实相关68/68及typecheck通过，原run/root、每文件inventory、累计摘要、独占创建和退出码分别验证。10份采用文件按hash合入、旧字节保留，唯一CLI32980在`isolated-uResOz`325输入副本执行1612预期完整链；正式56144保持，无canonical lib写入。原进程观察器56800只记录实际退出，无部署。[第92轮](../iterations/2026-10-10-ninetysecond-native-test-receipts.md)记录复现、夹具修正和未验证范围。

后续以官方archive SHA256核对的便携Node22.19实际运行主源码相关68/68及typecheck，两个真实命令exit0、signal null；系统Node/provider/profile保持。最低版本相关结果不能代替全量1612或宿主验收。原32980完整链继续运行，机器累计摘要尚未取得。

03:13原verify实际1612/1612、exit0，169文件/累计摘要/stream完成和原run id已独立核对，负计数与异步诊断0。原32980进入release并使用另一独立回执，325输入与217正式metadata保持；剩余发布/宿主/恢复/diff仍待真实回执，不提前全链放行。

最终03:43原32980实际exit0，verify/release各1612/1612、每步169文件/native累计/stream及独立run id核对成功，host/11冷回放/diff通过。325输入、10采用文件及217产物独立审计，正式内容/metadata变化0；414身份、429文件及111workflow/119queue保持。运行时产物逐项相同，本轮保留formal56144，未重载或部署。[第92轮最终记录](../iterations/2026-10-10-ninetysecond-native-test-receipts.md)保留实际结果和最低版本/受控网关边界。

### 第91轮隔离验证命令已完整验收

[HMR与验证产物隔离研究](github-verification-build-isolation-patterns-2026-10-10.md)从实际认证资源读取确认构建可提前发布client；315输入副本完整1557/1557、217产物一致及canonical metadata变化0通过。新`pnpm verify:isolated`已按hash合入，17项模块回归和typecheck通过，真实CLI60196在321输入副本执行1574预期完整链；尚未总体完成，正式56144未重启/交付新产物。[第91轮](../iterations/2026-10-10-ninetyfirst-isolated-verification-command.md)保存接口、源/产物漂移及伪绿色拒绝边界。

最终原60196/birthKey实际exit0，verify/release各1574/1574、host/11持久冷回放/diff通过；321输入、8份采用文件及217artifact独立核对，正式lib内容/size/mtime/ctime变化0。414会话身份、429文件及111workflow/119queue保持。运行时产物与正式逐项相同，本轮保留formal56144；命令不自动部署。[Node语义摘要研究](github-node-test-summary-receipt-patterns-2026-10-10.md)仅准备后续机制，没有替换reporter。

### 第90轮侧栏重试耗尽已合入，完整验收待完成

[p-retry终态机制研究](github-sidebar-retry-exhaustion-patterns-2026-10-09.md)对应原16项10失败，候选和主相关66/66、typecheck通过。第89轮完整交付后，本轮1源码/1测试/3文档按base hash合入；315输入冻结、原runner33688及observer41852执行新的1557预期完整链。正式DSH25056仍第89轮版本，新改动未加载；真实回执、宿主及历史核对须独立取得，详见[第90轮](../iterations/2026-10-09-ninetieth-sidebar-retry-budget.md)。

第90轮实际完整verify1557/1557、exit0及异步警告0，步骤1791.25秒；原runner33688继续release，observer41852等待全部门禁。该结果不代表正式加载，后续发布/宿主恢复/数据检查须各自实际通过。

最终第90轮gate/delivery均exit0，verify/release各1557/1557、host/11恢复/diff通过；formal56144认证HTTP200，原25056树11实例退出，414会话身份/429文件及111workflow/119queue全量hash保持。另已确认shared lib在门禁前能经HMR发布新client，旧后台PID不代表旧前端；[隔离构建研究](github-verification-build-isolation-patterns-2026-10-10.md)已完成字节/metadata、66 UI/host/11恢复prototype，副本全量verify仍待完成，正式流程尚未采用隔离。

### 单调重试预算已合入，完整验收待完成

[p-retry/Node固定源码研究](github-monotonic-retry-budget-patterns-2026-10-09.md)确认共享控制默认墙钟的回拨/前跳缺陷，仓库外9场景、18项原代码/候选结果通过。当前生产源码未采用；Workflow可读回合与CLI默认计时入口仍待真实回归。保持第88轮313份冻结输入，待该轮完整门禁/DSH恢复后再迭代，不将共享函数候选泛化为全模型链修复。

[第89轮候选](../iterations/2026-10-09-eightyninth-monotonic-retry-clock.md)已补齐四入口36项回归：原20通过/16失败，候选36/36及typecheck通过；真实本地CLI控制确认少发一个超预算子进程，目标与最后503保持。3源码/1测试的base/候选hash已固定，主工作区仍未采用，未来完整1540项仅是预期值。

进一步加入公开Planner流程后为37项候选回归，未来完整计数1541。第88轮完整验收/正式恢复通过后，本轮3源码/1测试/3文档已按原hash合入主源码，定向46/46与typecheck通过；正式PID51892仍运行第88轮，不将历史或候选结果当作本轮完整放行。

第89轮原verify已取得实际1541/1541、exit0及异步警告0（1929.62秒），原runner25348继续release，observer44648等待全部门禁。当前仍未正式加载单调预算修正；后续release/host恢复/数据核对必须分别取得实际结果。

最终第89轮原gate/delivery均exit0，verify/release各1541/1541、host/11恢复/diff通过，217build及原51892树11实例退出核对通过。一次重载正式PID25056认证HTTP200，414会话身份、429文件与111workflow/119queue全量hash保持；3个编译default预算入口核对通过，单调预算已正式加载。随后才合入第90轮，不将1541旧结果作为新1557预期放行。

### 第88轮：侧栏退役边界

[VS Code/DSH/Cline 研究](github-sidebar-disposal-patterns-2026-10-09.md)已落实为客户端退役标记、延迟扫描接纳检查和单次投影退订。[8项新增回归](../../test/sidebar-disposal.test.ts)、50项相关控制及安装宿主实际通知器隔离RED/GREEN通过；完整门禁和正式加载尚待完成，不能复用第87轮1496项结果放行。[第88轮记录](../iterations/2026-10-09-eightyeighth-sidebar-disposal.md)保持实际状态与未覆盖边界。

Windows在15:23重启后，原门禁及正式DSH均缺席；保留未完成日志。后续并发4verify实际1503/1504，唯一既有stderr控制ENOENT，独立同用例1/1通过但原因尚未确认。当前采用原文件并发2的独立完整链与一次性授权交付observer，必须取得新1504计数及实际正式服务/历史核对；目前尚未加载。429份session文件及111workflow/119queue完整哈希在重启后保持，不将这些数据检查当作ephemeral线程恢复。

16:01原并发2gate的verify实际1504/1504、exit0及异步警告0，原runner10760继续release，observer36112仍活。该结果不覆盖尚未完成的release/host恢复及正式启动审计，也不证明此前ENOENT原因；生产加载状态仍待delivery真实回执。

后续读取实际终态：并发2release1503/1504，原进程树清理未确认；gate10760/delivery36112均exit1，未启动DSH。相同回执继续用例独立1/1通过、原因仍未确认。新完整链以原内部并发/断言/时限和文件并发1运行，PID31020/observer14668；仍需全部结果和正式数据核对，不能声称已加载。

20:23实际并发1verify完成1504/1504、exit0及异步警告0，原PID31020继续release，observer14668仍等待完整终态。此前失败用例在这次完整verify中通过，但不视作其根因修复；正式服务恢复及第89轮候选合入仍待原链完整结果。

最终原gate/delivery均exit0，verify/release各1504/1504、host/11恢复/diff通过；正式恢复一次PID51892并核对实际认证HTTP200、217build及served client。414会话身份、429文件、111workflow和119queue完整hash保持。第89轮合入前再次确认原formal状态与空闲边界；第88轮本次完整结果不证明此前零星清理异常原因，也不覆盖新的单调预算代码。

先复现用户可观察的缺陷，再挑选最少的外部机制；保存固定SHA、许可、实际源码路径和未覆盖边界。实现应进入现有职责模块，不为参考项目迁移运行框架。结果、清理、调用者观察和进程归属分别证明，避免以“重试成功”隐藏新模型调用或替代原线程。
