# 第68轮：CLI待准入调用的定向取消

状态：第68轮已完成完整验收并加载正式DSH，PID139348。verify/release各1382/1382，host加载/恢复与diff通过；持续优化目标active。

## 基线与实际RED

只读核对PID146760/birth `2026-10-08T20:24:50.4295430+08:00` / `win32:134359358904295430`，413个会话身份、111条workflow完整记录保持，running/waiting0，原parent/历史corrupt child存在。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `0F189E1146300BE3802FADC800EA9BF46F24B7EC6AFC57F0DF8AE5A17CEAD62A`，原副本 `codex-cli-audit-before.ts` 保存。

执行 `node --import tsx ../.codex-workflow-verification/sixtyeighth-20261008/cli-queued-workflow-cancel-probe.mjs`，0.90秒exit1：真实owner仍活着，queued workflow无child，cancel只扫描children而漏掉等待调用；queuedSettled false、starts1/kill0。原JSON另存RED，backend临时目录经真实路径边界核对后清理。

新增test/cli-targeted-queued-cancel.test.ts及actor，复用已有真实queue backend。初始10项9失败1控制通过，RED日志和9份原actor状态归档，原目录保留。不同workflow/single submission/public review/peer/原绑定/stop等都证明目标等待者尚无child但需要可寻址取消。

## 实现与局部验证

只改CLI run/cancel/cancelSubmission/stop：待准入调用登记原workflow/submission和独立取消Controller，AbortSignal.any合并caller，首个reason保持。原child同步注册后交接，pending登记在finally清除；原reservation仍等前驱释放，owner和peer不受targeted取消。追加onSpawn与spawn adapter取消检查，前者阻止创建、后者等待刚创建原child关闭并跳过prompt。

初始10项GREEN、typecheck通过，真实probe变为queuedSettled true/starts1/kill0、原owner仍活着。再补caller-first/api-first/onspawn-cancel3控制和spawn-cancel1控制，均通过；累计14个场景，注册最终归零。原第一原因、已接纳binding、model timer、Node引擎范围、外部Gateway Interface和未来显式复用行为保持。

原exec85677明确terminal exit0：11个完整相关文件112/112、fail/cancelled/skipped0，47.92秒，包含原准入/queued signal取消/绑定、模型/诊断流、byte预算、阶段恢复和重试deadline/抖动控制。typecheck/diff通过，运行中不改输入；生产CLI源SHA256 `C89402823C3A2C18511FA8524EB1B0D8BB746532132817EA548B91825035735D`。

通过[p-queue/async-mutex/Node固定研究](../research/github-cli-targeted-queued-cancellation-patterns-2026-10-08.md)核对9份源码/测试/许可字节与Git blob。AbortSignal.any自Node18.17/20.3支持，覆盖本项目^22.19/≥24，未新增依赖或提高最低版本。仅针对当前pending/active调用，不永久封禁workflow、不改所有backoff gap取消策略，不证明自然provider错误或真实Token费用；provider/profile/凭据和历史workflow保持，未commit/push/publish。完整测试预期1382（原1368+新增14），正式加载仍待完整门禁。

## 冻结后的完整链

295份代码/测试/脚本及发布输入冻结并保存同数快照，manifest SHA256 `0A30762C736D465F5A6975D67AC4F44F5550269FF274316F5B07AE83330ABB91`。包含src/test/scripts、package/lock、tsconfig、patch和README/CHANGELOG/LICENSE；研究与迭代记录在此集合之外。

唯一完整链原exec86625，目录 `final-gates-88ec9e72-01d4-47d8-9b72-7411172b62f7/`，依次verify、一次release、host、host-recovery、diff。每阶段前后检查295份集合/hash，verify/release要求1382/1382、fail/cancelled/skipped0与0异步警告；独立文件并发1，原内部并发和场景时限保持。当前verify已启动，不以112项局部结果放行，也不因观察等待到期重开验证链。

操作helper绑定唯一门禁、295/1382和正式原PID146760/ISO birth/Windows出生标识，实际CIM匹配、只读身份探针exit0、PowerShell解析0错误和Node retirement helper语法通过。前置认证使用第67轮私有state；最终build freeze和reload receipt尚未生成。全部门禁通过且正式服务实际无运行/等待工作后才能重载，观察超时继续原exec或已启动实例。

## 完整verify结算

原exec86625的verify明确exit0：1382/1382、失败/取消/跳过均0、异步警告0，1737.61秒。完整 `verify.log` 和 `summary.json` 留存，同一exec进入release，不因观察到期重开；本轮14项targeted取消与前轮9项准入、9项queued signal取消都在完整运行通过，未用112项局部结果替代完整门禁。

295份输入与集合保持冻结，`source-change-receipt.json`记录相对第67轮CLI源与README/CHANGELOG3份hash变化、测试/actor2份新增，复用原真实backend。release包审计、host加载/恢复和diff终态仍待结算，最终build freeze与reload receipt未生成；正式服务仍第67轮，加载前须实时核对原实例身份和实际空闲状态。

## 最终完整验收

原exec86625明确terminal exit0，完整链沿用同一个进程，没有因观察到期重新启动：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1382/1382；失败、取消、跳过与异步警告均0 | 1737.61秒 |
| release:check | 1382/1382；失败、取消、跳过与异步警告均0；包审计通过 | 1742.33秒 |
| host:check | exit0，安装宿主加载通过 | 3.81秒 |
| host:recovery:check | exit0，本地受控网关和隔离存储的原线程恢复通过 | 6.45秒 |
| diff --check | exit0 | — |

本轮14项targeted取消和前轮9项准入、9项queued signal取消都在完整verify/release通过。离线doctor通过（5项skipped），临时tarball已清理；host恢复采用安装DSH0.1.7-rc.2，明确 `browserUIVerified: false`，不是正式provider自然故障、Token计费或浏览器交互证明。

295份输入及原manifest保持；最终217份build冻结SHA256 `100683AF24053B41F1B77D96AF2A5BB65C9355DC3785234042B519F3CDB218FD`，`build-freeze-receipt.json`关联唯一完整门禁。完整verify后的三个操作helper核对本轮目录和manifest、解析0错误，记录于 `post-verify-operation-audit.json`。

## 正式加载与数据核对

再次实时确认原PID146760/ISO及Windows出生标识、插件Junction指向D盘当前仓库、实际running/waiting0后，执行一次受控重载。原exec18533明确exit0，只启动一个新实例；捕获的11个原进程树实例确认退出。新PID139348/birth `2026-10-08T21:57:12.7624400+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build与27个关键模块哈希0偏差，413个会话身份与111条workflow完整记录保持，stderr致命匹配0。原parent与历史corrupt child存在，没有替换或伪造旧ephemeral线程；workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，负向actor证据保留，未commit/push/publish；持续优化目标active。

## 文档更新后的收尾核对

再次运行diff检查，295份源码输入与217份build逐项SHA256匹配原冻结清单，偏差0；插件Junction仍指向D盘本仓库。只读认证会话查询成功，正式PID139348及出生时间匹配，413个会话身份和111条workflow完整记录hash保持，running/waiting0。

针对“start未返回ID就不能继续”的反馈，复跑两组已有定向测试，共5/5通过：Planner/Reviewer省略ID找回原workflow；未取得线程身份拒绝恢复；真实子进程延迟返回thread/start时，父调用中止仍接收原回执并通过无ID resume继续，保持一个线程和一个子会话；真正启动失败可按父会话查询诊断但不创建替代线程。测试使用隔离fixture，不代表正式provider自然故障或浏览器UI验收。现有工具和恢复文档已描述这一区别，未重复修改生产代码或重启正式服务。
