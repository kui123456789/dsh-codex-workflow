# 第92轮：原生测试事件与完成回执

状态：第92轮完整验收通过。原verify/release各1612/1612、每步169文件与累计语义摘要核对成功；host/11恢复/diff通过，原32980实际exit0。Node22.19相关68/68及typecheck通过。325输入及217正式内容/metadata保持，运行时产物相同，保留正式DSH56144。总体优化目标active。

## 两个实际复现

[Node机制研究](../research/github-node-test-summary-receipt-patterns-2026-10-10.md)保存22.19/24.14官方固定源码与许可，12份Git blob/SHA256核对。本轮继续用Context7核对多个reporter与目的地按声明顺序配对；最低版本事实以22.19固定源码为准，main检索片段不替代它。

仓库外真实原生CLI夹具先用TAP证明3/3、exit0，再将同一夹具改为合法dot输出。原隔离命令实际拒绝`Missing or ambiguous final test count: verify/tests`；候选通过同一原生测试。第二个夹具在断言前`process.exit(0)`：TAP将它当作文件级通过，原隔离命令接受；候选因缺少完整原生事件拒绝。两组RED/GREEN、原exit/signal及日志保存在`.codex-workflow-verification/ninetysecond-20261010`。非测试门禁在该小型复现中使用明确脚本适配器，不能当作完整宿主或发布验收。

## 模块与契约

- `scripts/test-receipt-reporter.mjs`记录start、文件摘要、累计摘要和stream完成；只复制异步诊断标记，保留原人工输出。wx独占创建防止已有回执被覆盖。
- `scripts/test-receipt.mjs`配对reporter参数并校验已完成回执。校验run/root身份、计数字段、实际退出码、完整文件inventory、累计数量、完成顺序及原诊断；缺少语义证据时不退回文本计数。
- `run-tests.mjs`仅在原source scope匹配时增加companion；独立后代launcher保持自己的输出，不能抢父回执。原文件发现、内部并发、测试时限和断言保持。
- `verification-stage.mjs`为verify/release各生成原run id和回执路径，执行完成后消费它，其他源/产物漂移守卫保持。

## 控制结果与合入

38项新增：25个格式/身份/归属与独占控制、13个真实原生launcher控制。连同原17个隔离控制及13个reporter控制，实际68/68，fail/cancelled/skipped/TODO及异步警告0；typecheck通过。真实用例包括单/多文件、suite、skip/TODO、失败、取消、提前zero-exit、空文件、自然late activity、多reporter及后代scope。

初次候选60/62的两失败是夹具检查顺序/错误类型预期问题，修正后通过；第一次typecheck指出env/index的严格类型，已修正。另一次误在无.git候选目录运行diff被拒绝，未当作干净Git结果；canonical diff后来实际通过。wx碰撞及文件scope不采用全局uncaughtException兜底。

10份原文件base/candidate哈希固定、旧字节备份后采用，无依赖或运行时配置变更。`candidate-controls.json`记录68项真实命令和退出；主全量预期1612（上一轮1574+38）仍需独立取得，不能把分项相加当完整通过。

## 当前完整链与边界

02:43原CLI32980实际进入verify，证据`isolated-uResOz`，325输入快照。observer56800已保留原OS句柄并核对出生键，只写完成回执，不测试或部署。原生JSONL已收到start和实际文件摘要，没有累计完成标志；不能据此放行。

正式metadata仍为414身份、111workflow/119queue原hash，原parent/corrupt child保留，running/waiting/pending/lease0。完整链依次verify/release/host/11恢复/diff，任何失败保留证据并按原进程排查。实际provider故障和浏览器不在本轮已取得证据内；最低版本的后续控制证据见下一节，不能代替Node22完整项目门禁。

## Node22.19最低版本实际控制

本机系统Node24.14及Codex bundled24.19均不覆盖最低版本。Jina官方发布页读取实际超时，未推定发布源不可用；随后官方`nodejs.org/dist/v22.19.0`校验清单与Windows x64便携archive直读成功。压缩包SHA256 `ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86`与唯一官方条目匹配；所有zip路径核对限定在新的仓库外node22/extracted目录后解包，实际`node.exe --version`返回v22.19.0。没有改系统Node、PATH、provider/profile或依赖声明。

使用该原便携exe运行主源码四个相关测试文件，真实68/68及typecheck均exit0、signal null，失败/取消/跳过/TODO及异步警告0。外层及其实际原生子launcher都使用process.execPath的22.19；未把Node24结果冒作兼容证明。原始日志、官方checksum、archive、runtime回执及`compatibility-controls.json`保存在本轮node22证据目录。结果仅证明本轮回执/launcher/隔离边界在最低版本的相关控制，不声称Node22全量1612或宿主provider已验收。

02:52原完整门禁仍为同一32980，verify实际通过到355、没有not ok；机器回执仍只有文件摘要而无累计完成。独立完整性审计确认325原/副本输入、10份采用文件及217正式内容/metadata偏差0。观察超时不重开原完整链；剩余结果必须继续读取原run id和OS句柄的真实回执。

## 原完整verify及语义回执已取得

2026-10-10 03:13:17.632原verify实际exit0、1612/1612、失败/取消/跳过/TODO0。实际check起止为02:43:05.095至03:13:17.632（1812.537秒）。独立审计原日志和原JSONL，169文件与冻结inventory逐项匹配，一个最终累计摘要1612通过、stream完成、run id `ee0ac278-10a4-46f4-9ccf-9862b488a782`及source目录一致，异步诊断0。

原CLI32980继续release，独立run id `680c0f07-e8ba-4000-bb5c-4a900271b113`和新wx回执已经出现；没有重开verify。`independent-completed-verify-audit.json`与完整性观察保存实际1612、169及exit0，325输入/10采用文件/217正式内容和metadata仍偏差0。全链complete false，release/host/11恢复/diff仍须继续取得实际结果；不宣称已整体验收或部署。

## 最终完整门禁与原进程回执

2026-10-10 03:43:36.966整链完成，保留真实OS句柄的observer56800于03:43:36.984确认原32980/birthKey退出码0。verify/release各1612/1612，失败/取消/跳过/TODO及异步警告0；实际步骤1812.537/1804.196秒。两份原生JSONL各169文件、一个最终累计摘要及stream完成，独立run id与目录分别匹配，文件总数和测试计数逐项核对，未用上一轮或分项结果替代。

host加载4.137秒、host-recovery6.715秒及11场景全部persistedColdReplay、pendingTools0，canonical diff通过；doctor5个offline skipped保留，pack审计成功及临时tarball清理确认。host使用scripted-local网关，browserUIVerified false，不能冒作真实provider故障或浏览器组合验收。

独立final audit重读所有原始计数/native事件/host回执、325份原/副本inventory和内容、10份采用hash与217artifact manifest。正式lib内容/size/mtimeNs/ctimeNs变化0，stage217份产物与canonical逐项hash偏差0；原生回执仅完整成功后被消费，artifacts manifest随后创建，未部署相同运行时产物。

最终正式56144的birth、3080监听、入口/Junction与认证HTTP200核对成功，原414身份、429文件及111workflow/119queue全量hash保持，文件变化/新增/缺失0；原parent/corrupt child保持，running/waiting/pending/lease0。本轮无需重载，不修改provider/profile，不提交推送或发布。结束时状态观察脚本曾把空的成功diff日志作为null交给regex而报错，修为string后读取原真实终态；该只读脚本错误未改变门禁或掩盖失败，完整completion回执独立保留。

新增两个脚本职责、38项回归及工具链说明已完成本轮验收；便携最低版本控制是68项相关测试，不是Node22全量项目门禁。总体目标继续active，后续迭代先选择具体可复现问题，不能把本轮全绿视作无限优化目标完成。
