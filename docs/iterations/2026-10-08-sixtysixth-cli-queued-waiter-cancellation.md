# 第66轮：CLI线程等待者的独立取消

状态：第66轮已完成完整验收并加载正式DSH，PID89636。verify/release各1359/1359，host加载/恢复与diff通过；持续优化目标active。

## 基线与实际RED

只读核对PID123048/birth `2026-10-08T17:46:23.4318560+08:00` / `win32:134359263834318560`，413个会话身份和111条workflow完整记录保持，running/waiting0，原parent/历史corrupt child存在。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `6AFD928297EC43AFEA8ECA37064C0E0443ADA81AD4C158E88403C702382ECDDA`，原副本 `codex-cli-audit-before.ts` 保存。

执行 `node --import tsx ../.codex-workflow-verification/sixtysixth-20261008/cli-queued-abort-probe.mjs`，0.79秒exit1：真实backend被IPC保持、同Reviewer的第二caller取消，两个事件循环观察边界之后queued仍未结算；owner仍活着、starts1、killRequests0。原JSON另存RED，backend临时目录在真实路径边界核对后清理。

新增真实backend/actor和test/cli-queued-waiter.test.ts，初始7项4失败3通过，旧失败是普通/default取消、绑定待完成owner和peer waiter；预取消、不同线程、无取消正常准入原本通过。原因是waitThreadIdle只观察owner.done，caller signal只在获得线程之后重新检查。

## 实现与局部结果

只改CLI原run/waitThreadIdle，传入caller signal，原owner.done等待加独立abort观察，等待结算/取消后移除自身listener。没有对owner发送kill、不撤销原binding、不取消peer waiter；无signal和正常准入仍沿用原行为。首个Error或默认DOMException reason对象保持，第65轮绑定监听清理和模型deadline不变。

7/7隔离控制、typecheck通过。真实probe修复后queuedSettled true/sameCause true、starts1、killRequests0，owner仍活着。原exec55082完整9文件先明确terminal exit0：87/87、fail/cancelled/skipped0，33.59秒；其终态后再追加public review入口与release/cancel竞态2项，两项通过。

最终原exec20320明确terminal exit0：9个完整相关文件89/89、fail/cancelled/skipped0，35.42秒，包含原CLI绑定、模型/诊断流、byte budget、阶段恢复和重试deadline/抖动控制。最终typecheck和diff通过；运行中不改输入。CLI生产源SHA256 `C38015ED7115C3CC30F017D38229716F7FA40D80302F0B64C85DF55C543C7B5D`。

通过[p-queue/Node固定研究](../research/github-cli-queued-waiter-cancellation-patterns-2026-10-08.md)核对9份源码/测试/许可字节与Git blob，未增加依赖。仅改变caller signal的排队观察，不改workflow/submission cancel路由或FIFO调度，不保证永久owner造成的全部Promise reaction提前释放。正式provider/profile/凭据和历史workflow保持，未commit/push/publish；完整测试预期1359（原1350+新增9），正式加载仍待完整门禁证明。

## 冻结后的完整链

290份代码/测试/脚本及发布输入冻结并保存同数快照，manifest SHA256 `541F2A1570F463999A8D734CB764911BF210ECC6291FE24CF1401F67AAA8A426`。包含src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究和迭代记录在此集合之外。

唯一完整链原exec17068，目录 `final-gates-dc87c8f0-2e18-408c-8e3b-c421f76e1b18/`，依次verify、一次release、host、host-recovery、diff。每阶段前后检查完整290份集合/hash，verify/release要求1359/1359、fail/cancelled/skipped0及0异步警告；独立文件并发1，原内部并发与场景时限保持。当前已启动verify，未取得完整终态，不能以89项局部结果放行。

操作helper绑定唯一门禁、290/1359与正式原PID123048/ISO birth/Windows出生标识，实际CIM匹配、只读身份探针exit0、PowerShell解析0错误及Node retirement helper语法通过。前置认证使用第65轮私有state；最终build freeze和reload receipt尚未生成。完整门禁通过且正式服务实际空闲后才能重载，观察超时继续原exec或已启动实例，不重新开启验证链。

## 完整verify结算

原exec17068的verify明确exit0：1359/1359、失败/取消/跳过均0、异步警告0，1694.69秒。完整 `verify.log` 和 `summary.json` 留存，同一exec进入release，没有因观察到期重开；本轮9项queued waiter场景都在完整运行通过，未用89项局部结果替代完整门禁。

290份发布输入保持冻结，`source-change-receipt.json`记录相对第65轮CLI源及README/CHANGELOG3份hash变化、测试/actor/backend3份新增；原身份绑定、模型/诊断流与共享恢复保护不变。release包审计、host加载/恢复、diff终态仍待结算，build freeze和reload receipt尚未生成；正式服务仍第65轮，加载前需实时检查原实例身份及实际空闲状态。

## 最终完整验收

原exec17068明确terminal exit0，完整链沿用同一个进程，没有因观察到期重复启动：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1359/1359；失败、取消、跳过与异步警告均0 | 1694.69秒 |
| release:check | 1359/1359；失败、取消、跳过与异步警告均0；包审计通过 | 1706.83秒 |
| host:check | exit0，安装宿主加载通过 | 3.82秒 |
| host:recovery:check | exit0，本地受控网关和隔离存储的原线程恢复通过 | 6.41秒 |
| diff --check | exit0 | — |

本轮9项queued waiter场景及既有绑定、模型/诊断流、byte budget等控制在完整verify/release通过。离线doctor通过（5项skipped），临时tarball已清理。host恢复采用安装DSH0.1.7-rc.2，明确 `browserUIVerified: false`，不是正式provider自然故障、Token计费或浏览器交互证明。

290份发布输入及原manifest保持；最终217份build冻结SHA256 `BA10A8B892F82F08F4FFD21361F29F854E6EEB71155F2A6247A05908A2D98073`，`build-freeze-receipt.json`关联唯一完整门禁。完整verify后的操作helper核对本轮目录与manifest、解析0错误，记录于 `post-verify-operation-audit.json`。

## 正式加载与数据核对

再次实时确认原PID123048/ISO与Windows出生标识、插件Junction指向D盘当前仓库、实际running/waiting0后，执行一次受控重载。原exec94168明确exit0，只启动一个新实例；捕获的11个原进程树实例确认退出。新PID89636/birth `2026-10-08T19:01:38.8152830+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build和27个关键模块哈希0偏差，413个会话身份与111条workflow完整记录保持，stderr致命匹配0。原parent与历史corrupt child存在，没有替换或伪造旧ephemeral线程；workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，负向actor证据留存，未commit/push/publish；持续优化目标active。
