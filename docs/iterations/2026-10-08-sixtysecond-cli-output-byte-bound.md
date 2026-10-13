# 第62轮：CLI输出字节预算与最终解码

状态：第62轮已完成完整验收并加载正式DSH，PID142580。verify/release各1320/1320，host加载/恢复与diff通过；持续优化目标active。

## 当前基线

只读核对原PID139496/birth `2026-10-08T12:19:03.6647040+08:00` / `win32:134359067436647040`，413个会话身份、111条workflow完整记录保持，running/waiting0，原parent和历史corrupt child存在。HEAD仍abb6174、既有dirty保留。原CLI源SHA256 `F56E838B3406511975319A3549EBB7CB65ADC36B41643B63EAAAA522E4172DD1`，本轮保存原副本 `codex-cli-audit-before.ts`。

证据目录为 `../.codex-workflow-verification/sixtysecond-20261008/`。最初检查取消/重试边界时发现CLI byte budget实际缺陷，改为先复现这条用户可观察输出路径；没有为未证实问题修改取消策略。

## RED与实现

先执行 `node --import tsx ../.codex-workflow-verification/sixtysecond-20261008/cli-stderr-byte-bound-probe.mjs`，0.91秒exit1。真实本地Node backend输出400字节emoji，配置maxOutputBytes64，原dispatcher实际保留128字节/32code points，starts1、实际exit0。原JSON另存RED，真实backend临时目录在路径边界检查后清理。

新增9项控制，旧实现8失败1通过：64/65预算、极小完整尾部、逐字节chunk、decoder最终替代字符、零预算、公有终态review及stdout最终flush；ASCII尾部保持控制通过。根因包括按UTF-16单元裁切、slice(-0)及最终flush未受预算约束。

只改 `src/codex-cli-audit.ts`：stderr沿用StringDecoder并在data和end后共用本地UTF-8尾部裁切；stdout end后补原overflow检查，pendingError保持第一次错误。新增取消原因控制后定向10/10。README/CHANGELOG明确保留输出预算；[Execa/Node研究](../research/github-cli-output-byte-bound-patterns-2026-10-08.md)保留固定源码与不同字节/字符契约，未新增依赖。

## 局部验收

初次typecheck发现新增公有review测试漏传必需submissionId，原失败日志保留。原exec15296完整5文件先terminal exit0，49/49、18.67秒，再补齐参数和新增取消控制，不修改运行中的测试输入。随后typecheck exit0、10项定向通过、diff检查通过。

最终原exec91684明确terminal exit0：5个完整文件50/50、fail/cancelled/skipped0，17.56秒；包含前台CLI阶段恢复、终止错误和既有等待deadline/抖动上限控制。没有以typecheck失败的初轮结果放行。

真实CLI探针修复后max64/actual64、16个完整emoji、starts1、actual exit0；另一真实backend分别验证最终stderr `C�` 恰好4字节、stdout原CodexNoVerdictError溢出拒绝。都是原dispatcher和真实OS子进程，使用本地受控响应，不调用正式provider。生产修复SHA256 `B18C3AC58F41C97EA0421C1D654E803274C1EA18D70DDD4E87E35E430DBA1241`。

本轮预算针对保留字符串，不宣称总内存硬上限、完整诊断语义或真实Token节省。正式provider/profile/凭据、历史workflow和旧corrupt未改，未commit/push/publish；完整测试预期1320（原1310+新增10），正式加载仍待完整门禁证明。

## 冻结后的完整验证链

278份代码/测试/脚本及发布输入已冻结并保存同数快照，manifest SHA256 `09A982D8C2AD981FC5BCD229F2CEE78B6C4EDB4A89D8A0AD3910D46AF5FD6E4E`。包含src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究和迭代记录在冻结输入之外。

唯一完整链原exec94380，目录 `final-gates-bcffcc07-bb0d-44a0-abce-c8fbb2ed2a20/`，依次verify、一次release、host、host-recovery、diff。每阶段前后检查278份输入集合和哈希，verify/release要求1320/1320、失败/取消/跳过与异步警告均0；独立文件并发1，原场景时限保持。当前已启动verify，不能以50项局部结果代替完整终态。

本轮操作helper绑定唯一门禁、278/1320、原PID139496/ISO birth/Windows出生标识；准备阶段实际CIM核对三者、只读身份探针exit0、PowerShell解析0错误和Node retirement helper语法通过。复制helper时同时检测旧birth残留，避免第61轮操作脚本遗漏。前置认证使用第61轮私有state，最终build freeze和reload receipt尚未生成；只有完整门禁通过且正式服务实际空闲才能重载。等待到期须继续同一exec或已启动实例，不重开链。

## 完整verify结算

原exec94380的verify已明确exit0：1320/1320，失败/取消/跳过均0、异步警告0，1831.40秒。完整 `verify.log` 和 `summary.json` 留存，同一exec继续release；没有因观察到期重开验证，也没有用50项局部结果替代完整门禁。阶段前后278份输入保持冻结。

`source-change-receipt.json`确认相对第61轮冻结输入集合不变，只有CLI源、其测试和README/CHANGELOG共4份hash改变；共享重试与App Server模块保持。发布包审计、host加载/恢复、diff终态及正式加载仍待独立确认。本轮build freeze及reload receipt尚未生成，正式服务原PID139496/Windows birth保持。

## 最终完整验收

原exec94380已明确terminal exit0，完整链沿用同一个进程，未因观察到期重开：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1320/1320；失败、取消、跳过与异步警告均0 | 1831.40秒 |
| release:check | 1320/1320；失败、取消、跳过与异步警告均0；包审计通过 | 1815.90秒 |
| host:check | exit0，安装宿主加载通过 | 4.42秒 |
| host:recovery:check | exit0，本地受控模型网关及隔离存储的原线程恢复通过 | 8.14秒 |
| diff --check | exit0 | — |

离线doctor通过（5项skipped），临时tarball已清理。host恢复使用安装DSH0.1.7-rc.2的ToolRuntime/AgentRegistry/SessionProjectionRegistry/SubagentRuntime，结果明确 `browserUIVerified: false`；本轮未调用正式provider，不把它泛化为自然模型故障、真实Token计费或浏览器交互验收。

278份发布输入与原快照保持；最终217份build冻结SHA256 `4AB62AF85319522FEF9A7CE4B407AA44369D1DCFF3F700BA6850B68ED5CFDD92`，`build-freeze-receipt.json`关联本轮唯一完整门禁。

## 正式加载与数据核对

再次实时确认原PID139496及出生标识，running/waiting0、插件Junction指向D盘当前仓库后，执行唯一受控重载。原exec54193明确exit0，只启动一个新实例；旧进程树捕获的11个原实例确认退出。新PID142580/birth `2026-10-08T13:38:23.6914740+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build和27个关键模块哈希0偏差，413个会话身份保持、111条workflow完整记录保持，stderr致命匹配0；原parent与历史corrupt child仍存在，没有替换历史ephemeral线程。workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，未commit/push/publish，持续优化目标active。
