# 第69轮：CLI重试全过程的定向取消

状态：第69轮完整验收及正式加载完成，新PID148336。verify/release各1399/1399、host加载/恢复与diff通过，217份构建及正式数据核对通过。持续优化目标active。

## 实际RED

HEAD保持abb6174，保留既有dirty。生产CLI原SHA256为`C89402823C3A2C18511FA8524EB1B0D8BB746532132817EA548B91825035735D`，已保存原副本。证据目录：`../.codex-workflow-verification/sixtyninth-20261008/`。

连续两次运行`node --import tsx ../.codex-workflow-verification/sixtyninth-20261008/cli-backoff-cancel-probe.mjs`，真实child退出后原操作退避等待。取消workflow没有使调用结束，等待释放后额外启动第二个模型进程。RED记录`settledBeforeWakeup:false`、`backoffSignalAborted:false`、原exitCode1、afterWakeupChildStarts2，退出1。

初始15项公开调用/身份/原因/停止控制13失败2通过，`tests-red.log`及原actor目录保留。wrong-target和caller-first原来通过，证明不是所有取消机制都失效。另补无caller信号和生产默认timer两个控制，累计17项。

## 实现与局部结算

只扩展现有CLI重试生命周期：现有pendingRuns登记整次retry的workflow/submission及Controller/done，caller信号合并后送入准入、child与sleep，finally移除并结算。stop等待原retry结束；即使自定义sleep不及时响应，唤醒后的取消检查也阻止额外模型请求。原错误、预算和线程身份保持，新显式调用不永久封禁。

初始15项修复后通过；真实probe变为settledBeforeWakeup true、signalAborted true、starts始终1，exit0。相关测试发现取消信号与直接child.abort重叠造成重复kill；原child终止改为幂等，保留首次cause和原SIGKILL升级计时器。随后顺序复跑12个相关文件131/131通过，57.15秒，失败/取消/跳过0；包含17项新增控制及原SIGKILL升级、绑定、准入、流错误、阶段恢复、退避预算。前一次131项130通过1失败的日志保留，不当作验收成功。typecheck通过，完整verify/release/host门禁未结算。生产CLI新SHA256为`A8CB01AD2226F96580B8A51652FD97B5FAA3A205ED8CC230D154BC00E164C1C6`。

## 外部机制

[p-retry/Cockatiel固定源码比较](../research/github-cli-retry-operation-cancellation-patterns-2026-10-08.md)保存8份原字节、Git blob与SHA256收据，并核对MIT许可。采用整个retry的取消责任和等待前后检查，保留已有本地退避实现；未新增依赖、未提高Node最低版本。没有把受控fixture当作真实provider或浏览器验收。

## 正式数据保护

第68轮收尾时413个会话身份、111条workflow完整记录和原parent/历史corrupt child保持，正式PID139348/birth2026-10-08T21:57:12.7624400+08:00。后续加载须重新读取实例身份与实际空闲状态，并保存新的前后数据基线。未经本轮完整门禁，不重载正式服务；未commit/push/publish。

## 冻结与唯一完整链

298份代码/测试/脚本及发布输入冻结，并保存同数源码快照；manifest SHA256为`07A53BF51C78BA0680A3603A8B952ADEED62D90A8B60741E3E0865041AFEA4EC`。相对第68轮仅CLI源、README、CHANGELOG3份变化，新增测试/actor/backend3份；研究和迭代文档不在冻结集合中。

原exec54891已启动唯一完整链，目录`final-gates-7ebfd69a-45b6-48e5-8300-575001372e81/`，依次verify、release、host、host-recovery、diff。每阶段前后核对298份集合/hash；完整verify/release各要求1399/1399、失败/取消/跳过0及异步警告0。采用文件并发1，保留场景内部并发及时限；观察等待到期后继续同一exec。

操作helper全部绑定原正式PID139348、ISO出生时间和从实时CIM读取的`win32:134359414327624400`；只读guard探针exit0，PowerShell解析0错误，retirement helper语法通过。Junction仍指向本D盘仓库；最终build冻结、reload收据及正式加载结算尚未生成。

## 完整链运行中的证据

2026-10-08T22:32:03+08:00，原exec54891仍可等待，原runner实际子进程正在执行foreground-new-review-round.test.ts。完整verify日志已记录613项通过、失败及异步警告0；本轮17个backoff取消场景全部通过，原cancelSubmission终止/SIGKILL升级回归也通过。尚无最终summary或reload收据，不把运行中的通过行当作完整门禁成功。观察结果保存于verification-observation.json；8份固定源码及两份MIT许可再次核对通过，research-receipt-audit.json记录字节偏差0。

## 完整verify结算

原exec54891的verify明确exit0：1399/1399，失败/取消/跳过与异步警告均0，1755.20秒。对应summary.json和verify.log留存，verify-completion-audit.json再次校验唯一原收据和298份冻结输入偏差0。本轮17项退避取消及原单次终止回归均在完整运行通过。

同一个exec已进入release，没有因观察等待到期重开测试。release包审计、host加载/恢复和最终diff尚未结算，build-freeze和reload收据仍未生成；正式加载前须等待完整门禁并实时核对原实例身份及实际空闲状态。

verify结算后再次核对三个操作helper：本轮目录、298/1399、解析0错误和retirement helper语法均通过；实时PID139348、ISO出生时间及Windows出生键匹配。第一次审计因PowerShell ConvertFrom-Json把originalBirth转为DateTime，直接与字符串比较产生误报；规范化为round-trip格式后确认完全一致，Windows键始终匹配。原误报保存为post-verify-operation-audit-date-conversion.json，正确结果保存为post-verify-operation-audit.json；没有削弱guard、重启服务或修改冻结代码。

## 最终完整验收

原exec54891明确terminal exit0，同一个完整链按顺序结算，未因观察超时重开：

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| verify | 1399/1399；失败、取消、跳过及异步警告0 | 1755.20秒 |
| release:check | 1399/1399；失败、取消、跳过及异步警告0；包审计通过 | 1766.12秒 |
| host:check | exit0，安装宿主加载通过 | 3.75秒 |
| host:recovery:check | exit0，受控原线程恢复通过 | 6.40秒 |
| diff --check | exit0 | — |

离线doctor通过（5项skipped），临时tarball清理完成。安装宿主恢复使用scripted-local网关及隔离存储，明确browserUIVerified false，不能泛化为正式provider自然故障或Token费用验收。

298份冻结输入保持。最终217份构建manifest SHA256为`073AE77F0B9719D382154C0A138BE9342BC0BE8714FD14A58712EC87262FF864`，build-freeze-receipt.json绑定唯一完整门禁，build-freeze-completion-audit.json确认清单/哈希及原门禁匹配。

末次观察脚本在完整链已exit0后统计空diff日志，因null返回格式错误；以原summary和实际终态核对五项门禁均成功，未重新启动链。冻结脚本成功生成收据后，外层错误读取旧LASTEXITCODE曾误报失败；逐项核对已有217份清单、hash和收据确认成功，没有覆盖冻结文件。PowerShell脚本/cmdlet结算使用实际调用成功状态，原生命令使用其实际退出码。

## 正式加载与最终数据核对

实时确认原PID139348/birth及Windows实例键、D盘Junction、正式running/waiting0，保存新前置元数据，再执行一次受控重载。原exec7782明确terminal exit0；原11个捕获实例已确认退出，只启动一个新实例：PID148336/birth`2026-10-08T23:20:02.9178710+08:00`。原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

formal-verification.json确认217份构建及27个关键模块hash偏差0，413个会话身份与111条workflow完整记录保持，stderr致命匹配0，running/waiting0。原parent和历史corrupt child均保留；workflow完整记录SHA256仍为`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，没有重建丢失ephemeral线程、替换会话或用父会话代写结果。provider/profile/凭据保持，13份负向actor目录及原失败证据保留；未commit/push/publish。
