# 第64轮：CLI输入与模型输出流错误归属

状态：第64轮已完成完整验收并加载正式DSH，PID141052。verify/release各1341/1341，host加载/恢复与diff通过；持续优化目标active。

## 基线与实际RED

只读核对PID133572/birth `2026-10-08T15:23:20.0347900+08:00` / `win32:134359178000347900`，413个会话身份和111条workflow完整记录保持，原parent/历史corrupt child存在，running/waiting0。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `99D0C0332218C72367BC8878A88A699B7E9AB449919AF4780A390A81AB0CAB51`，原副本 `codex-cli-audit-before.ts` 保存。

执行 `node --import tsx ../.codex-workflow-verification/sixtyfourth-20261008/cli-output-failure-probe.mjs`，0.75秒exit1：真实Node后端已经准备好，原stdout.destroy受控Error导致宿主Unhandled error event，不能返回模型结果。负向backend在IPC断开后退出，CIM核对无匹配进程；原日志和临时目录保持，不进行额外删除尝试。

初始10项actor测试8失败2通过，其中原stdin用例在写完后destroy未触发预期error，改用真实后端暂停读取、4MiB待完成写入；修正后的stdin/cancel-stdin两项均RED，原日志另存。复制归档10份失败actor状态，10份都有uncaught监测记录，原临时目录保持。不是正式provider自然错误或人为耗尽系统管道。

## 实现与初步验证

仅改CLI原run：stdin/stdout独立持久error监听，共用原abort/kill/close结算，首次错误或先前取消保持对象身份；同步prompt end异常走同一清理。pendingError后不解析新的stdout数据或最终线程身份，但已接纳的identity binding仍要完成才释放原child。已结算旧错误只消费，不影响后继。原stderr、字节预算、kill escalation与operation timeout保持。

新增test/cli-model-stream-failure.test.ts及真实backend/actor：control、stdin、sync-stdin、stdout、completed-stdout、cancel-stdin/ stdout、retired-stdin/stdout、successor-stdin/stdout；11项初步GREEN通过，真实stdout probe变为starts1、sameCause true、原backend实际SIGTERM退出。第一次typecheck因测试的可空stdin类型引用失败，原日志保留；修正测试类型后typecheck通过。

原exec16529明确terminal exit0：7个完整相关文件70/70、fail/cancelled/skipped0，25.60秒。其终态后再补第12项identity-stdout，控制表明原child.close后caller仍未结算且children1，原已提交绑定完成才返回首个stream错误并移除children。目标控制1/1通过、最终typecheck通过，原exec83050运行最终7文件控制；运行期间不改输入。

生产CLI源SHA256 `8AC951D7F5E7A817BA7FD4C85C20DFD44529E4178A1C174EB60701D94F2301F0`。通过[Execa/Node固定研究](../research/github-cli-model-stream-ownership-patterns-2026-10-08.md)核对8份源码、测试和许可字节与Git blob；未增加依赖。CLI自身循环直接抛原流错误，不新增model process，但上层workflow恢复分类仍沿用原策略，不能泛化为整个工作流永不重试。

provider/profile/凭据及历史workflow保持，未commit/push/publish。仅覆盖显式流error和同步end异常，不证明静默堵塞、自然EPIPE、完整后代退出或真实Token节省。完整测试预期1341（原1329+新增12），正式加载仍待完整门禁证明。

最终原exec83050明确terminal exit0：7个完整相关文件71/71、fail/cancelled/skipped0，25.71秒；identity binding控制与第63轮诊断隔离、第62轮字节预算、原CLI阶段/终止分类及重试deadline/抖动上限共同通过。最终typecheck exit0，未以首次测试类型失败的结果放行。

## 冻结后的完整链

284份代码/测试/脚本及发布输入已冻结并保存同数快照；manifest SHA256 `44C8B57B03F7A1C74A58A959CB2BD6DB6328AC089F41FD0791BECEC9536FA550`。包括src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE，研究和迭代记录在此集合之外。

唯一完整链原exec45833，目录 `final-gates-dda37b4c-c119-43f8-80a7-6992d2a108f1/`，依次verify、一次release、host、host-recovery、diff；每阶段前后检查284份输入集合和hash，verify/release预期1341/1341、fail/cancelled/skipped0及0异步警告。独立文件并发1，原内部并发与场景时限保持；当前已启动verify，尚未取得完整终态，不重开链。

操作helper绑定本轮唯一门禁、284/1341及正式原PID133572/ISO birth/Windows出生标识。实际CIM匹配、只读身份探针exit0、PowerShell解析0错误和Node retirement helper语法通过；前置认证使用第63轮私有state。最终build freeze及reload receipt尚未生成，只有完整门禁通过且正式服务实际无运行/等待工作才可重载。观察等待到期沿用原exec或已启动实例，不能作为重新启动理由。

## 完整verify结算

原exec45833的verify已明确exit0：1341/1341、失败/取消/跳过均0、异步警告0，1630.61秒。完整 `verify.log` 和 `summary.json` 留存，同一exec进入release，没有因观察到期重复启动。新增12项模型流场景和第63轮9项诊断流场景都在完整运行中通过；未用71项局部结果替代完整门禁。

284份冻结输入及文件集合保持。`source-change-receipt.json`确认相对第63轮仅CLI源与README/CHANGELOG3份hash变化，新增测试/actor/backend3份；原Bridge事件顺序修正和共享重试/App Server模块保持。发布包审计、host加载/恢复和diff终态仍待结算，最终build freeze与reload receipt未生成；正式DSH仍第63轮，重载前须实时确认空闲及原实例身份。

## 最终完整验收

原exec45833明确terminal exit0，完整链沿用同一个进程，没有因观察到期重开：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1341/1341；失败、取消、跳过与异步警告均0 | 1630.61秒 |
| release:check | 1341/1341；失败、取消、跳过与异步警告均0；包审计通过 | 1664.65秒 |
| host:check | exit0，安装宿主加载通过 | 3.79秒 |
| host:recovery:check | exit0，本地受控模型网关与隔离存储的原线程恢复通过 | 6.39秒 |
| diff --check | exit0 | — |

新增12项模型流场景和第63轮9项诊断隔离场景在完整verify/release中均通过。离线doctor通过（5项skipped），临时tarball已清理。host恢复采用安装DSH0.1.7-rc.2，明确 `browserUIVerified: false`，不能泛化为正式provider自然故障、真实Token计费或浏览器交互验收。

284份发布输入和原manifest保持；最终217份build冻结SHA256 `F8D0CD43B89D19331287C0A06540F91B6BEB2931416DFD76D4D2AB48A22E1D6C`，`build-freeze-receipt.json`关联唯一完整门禁。完整verify后操作helper重新核对本轮门禁与manifest、解析0错误，记录于 `post-verify-operation-audit.json`。

## 正式加载与数据核对

再次实时确认原PID133572/ISO与Windows出生标识、插件Junction指向D盘当前仓库、running/waiting0后，执行一次受控重载。原exec8940明确exit0，只启动一个新实例；捕获的11个原进程树实例确认退出。新PID141052/birth `2026-10-08T16:36:14.4061880+08:00`，原Node/DSH入口和127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build及27个关键模块哈希0偏差，413个会话身份与111条workflow完整记录保持，stderr致命匹配0。原parent/历史corrupt child存在，未替换或伪造旧ephemeral线程；workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，负向probe及actor证据保持留存，未commit/push/publish；持续优化目标active。
