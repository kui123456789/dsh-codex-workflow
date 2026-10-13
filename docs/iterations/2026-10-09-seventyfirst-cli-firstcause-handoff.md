# 第71轮：CLI跨阶段的原取消原因

状态：第71轮完整验收并冷启动加载完成，新PID4448。verify/release各1435/1435、host加载/恢复及diff通过；413个会话身份、428份会话文件及111条workflow保持。两次中断日志和输出编码审计保留，持续优化目标active。

## 基线与实际RED

HEAD保持abb6174，既有dirty保留。正式PID148600/birth2026-10-09T00:41:57.4914810+08:00；只读认证查询确认413个会话身份、111条workflow完整记录保持，running/waiting0，原parent及历史corrupt child存在。原CLI SHA256为`4B07A0AA4291FB7B33A2CCF93EE2E5281076CAF5CD3EC489426E5B2A60C3D6C9`，原副本保留。

证据目录../.codex-workflow-verification/seventyfirst-20261009/。在第70轮冻结验证期间，仅运行独立cached-caller-stop-firstcause-probe.mjs，caller先取消后stop，释放capture后错误原因被替换；连续两次RED，modelStarts0、captureCalls1，没有额外模型请求。第70轮原exec47809完整结束并正式加载后才修改本轮代码，未破坏原301份输入的验收。

20项新增初始10失败10通过，真实子进程及缓存路径都覆盖caller/workflow/submission/default/string先于stop。反顺序、已停止的新请求、身份变化、capture错误和最终review callback控制原来通过。tests-red.log及10份失败actor目录保留，original-red-actor-observations.json归档。

## 实现与局部验收

原pendingRuns追加signal引用，统一assertAdmission供withCancellation/run/runAdmitted使用。相同workflow/submission仍托管已取消signal时，继承原reason；新请求或身份变化保持原stopped准入优先。没有无条件交换所有stop/caller检查，没有创建新模型或更改公开参数。

20/20 GREEN，原probe为firstReasonPreserved true、modelStarts0、captureCalls1；typecheck通过。原exec38283明确exit0，14个完整相关文件167/167、失败/取消/跳过0，79.91秒，覆盖前三轮scope/回调/退避、原线程准入、绑定、流错误、SIGKILL、阶段恢复及预算。

生产CLI SHA256为`AFF323B964886CFC9873CA62E02A4EAF1614B1290BCABF53DD5D78D504902C78`。Callback错误保持，默认DOMException及Error引用保留，非Error原因保持旧fallback；stop仍等待原callback结束，不新增callback硬超时。

## 外部研究与正式边界

[p-retry/Node固定源码研究](../research/github-cli-firstcause-handoff-patterns-2026-10-09.md)核对8份字节/Blob/许可，Context7确认Node24 any原因选择。未增加依赖、未提高Node最低版本。

完整测试预期1435（第70轮1415+新增20），完整verify/release、host加载/恢复及diff结算前不重载。之后实时核对原正式实例、空闲状态和新数据基线；不能以167项局部结果放行。provider/profile/凭据及原会话保持，未commit/push/publish；受控fixture不证明自然provider故障、Token费用或浏览器交互。

## 冻结与唯一完整链

303份代码/测试/脚本及发布输入冻结，并保存同数源码快照；manifest SHA256为`770B2EAE554F8DF98FA67C317B13A7121850B817A8DA7824F00E8681A2EA3314`。相对第70轮仅CLI源、README、CHANGELOG3份变化，新增测试/actor2份，复用原pipeline backend；研究及迭代文档不在冻结集合内。逐项hash偏差0，Junction仍指向本D盘仓库。

原exec25529已启动唯一完整链，目录final-gates-be82d14f-e6d5-402a-a458-68602cc6994d/，依次verify、release、host、host-recovery、diff。每阶段前后核对303份集合/hash；verify/release各要求1435/1435、失败/取消/跳过及异步警告0。文件并发1，场景内部并发和时限保持；观察等待到期后继续原exec，不重开验证。

操作helper绑定原正式PID148600、ISO出生时间及实时CIM读取的win32:134359513174914810。只读guard探针exit0、PowerShell解析0错误、retirement helper语法通过；本轮build-freeze及reload收据尚未生成，正式仍第70轮。

## 完整链运行中的观察

2026-10-09T01:24:15+08:00，原exec25529仍可等待，原runner实际子进程正在执行foreground-new-review-round.test.ts。完整verify日志已记录651项通过，失败及异步警告0；本轮20项原取消首因/准入回归全部通过。303份输入逐项hash保持，尚无最终summary或reload收据；运行中的通过行不代替完整门禁成功。观察结果保存于verification-observation.json，后续继续原exec。

## 完整verify与外部中断

原exec25529的verify明确exit0：1435/1435、失败/取消/跳过及异步警告0，1838.97秒，原summary.json与verify.log留存。原exec已进入release，先前观察过8项通过。

2026-10-09T02:48:48+08:00，等待工具报告原句柄缺失；实时CIM确认没有release/test进程、原正式PID148600不存在、没有DSH Node实例或3080监听。原release日志最后写入02:07:26，1130项通过、失败0，缺少完整汇总和RELEASE_CHECK_OK；不能据此视为release通过，中断原因未知。303份源码逐项hash保持。

interruption-observation.json记录原句柄与实际进程缺失，原release日志移至同目录release-interrupted.log保留。保留唯一已完成verify收据，原final-gates.ps1不变；remaining-gates-after-interruption.ps1经解析0错误，仅运行未完成的release、host、host-recovery和diff，仍核对同一303份freeze。本次不是观察超时重开：原工作已由实际状态证实消失，原exec13388启动补验收。正式启动须完整门禁通过后重新核对服务缺席、持久数据及插件链接，禁止按旧PID直接停止或伪造旧ephemeral上下文。

## 中断后的冷启动准备

offline-formal-baseline.mjs只读保存428份session存储文件的路径/字节数/SHA256及111条workflow完整记录hash；workflow hash仍与最后认证查询相同。该离线文件数量包含历史文件，不冒充413个宿主会话身份计数；启动后再用认证API核对身份，并逐项比较离线持久文件。

controlled-cold-start.ps1和formal-cold-verify.ps1独立保存，原受控重载及原树验证helper保留不变。冷启动仍要求完整1435项门禁、303份输入及217份build核对；实时确认原PID缺席、没有DSH Node实例或3080监听、Junction正确、离线数据保持后只启动一个实例。启动后验证认证健康、原会话身份、完整workflow记录、构建和关键模块hash，以及428份文件清单和字节保持。

冷启动不调用旧PID终止、不伪造原进程树退出证明；原树在外部中断前没有采集，因此标明originalTreeExitVerified false及证据缺失。两个脚本解析0错误，尚未启动；补验收原exec13388继续运行，不修改冻结代码。

## 第二次中断与持久验收进程

2026-10-09T03:01+08:00，再次等待时原exec13388句柄缺失；实际release/test进程也已消失。补验收release日志在02:57:57截断：多个文件级快速失败、没有最终错误汇总或退出收据，不能称作通过，也不能仅据此认定源码回归。second-interruption-observation.json记录现场，原日志另存release-second-interruption.log。

仅复跑最先失败的bridge-new-review-round-request.test.ts，TAP完整输出3/3、失败/取消/跳过0、exit0，8.74秒，保存interruption-first-file-diagnostic.log；未改测试时限或源码。中断/文件级失败的根因尚未确认，未修改系统配置或停止其他Node进程。

303份冻结输入及428份session文件/111条workflow再次核对保持。cold-start-preparation-audit.json确认四个helper解析0错误、目录绑定正确、原reload脚本保留，尚未启动正式服务。

确认没有活着的release/test后，使用durable-remaining-gates.ps1启动一个独立隐藏pwsh后台进程：PID11660/birth2026-10-09T03:03:38.3850430+08:00/win32:134359598183850430。durable-gates-start.json保存实例身份，finally写durable-gates-completion.json保存实际退出码；进度通过原PID出生核对及原日志观察，不依赖先前已缺失的会话执行句柄。仍只补跑release/host/host-recovery/diff，保留原1435项verify收据；当前尚未有最终完成收据，不放行冷启动。

## 后台验收的输出编码与最终结算

后台进程11660持续运行并取得完整release结果。隐藏pwsh的控制台编码使Unicode通过/汇总符号变成乱码，初始观察按原符号匹配曾显示0；核对真实子进程与更新日志后识别该问题，使用实际符号继续观察，没有因此重开测试。实际release退出码0、1435项全部通过、RELEASE_CHECK_OK、doctor/pack audit成功、临时tarball清理完成，耗时1420.53秒。

原remaining gate脚本仍依赖Unicode汇总符号，记录release exit0但counts为空，随后计数门退出1。durable-gates-completion.json明确保存PID11660、03:27:19完成、wrapper exit1、failureType null；不把这个外层退出码直接当成release成功。

audit-durable-release.mjs独立核对唯一原verify收据、release实际exit0、1435项五个ASCII数字字段、0异步警告及真实RELEASE_CHECK_OK/pack/cleanup，再关联release原字节SHA256`083fb9ddb41e8f700e1bf61b030fe57e6d48fe4ab3117153ce08b602ffdf87d4`。原空counts收据保留为summary-before-encoding-audit.json，补入已核对的实际数字并保存durable-release-encoding-audit.json；没有改写release日志或用局部测试替代完整结果。

仅执行未开始的host/host-recovery/diff，finish-host-gates.ps1在该进程设置UTF-8，核对同一303份输入及原release审计，不再执行测试。原exec57815明确exit0：host3.89秒、host-recovery6.01秒、diff0；宿主恢复为scripted-local网关、隔离存储，browserUIVerified false。完整verify1435/1435来自原exec25529、1838.97秒，release1435/1435来自已结算后台实例11660，失败/取消/跳过及异步警告均0。两次先前中断记录仍保留，未把它们计为成功。

## 冷启动加载与持久数据核对

303份冻结输入保持，最终217份build manifest SHA256为`42118C8E4D7AD699DC34806BD539F634699724063CF7A6EBAD8F4FA59D268F2C`，build-freeze-receipt.json关联原门禁目录。实时确认原PID148600缺席、无DSH Node实例或3080监听、D盘Junction正确，428份session文件及111条workflow仍与离线基线一致后，执行一次controlled-cold-start.ps1。

原exec71021明确exit0，仅启动一个正式实例：PID4448/birth`2026-10-09T03:29:22.6331920+08:00`，原Node/DSH入口和127.0.0.1:3080监听匹配，认证健康HTTP200。formal-cold-verify.ps1确认217份build与27个关键模块hash偏差0、413个会话身份保持、原parent及历史corrupt child存在，111条workflow完整记录hash仍为`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，428份session文件字节/清单保持，stderr致命匹配0，running/waiting0。

restartMode为cold-after-confirmed-absence。原进程树未在外部中断前采集，因此originalTreeExitVerified明确false；没有伪造旧树证明或重建丢失ephemeral上下文。provider/profile/凭据保持，原失败actor及两次中断日志保留，未commit/push/publish。受控宿主恢复不代表正式provider自然故障、Token费用或浏览器交互验收。
