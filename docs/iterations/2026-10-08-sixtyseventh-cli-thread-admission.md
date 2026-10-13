# 第67轮：同CLI Reviewer的准入预留

状态：第67轮已完成完整验收并加载正式DSH，PID146760。verify/release各1368/1368，host加载/恢复与diff通过；持续优化目标active。

## 基线与实际RED

只读核对PID89636/birth `2026-10-08T19:01:38.8152830+08:00` / `win32:134359308988152830`，413个会话身份与111条workflow完整记录保持，running/waiting0，原parent/历史corrupt child存在。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `C38015ED7115C3CC30F017D38229716F7FA40D80302F0B64C85DF55C543C7B5D`，原副本 `codex-cli-audit-before.ts` 保留。

执行 `node --import tsx ../.codex-workflow-verification/sixtyseventh-20261008/cli-thread-admission-probe.mjs`，0.91秒exit1：owner真实exit0后，两名queued caller都spawn，starts3、两个后继活动child。原JSON另存RED，临时backend目录在真实路径边界检查后清理。不是正式provider自然writer冲突或Token费用证明。

初始7项actor控制5失败2通过，但取消两个场景的观察在queued spawn微任务前发生，实际记录children1而非真正并发；原日志保留。只补事件循环观察屏障，生产代码不变，正确RED变为serial/fresh/binding3失败，cancel-first/cancel-last/different-thread/spawn-throw4控制通过。没有用错误观察证明额外生产缺陷。

## 实现与局部验证

使用codebase-design把行为集中于原CLI Module内部，Gateway Interface不变。原run同步预留已知thread的reservation，等待前驱及原child.done后进入runAdmitted，finally释放。取消ticket在前驱结算之后才释放以阻止绕过原owner；未知新线程及独立normalization仍沿用原生命周期。已有caller取消观察在前驱/child等待共用，原binding与模型deadline保持。

8项初步GREEN通过，真实probe变为starts2、active1，typecheck通过；随后追加stop控制和占用Map归零检查，目标stop1/1通过。模型、线程没有被重建来“解决”争用；实际每名合法caller仍使用原thread，公开review的既有normalization保持独立。

原exec21614明确terminal exit0：10个完整相关文件98/98、fail/cancelled/skipped0，40.79秒，包含原queued取消、绑定、模型/诊断流、byte预算、阶段恢复及重试deadline/抖动控制。最终typecheck/diff通过，运行时不改输入。生产CLI源SHA256 `0F189E1146300BE3802FADC800EA9BF46F24B7EC6AFC57F0DF8AE5A17CEAD62A`。

通过[p-queue/async-mutex/Node固定源码研究](../research/github-cli-thread-admission-patterns-2026-10-08.md)核对11份原字节、测试及许可，未增加依赖。仅为一份dispatcher已知thread的单次CLI进程准入，不是跨进程锁、完整业务round锁或未知线程的全局互斥；永久前驱仍可能保留取消链。provider/profile/凭据、历史workflow保持，未commit/push/publish；完整测试预期1368（原1359+新增9）。

## 冻结后的完整链

293份代码/测试/脚本及发布输入冻结并保存同数快照，manifest SHA256 `A33599449946A1C245B59C96898520E9E0B60CBB4856A27E0F3D0045083E49C0`。包含src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究和迭代记录在此集合之外。

唯一完整链原exec78321，目录 `final-gates-3a109fe8-9571-4ee7-afaf-eee821b62264/`，依次verify、一次release、host、host-recovery、diff。每阶段前后检查293份集合/hash，verify/release要求1368/1368、fail/cancelled/skipped0及0异步警告；独立文件并发1，原内部并发和场景时限保持。当前verify已启动，不以98项局部结果放行，也不因观察到期重开链。

操作helper绑定唯一门禁、293/1368及正式原PID89636/ISO birth/Windows出生标识；实际CIM匹配、只读身份探针exit0、PowerShell解析0错误、Node retirement helper语法通过。前置认证使用第66轮私有state，最终build freeze和reload receipt尚未生成。全部门禁通过且正式服务实际无运行/等待工作后才能重载；观察超时继续原exec或已启动实例。

## 完整verify结算

原exec78321的verify明确exit0：1368/1368、失败/取消/跳过均0、异步警告0，1724.03秒。完整 `verify.log` 和 `summary.json` 留存，同一exec进入release，没有因观察到期重开；本轮9项准入及原9项queued取消控制都在完整运行通过，不用98项局部结果替代完整门禁。

293份输入及集合保持冻结，`source-change-receipt.json`记录相对第66轮CLI源与README/CHANGELOG3份hash变化、测试/actor/backend3份新增；原App Server、共享重试和已提交身份保存语义保持。release包审计、host加载/恢复、diff终态仍待结算，最终build freeze和reload receipt尚未生成；正式服务仍第66轮，加载前须实时核对原实例与实际空闲状态。

## 最终完整验收

原exec78321明确terminal exit0，完整链沿用同一个进程，没有因观察到期重新启动：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1368/1368；失败、取消、跳过与异步警告均0 | 1724.03秒 |
| release:check | 1368/1368；失败、取消、跳过与异步警告均0；包审计通过 | 1729.93秒 |
| host:check | exit0，安装宿主加载通过 | 3.82秒 |
| host:recovery:check | exit0，本地受控网关和隔离存储的原线程恢复通过 | 6.57秒 |
| diff --check | exit0 | — |

本轮9项准入与第66轮9项等待者取消控制均在完整verify/release通过。离线doctor通过（5项skipped），临时tarball已清理；host恢复采用安装DSH0.1.7-rc.2，明确 `browserUIVerified: false`，不是正式provider自然故障、Token计费或浏览器交互证明。

293份输入与原manifest保持；最终217份build冻结SHA256 `2AC423AC1A7EA1C8D0C58BD3237FF8A4CDB6191546F55F150FB75DD196F0ABE0`，`build-freeze-receipt.json`关联唯一完整门禁。完整verify后的三个操作helper核对本轮目录和manifest、解析0错误，记录于 `post-verify-operation-audit.json`。

## 正式加载与数据核对

再次实时确认原PID89636/ISO及Windows出生标识、插件Junction指向D盘当前仓库、实际running/waiting0后，执行一次受控重载。原exec79146明确exit0，只启动一个新实例；捕获的11个原进程树实例确认退出。新PID146760/birth `2026-10-08T20:24:50.4295430+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build与27个关键模块哈希0偏差，413个会话身份及111条workflow完整记录保持，stderr致命匹配0。原parent与历史corrupt child存在，没有替换或伪造旧ephemeral线程；workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，负向actor及观察修正证据保留，未commit/push/publish；持续优化目标active。
