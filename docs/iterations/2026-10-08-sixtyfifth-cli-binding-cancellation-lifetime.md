# 第65轮：CLI原身份保存期间的取消观察

状态：第65轮已完成完整验收并加载正式DSH，PID123048。verify/release各1350/1350，host加载/恢复与diff通过；持续优化目标active。

## 基线与RED

只读核对PID141052/birth `2026-10-08T16:36:14.4061880+08:00` / `win32:134359221744061880`，413个会话身份和111条workflow完整记录保持，running/waiting0，原parent/历史corrupt child存在。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `8AC951D7F5E7A817BA7FD4C85C20DFD44529E4178A1C174EB60701D94F2301F0`，原副本 `codex-cli-audit-before.ts` 保存。

执行 `node --import tsx ../.codex-workflow-verification/sixtyfifth-20261008/cli-binding-abort-probe.mjs`，0.74秒exit1：真实CLI backend返回原thread.started并exit1，原身份保存仍暂停；此时caller abort，释放原保存后却返回CodexCallbackProcessError/permission denied，sameCancellation false。原JSON另存RED，backend临时目录经真实路径校验后清理。

新增9项独立actor场景，旧实现2失败7通过。失败是caller取消和绑定随后拒绝；成功来源的取消在后续入口会被检查，workflow/submission cancel与stop已有自己的children等待，不扩大成全路径故障。两个失败actor状态复制归档，原目录留存。

## 实现与局部结果

仅移动CLI原run的signal.removeEventListener：原child.close继续清理模型timer和收尾stdout/stderr，caller取消监听保留到原binding结算，随后移除listener、删除children、resolveDone并返回首次pendingError或原结果。原绑定不跳过、不取消，不增加模型、线程或保存callback次数。模型deadline、kill escalation、诊断标记和byte budget保持。

9项GREEN通过，typecheck exit0；真实probe修复后sameCancellation true、starts1、actual exit1，精确返回原取消对象。首个取消也不会被之后原保存失败覆盖；未取消时绑定错误对象和进程终止分类保持。

原exec58906明确terminal exit0：8个完整相关文件80/80、fail/cancelled/skipped0，30.12秒；包含原身份binding held window、第64轮模型流错误、第63轮诊断隔离、字节预算及原重试deadline/抖动控制。运行期间不修改输入，diff检查通过。生产CLI源SHA256 `6AFD928297EC43AFEA8ECA37064C0E0443ADA81AD4C158E88403C702382ECDDA`。

通过[Execa/Node固定研究](../research/github-cli-binding-cancellation-lifetime-patterns-2026-10-08.md)核对9份源码/测试/许可的Git blob字节，未增加依赖。不把取消监听寿命泛化为绑定callback永不结算时的硬deadline，也不证明自然provider故障或真实Token费用。provider/profile/凭据和历史workflow保持，未commit/push/publish；完整测试预期1350（原1341+新增9），正式加载仍待完整门禁证明。

## 冻结后的完整链

287份代码/测试/脚本及发布输入冻结并保存同数快照，manifest SHA256 `7F8C08B51C17629AFBD23858C4C165B5968990C920C003FFED87C4415B982184`。包含src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究与迭代记录在此集合之外。

唯一完整链原exec75354，目录 `final-gates-b23d5233-3cbf-4fcb-944a-47dded84ee86/`，依次verify、一次release、host、host-recovery、diff。每阶段前后核对287份完整输入集合与hash，verify/release要求1350/1350、fail/cancelled/skipped0及0异步警告；独立文件并发1，原内部并发和场景时限保持。当前已启动verify，不能用80项局部结果代替完整终态，也不因观察等待到期重开链。

操作helper绑定本轮唯一门禁、287/1350及正式原PID141052/ISO birth/Windows出生标识，实际CIM匹配、只读身份探针exit0、PowerShell解析0错误与Node retirement helper语法通过。前置认证使用第64轮私有state；本轮最终build freeze和reload receipt尚未生成。完整门禁通过且正式服务实际无运行/等待工作后才能重载，观察超时沿用原exec或已启动实例。

## 完整verify结算

原exec75354的verify明确exit0：1350/1350、失败/取消/跳过均0、异步警告0，1672.43秒。完整 `verify.log` 和 `summary.json` 留存，同一exec进入release；本轮9项绑定窗口测试、第64轮12项模型流、第63轮9项诊断隔离都在完整运行通过，未以80项局部结果替代完整门禁。

287份冻结输入保持，`source-change-receipt.json`记录相对第64轮CLI源与README/CHANGELOG3份hash变化、测试/actor/backend3份新增；原共享重试、App Server及既有Bridge事件屏障不变。发布包审计、host加载/恢复、diff终态与正式加载仍待独立证明；最终build freeze及reload receipt尚未生成。正式服务仍第64轮，重载前须实时确认无运行/等待工作及原实例身份。

## 最终完整验收

原exec75354明确terminal exit0，完整链沿用同一个进程，没有因观察到期重开：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1350/1350；失败、取消、跳过与异步警告均0 | 1672.43秒 |
| release:check | 1350/1350；失败、取消、跳过与异步警告均0；包审计通过 | 1688.70秒 |
| host:check | exit0，安装宿主加载通过 | 3.86秒 |
| host:recovery:check | exit0，本地受控模型网关与隔离存储的原线程恢复通过 | 6.66秒 |
| diff --check | exit0 | — |

本轮9项绑定场景及前两轮模型/诊断流控制在完整verify/release中通过。离线doctor通过（5项skipped），临时tarball已清理；host恢复采用安装DSH0.1.7-rc.2，明确 `browserUIVerified: false`，不是正式provider自然故障、Token计费或浏览器交互证明。

287份发布输入及原manifest保持；最终217份build冻结SHA256 `8DB02F43983E793698496307B23034BA51673175ADCCAA9C28DE85DF5B690F72`，`build-freeze-receipt.json`关联唯一完整门禁。完整verify后操作helper重新核对本轮目录与manifest、解析0错误，记录于 `post-verify-operation-audit.json`。

## 正式加载与数据核对

再次实时确认原PID141052/ISO及Windows出生标识、插件Junction指向D盘当前仓库、实际running/waiting0后，执行一次受控重载。原exec98747明确exit0，只启动一个新实例；捕获的11个原进程树实例确认退出。新PID123048/birth `2026-10-08T17:46:23.4318560+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build和27个关键模块哈希0偏差，413个会话身份与111条workflow完整记录保持，stderr致命匹配0。原parent和历史corrupt child存在，没有替换或伪造旧ephemeral线程；workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，负向actor证据保留，未commit/push/publish；持续优化目标active。
