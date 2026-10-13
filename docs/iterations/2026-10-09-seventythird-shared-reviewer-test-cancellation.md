# 第73轮：共享Reviewer测试取消与清理

状态：第73轮完整验收完成，verify/release各1455/1455、host加载/恢复和diff通过。217份生产构建与正式版本完全一致，维护者脚本/测试通过原Junction生效，保留原PID4448，未执行重载。第72轮失败门禁及证据保留，持续优化目标active。

## 基线和实际RED

HEAD保持abb6174，保留既有dirty；正式PID4448/birth2026-10-09T03:29:22.6331920+08:00，认证健康HTTP200。第72轮后台PID9792已明确完成exit1，原fixture worker2812的3个实例已按原birth确认退出，未再等待或重开该handle。

第72轮完整verify1448/1448通过；release1447通过/1取消，原第201项明确test timed out after 30000ms。原worker持有已释放lease的sending记录及模型进程，其他文件结束后仍等待超过20分钟。保持原30秒声明及全部业务断言；原自然通知未到达的具体时序尚未独立复现。

本轮证据目录../.codex-workflow-verification/seventythird-20261009/。原fixture源码保留。最小probe阻挡lease通知并取消caller：settledAfterCancellation false、cause未保留、backgroundTasks1/nativeCalls1/child1/dispose0，退出1；finally只清理自己的原协议进程。

## 回归与实现

初始6项5失败1健康控制通过，覆盖lease观察、forward、background join、预中止及重复close。background actor起初错误路由forward gate，纠正后单独RED仍失败，background-red-corrected.log保留，不把错误阶段证据当成正确覆盖。

fixture可选TestContext signal传入exec与命名step；每个阶段预检查取消、监听abort并清listener，拒绝保留原reason；原任务晚拒绝继续被消费。close共享同一个Promise，释放测试gate，先停止manager取消原callbacks，再关闭client/context/store。六个unavailable原调用者注册t.after，同时保留原finally；重复清理合并。生产src与业务恢复工具未改，原30秒用例限制未调大。

7/7通过；真实native-timeout actor以4秒控制测试期限进入lease loss observation，Node仍报告取消（exit1），after及finally单次清理完毕，nativeCalls仍1、backgroundTasks0、工作进程自然退出，外层回归通过。额外核对该phase、held notice与原调用数的控制通过。原probe变为settledAfterCancellation true、cause原引用保持，退出0。

typecheck通过；原exec53184明确exit0，11个相关完整文件38/38、失败/取消/跳过0，39.57秒，文件并发2，包含原new-round和unavailable路由及共享owner/retirement/progress/heartbeat/consumer行为。证明取消及清理缺口已补齐；不宣称原自然通知竞态已被完整定位，后续完整门禁继续验证。

## 外部机制和下一步

[Node/p-cancelable固定源码研究](../research/github-test-context-cancellation-patterns-2026-10-09.md)核对6份原字节、Git blob与许可，Context7确认TestContext APIs。采用原生signal及after hook，无新增依赖或最低Node变化。

完整测试预期1455（第72轮1448+新增7）。本轮完整verify/release、host加载/恢复和diff未结算；不能用38项代替门禁或改写第72轮失败记录。通过后比较正式217份build，生产文件全同则保留PID4448并确认链接的维护者脚本/测试已生效。provider/profile、workflow数据和历史corrupt child保持；未commit/push/publish。

## 冻结与唯一完整门禁

306份代码/测试/脚本及发布输入冻结，保存同数快照；manifest SHA256为`53645E7B17BD1E2807610780DA0C8CB2AF6B6F415F890C9EDD908DFCB765736F`。相对第72轮改README/CHANGELOG、两个原调用测试和shared fixture，新增cancellation测试及actor2份。生产src和第72轮TAP launcher保持；发布清单与研究/迭代文档在冻结集合之外。

唯一门禁目录final-gates-dedecfc9-0a91-44e1-8b90-75a8bed0b8a2/，依次verify、release、host、host-recovery、diff，阶段前后核对306份集合/hash。完整verify/release各要求1455/1455、失败/取消/跳过及异步警告0；使用TAP和文件并发2，原30秒用例及内部并发/时限保持。

durable-final-gates.ps1由隐藏后台pwsh单次启动，durable-gates-start.json保存原PID/birth，finally保存真实完成收据；观察到期继续按同一实例等待。操作helper解析0错误，原正式PID4448/ISO出生及win32:134359613626331920匹配，retirement语法通过；完整结果、最终build冻结尚未生成，不放行后续加载。

## 完整verify结算

后台原PID34604/birth2026-10-09T04:59:33.2724980+08:00/win32:134359667732724980的verify明确exit0：1455/1455、失败/取消/跳过/TODO及异步警告0，905.14秒。TAP原数字直接提取，summary.json及verify.log保留；verify-completion-audit.json复核306份原freeze偏差0，原new business round用例及真实native-timeout外层回归均通过。

同一后台实例继续release，未因观察到期重开；第二次完整执行仍需验证原rare等待是否出现，不能把一次verify成功泛化成自然lease通知原因已定位。发布/pack、host加载/恢复及最终diff待结算，最终build freeze未生成，不放行正式加载或宣称整轮完成。

## 最终完整验收

原后台PID34604/birth及Windows键保持，durable-gates-completion.json明确05:30:17完成、exit0、failureType null；没有因观察等待到期重开或遗留测试子进程。

| 门禁 | 结果 | 耗时 |
| --- | --- | --- |
| verify | 1455/1455；失败/取消/跳过/TODO及异步警告0 | 905.14秒 |
| release:check | 1455/1455；失败/取消/跳过/TODO及异步警告0，包审计通过 | 926.92秒 |
| host:check | exit0，安装宿主加载通过 | 4.09秒 |
| host:recovery:check | exit0，受控原线程恢复通过 | 6.25秒 |
| diff --check | exit0 | — |

release明确RELEASE_CHECK_OK，离线doctor通过（5项skipped），临时tarball清理完成；TAP原数字汇总直接解析，没有手工补写计数。原new business round用例在verify和release均正常通过，新真实native-timeout actor在外层回归通过，取消仍被正确报告。此前自然lease通知为何未到达的具体时序没有被这两次成功定位；受控取消/清理缺口及原失败记录保持区别。

宿主恢复使用scripted-local网关及隔离存储，browserUIVerified false；不证明正式provider自然故障、Token费用或浏览器交互。第72轮1447通过/1取消的release和原进程退休证据不改写，新完整结果记录在本轮唯一目录。

## 保留正式进程的维护者验收

306份输入保持冻结，最终217份build manifest SHA256为`D259120CCFB02AFE4993848CCCB63FC30EEA113F7A447EA7AFFFA63CA4A97EB6`，build-freeze-receipt.json绑定原门禁。verify-maintenance-without-restart.ps1验证完整门禁实际终态和计数、源文件hash、全部217份构建相对第71轮逐项hash一致，再实时核对原PID4448/出生键、Junction、认证健康与实际会话/记录。

formal-maintenance-verification.json确认原DSH实例仍PID4448/birth2026-10-09T03:29:22.6331920+08:00，health HTTP200；生产buildMismatches0、Junction指向D盘本仓库，reloadExecuted false。维护者launcher每次执行直接读取该仓库，TAP入口和测试改进已经过完整验收，无需为了测试/文档创建新的DSH实例或丢失已有ephemeral资源。

认证API确认413个会话身份hash保持，111条workflow完整记录hash仍为`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，原parent/历史corrupt child保留，running/waiting0。provider/profile/凭据保持，未commit/push/publish；原受控失败actor证据与第72轮真实失败门禁保留，持续优化目标active。
