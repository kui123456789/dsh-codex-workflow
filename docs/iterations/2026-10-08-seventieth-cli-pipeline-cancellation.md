# 第70轮：CLI跨阶段与保存回调的取消责任

状态：第70轮完整验收及正式加载完成，新PID148600。verify/release各1415/1415、host加载/恢复及diff通过，217份构建和正式数据核对通过；持续优化目标active，后续首因问题另有RED证据。

## 基线与实际RED

HEAD保持abb6174，既有dirty保留。正式PID148336/birth2026-10-08T23:20:02.9178710+08:00；只读认证查询确认413个会话身份、111条workflow完整记录保持，running/waiting0，原parent及历史corrupt child存在。原CLI SHA256为`A8CB01AD2226F96580B8A51652FD97B5FAA3A205ED8CC230D154BC00E164C1C6`，原副本已保存。

证据目录：../.codex-workflow-verification/seventieth-20261008/。连续两次执行node --import tsx ../.codex-workflow-verification/seventieth-20261008/cli-capture-cancel-probe.mjs，真实审查child exit0后，capture仍在保存。cancel(workflowId)漏掉整个公开调用，释放callback后再启动normalize，结果成功；记录captureCalls1/childStarts2，退出1。

16项初始测试12失败4通过，覆盖公开reconcile、缓存、最终review callback、stop等待、caller/API首因、peer和复用。原caller取消、错误目标与capture错误控制通过；RED日志和12个原actor目录保留，original-red-actor-observations.json归档。

## 实现与局部验证

仅修改CLI取消范围：提取复用withCancellation，公开review/createReview/reconcile/normalize/align及retry都登记完整操作，caller信号合并传递，返回前再检查，finally移除登记并结算done。已接纳capture/onThread回调继续归原操作负责，stop等待它们结束；取消阻止后续模型阶段及成功交付，预中止缓存请求不执行capture，错误与未匹配peer保持。

修复后16/16通过，真实probe变为childStarts1、captureCalls1且原取消原因拒绝。typecheck通过。原exec91331明确exit0，13个相关完整文件147/147、失败/取消/跳过0，65.47秒；覆盖第69轮17项、原准入/绑定/流错误/SIGKILL、阶段恢复及退避预算。生产CLI SHA256为`4B07A0AA4291FB7B33A2CCF93EE2E5281076CAF5CD3EC489426E5B2A60C3D6C9`。

[p-queue/p-retry固定源码研究](../research/github-cli-pipeline-cancellation-patterns-2026-10-08.md)核对8份原字节及MIT许可；Context7确认运行中的async task自行响应取消。采用完整操作责任，保留原callback完成和retry预算，不复制会丢失已接纳保存责任的提前Promise拒绝。未增加依赖、未提高Node最低版本、未新增callback硬超时。

## 正式加载边界

完整测试预期1415（第69轮1399+新增16）；正式加载须等本轮verify/release、host加载/恢复及diff完整结算，再实时确认原实例身份及无运行/等待任务，并保存新前后数据基线。不能以147项局部结果放行。provider/profile/凭据及原会话保持；未commit/push/publish，受控测试不证明真实provider故障、Token费用或浏览器UI。

## 冻结与唯一完整链

301份代码/测试/脚本及发布输入已冻结，并保存同数快照；manifest SHA256为`1654FADA034CBAE688387DE792E28DDCA0D3BBC4810A35EEE19FD982EA90B3EE`。相对第69轮仅CLI源、README、CHANGELOG3份变化，新增测试/actor/backend3份；研究及迭代文档在冻结集合之外。逐项hash偏差0，Junction仍指向本D盘仓库。

原exec47809已启动唯一完整链，目录final-gates-d2bb6b56-a22f-43f6-bcc5-9f952e6f97ea/，依次verify、release、host、host-recovery、diff。每阶段前后核对301份集合及hash；verify/release各要求1415/1415、失败/取消/跳过0和异步警告0。因当前内存余量较少，采用文件并发1，场景内部并发和时限保持。观察等待到期后继续原exec。

操作helper绑定原正式PID148336、ISO出生时间及实时CIM读取的win32:134359464029178710。只读guard探针exit0、PowerShell解析0错误、retirement helper语法通过。冻结helper成功时显式exit0，避免前轮外层误读旧LASTEXITCODE；正式reload收据及本轮最终build冻结尚未生成。

## 完整链运行中的观察

2026-10-08T23:52:37+08:00，原exec47809仍可等待，原runner实际子进程正在执行external-handoff-process-exit.test.ts。完整verify日志已记录614项通过，失败和异步警告0；本轮16项公开调用/capture取消回归全部通过。301份输入逐项hash保持，未生成最终summary或reload收据；运行中的通过行不代替完整门禁成功。观察结果保存于verification-observation.json，后续继续原exec。

## 完整verify结算

2026-10-09，原exec47809的verify明确exit0：1415/1415，失败/取消/跳过与异步警告0，1776.64秒。原summary.json及verify.log保留；verify-completion-audit.json核对唯一原收据和301份冻结输入偏差0。本轮16项公开调用取消及第69轮17项退避取消都在完整运行通过。

同一exec进入release，未因跨日或观察等待到期重开。发布包审计、host加载/恢复与最终diff仍待结算，build-freeze/reload收据未生成。三个操作helper重新解析通过，原PID148336及ISO/Windows出生键匹配，source manifest保持；post-verify-operation-audit.json记录本轮核对，日期字段先规范化后比较，retirement helper语法通过。正式加载须再实时确认原实例和实际空闲状态。

## 最终完整验收

2026-10-09，原exec47809明确terminal exit0，同一完整链按顺序结算，未因跨日或观察等待到期重开：

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| verify | 1415/1415，失败/取消/跳过及异步警告0 | 1776.64秒 |
| release:check | 1415/1415，失败/取消/跳过及异步警告0，包审计通过 | 1827.51秒 |
| host:check | exit0，安装宿主加载通过 | 5.54秒 |
| host:recovery:check | exit0，受控原线程恢复通过 | 7.41秒 |
| diff --check | exit0 | — |

离线doctor通过（5项skipped），临时tarball清理完成。宿主恢复使用scripted-local网关及隔离存储，browserUIVerified false；没有将这些门禁泛化为正式provider自然故障、Token费用或浏览器交互。

301份冻结输入保持。最终217份build manifest SHA256为`586BA055E92C4F39234461D48FF515B6B13608085562C8D07E39011C4F23F9D9`，build-freeze-receipt.json绑定唯一原门禁；冻结helper显式exit0，未重写已有冻结结果。

## 正式加载与数据保护

实时确认原PID148336及ISO/Windows出生标识、Junction指向D盘本仓库、running/waiting0，再保存新前置元数据并执行一次受控重载。原exec2456明确terminal exit0，原11个捕获实例已确认退出，只启动一个新实例：PID148600/birth`2026-10-09T00:41:57.4914810+08:00`。原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

formal-verification.json确认217份构建和27个关键模块hash偏差0，413个会话身份、111条workflow完整记录保持，stderr致命匹配0、running/waiting0。原parent/历史corrupt child保留，workflow完整记录SHA256仍为`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持；12份负向actor目录及原失败证据保留，未commit/push/publish。

## 后续独立RED：取消首因被后来的stop覆盖

release等待期间，仅在第71轮独立证据目录运行缓存capture探针，未修改本轮301份冻结输入。caller先abort，再audit.stop，释放原capture后虽没有模型请求（modelStarts0/captureCalls1），却把原caller原因换成dispatcher is stopped。连续两次同结果，退出1；原RED与重复日志位于../.codex-workflow-verification/seventyfirst-20261009/。

这项证据针对已接纳操作的首因交接，不是额外模型请求；后续修复须覆盖相反顺序和新请求准入，保留普通callback错误。没有将它计入本轮16项回归，也不据此改变已完成原验证链；持续优化目标保留，待后续独立修复和验收。
