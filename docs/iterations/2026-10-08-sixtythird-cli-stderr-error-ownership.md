# 第63轮：CLI诊断流错误隔离

状态：第63轮已完成完整验收并加载正式DSH，PID133572。verify/release各1329/1329，host加载/恢复与diff通过；首轮1328/1329失败及纠正证据保留，持续优化目标active。

## 基线与RED

只读核对PID142580/birth `2026-10-08T13:38:23.6914740+08:00` / `win32:134359115036914740`，413个会话身份与111条workflow完整记录保持，running/waiting0，原parent/历史corrupt child存在。HEAD仍abb6174，既有dirty保持。原CLI源SHA256 `B18C3AC58F41C97EA0421C1D654E803274C1EA18D70DDD4E87E35E430DBA1241`，原副本 `codex-cli-audit-before.ts` 保存。

执行 `node --import tsx ../.codex-workflow-verification/sixtythird-20261008/cli-stderr-failure-probe.mjs`，0.79秒exit1：真实本地Node模型替身stdout健康，stderr.destroy受控error却触发Unhandled error event，宿主probe退出，未能返回结果。探针后端自行退出，随后CIM确认无对应存活backend；未操作正式DSH。

自动审批拒绝删除负向probe临时目录的命令，未给进一步具体理由；没有尝试绕过删除。该精确目录保留，backend源码复制进本轮证据。其余失败actor诊断也复制保存，无目录删除。此限制不阻塞应用修复，亦不伪报临时清理完成。

## 回归与实现

新增test/cli-stderr-failure.test.ts及真实backend/actor：actor运行原dispatcher，以IPC控制真正stderr流故障与后端输出的顺序，monitor仅记录未捕获异常。初始7项正常1通过、6失败；6份原actor均记录uncaught。完整RED日志及 `original-red-actor-observations.json` 保留。

只改CLI dispatcher：原stderr持续error监听，按run独立记录不可用状态，健康stdout不失败；已结算旧错误只消费。原字节尾部预算和解码收尾保持，失败出口独立追加固定说明，不将error对象文本传入模型分类。合并内部CliProcessResult携带stderrUnavailable，无外部gateway契约变化；README/CHANGELOG更新边界。

新增非法线程与后继隔离两项控制；第一次额外2项结果1失败1通过，暴露非法线程出口遗漏不可用说明。保留日志后补齐同一出口说明，未降级其终止分类。最终9项全部通过：control、success、transient-exit、terminal-exit、invalid-thread、retired-error、successor、small-bound、stop。

## 已完成局部验收

typecheck exit0，9/9隔离场景通过。原exec46029明确terminal exit0：6个完整相关文件59/59、fail/cancelled/skipped0，21.82秒，包含原CLI output预算、阶段恢复、混合终止分类及等待deadline/抖动边界。运行时未改输入，未以局部结果替代完整门禁。

真实probe修复后starts1/streamErrors1、实际backend exit0，原verdict pass与summary返回；stderr读错误不会换进程重做。生产CLI源SHA256 `99D0C0332218C72367BC8878A88A699B7E9AB449919AF4780A390A81AB0CAB51`。通过[Execa/Node固定源码研究](../research/github-cli-stderr-error-ownership-patterns-2026-10-08.md)确认每流错误责任，6份字节/许可与Git blob一致，没有新增依赖。

不宣称正式provider自然故障、OS管道自然断开或真实Token费用验收；只处理诊断Readable error，不修复管道或完整诊断。正式provider/profile/凭据及历史workflow未改，未commit/push/publish；完整测试预期1329（原1320+新增9）。

## 冻结后的完整验证链

281份代码/测试/脚本及发布输入已冻结并保存同数快照；manifest SHA256 `F4F0564C32D5A17292B934548E67B092AF13C799CACC934B8C8C2C3D3E4A976F`。输入含src/test/scripts、package/lock、tsconfig、patch及README/CHANGELOG/LICENSE；研究与迭代记录在冻结集合之外。

唯一完整链原exec4978，目录 `final-gates-1dfebea6-423c-422c-89e3-8a340edc578c/`；依次verify、一次release、host、host-recovery、diff。每阶段前后检查完整输入集合和hash，verify/release要求1329/1329、fail/cancelled/skipped0与0异步警告；独立文件并发1，原内部并发及场景时限保持。当前已启动verify，未取得完整终态，不重开链。

操作helper绑定本轮唯一门禁、281/1329、正式原PID142580/ISO birth/Windows出生标识；实际CIM匹配、只读身份探针exit0、PowerShell解析0错误及Node retirement helper语法通过。前置认证使用第62轮私有state，最终build freeze与reload receipt尚未生成。只有完整门禁通过且正式无运行/等待工作才可重载；观察等待到期沿用同一exec或已启动实例。

## 原完整运行中的Bridge取消失败观察

原exec4978运行中出现既有 `Bridge cancellation keeps its durable original-process guard across cold managers until the exact cleanup ACK` 失败。原完整终态栈仍待结算，冻结281份输入不变；实际fixture的4份诊断文件复制保留为 `bridge-cancel-failed-evidence/`，文件hash回执保存。fixture error指出“至少一次原pair的failed interrupt”断言不成立；当时pin1、child1、disposals0，原保护记录保持，未产生替代模型。

代码外探针先对比立即cancel与“只等receipt ready”，两者都能在旧cleanupFlight尚未结束时没有interrupt，exit1及原脚本另存。进一步对比明确结算第一次pre-receipt cleanup：立即cancel的sizeAtFixtureReply1、failedACK false；先等第一次flight结算后size0、receipt ready，再cancel获得同一thread/turn的failedACK true。两条路径都是原modelRequests1/threadStarts1、pin1/disposals0，原生产逻辑不变，后一个探针exit0。

该证据确认场景缺少“第一次清理结束后才发第二次”的事件屏障；单等集合清空只证明已加入的旧flight结束，不能证明第二次已发原interrupt。未来纠正应显式等第一次flight与原receipt ready，再保留全部资源及原pair断言，不增加生产RPC或模型预算，不把joined cleanup强行当成新请求。只有原完整链明确terminal后才可改测试和冻结输入；当前仍未放行构建冻结或正式重载。

## 原完整失败结算与事件顺序修正

原exec4978明确terminal exit1：1329项中1328通过、1失败、fail/cancelled/skipped为1/0/0、异步警告0，1782.39秒；release/host后续阶段未执行。最终栈确认 `bridge-start-receipt-lifecycle.test.ts:83` 的failed ACK断言失败，与隔离证据及探针一致。

原manifest另存 `source-freeze-before-bridge-order-correction.json`、原测试另存 `bridge-start-receipt-lifecycle-before.ts`，最初281份source-snapshot保持。只改既有测试：在释放回执前显式等待第一次未知回执清理flight结束，释放后再等原operation.status()确认为ready，随后第二次cancel仍要求真实原pair failed ACK、pin1、disposals0及原cold guard拒绝；最终confirmed清理和真实新业务准入断言全部保持。生产RPC/模型预算与所有既有assert未放宽。

定向 `bridge-cancel-ordered-target.log` exit0、1/1，5.88秒；typecheck/diff通过。相对原freeze只有此测试一个hash改变，CLI生产SHA256仍 `99D0C0332218C72367BC8878A88A699B7E9AB449919AF4780A390A81AB0CAB51`。原exec62559执行5个完整相关文件，运行时输入保持；其终态通过后才能更新已解释的一个manifest项并启动新的完整门禁。首轮失败日志保留，正式DSH仍第62轮，不以目标1项通过放行。

## 顺序修正后的完整链

原exec62559明确terminal exit0：5个完整相关文件69/69、fail/cancelled/skipped0，107.80秒；包含Bridge/Callback/前台待定回执生命周期、CLI真实stderr错误及原CLI控制。没有只用目标1项通过放行，未增加生产RPC/turn预算。

保留最初281份source-snapshot和原manifest，修正测试另存 `bridge-order-corrected-test.ts`。只有 `test/bridge-start-receipt-lifecycle.test.ts` 的hash变化；新manifest SHA256 `91BD3778DA97033CCA51B6BFB9F25718CC308E9444B08B4FDA2A5FE11AD70B7B`，`bridge-order-correction-freeze-receipt.json`关联原/新输入及69项结果。原门禁和操作脚本另存original副本。

新完整原exec83599，目录 `final-gates-b54952e4-f3c4-4458-8c8f-90aa1452ff77/`，verify、一次release、host、host-recovery、diff均须成功。保持281输入/1329项及独立文件并发1，每阶段前后核对freeze；只在原完整链明确失败、实际顺序探针与纠正控制结算后启动，没有因等待到期重开旧任务。helper均绑定新目录和新manifest，解析0错误、原正式PID/birth探针保持匹配。最终build freeze与正式重载尚未执行。

## 修正后的完整verify结算

原exec83599的verify已明确exit0：1329/1329、失败/取消/跳过均0、异步警告0，1668.27秒。完整 `verify.log` 与 `summary.json` 保留；首轮失败的Bridge取消用例在完整运行通过，原pair/ACK与资源断言保持。同一exec进入release，不重复启动，未以定向1项或相关69项结果替代完整门禁。

281份冻结输入及完整集合保持，生产CLI源不变。release包审计、host加载/恢复和diff终态仍须分别证明；最终build freeze与reload receipt尚未生成。正式DSH仍第62轮，加载前须实时确认无运行/等待工作，原历史记录与ephemeral不可重建边界保持。

## 最终完整验收

原exec83599明确terminal exit0，沿用修正后的同一完整链，没有因观察到期重开：

| 门禁 | 结果 | 总耗时 |
| --- | --- | --- |
| verify | 1329/1329；失败、取消、跳过与异步警告均0 | 1668.27秒 |
| release:check | 1329/1329；失败、取消、跳过与异步警告均0；包审计通过 | 1688.86秒 |
| host:check | exit0，安装宿主加载通过 | 3.94秒 |
| host:recovery:check | exit0，本地受控模型网关和隔离存储的原线程恢复通过 | 6.53秒 |
| diff --check | exit0 | — |

首轮Bridge取消失败在两次完整运行中通过；CLI新增9项隔离用例也在verify/release完整链中通过。离线doctor通过（5项skipped），临时tarball已清理。host恢复使用安装DSH0.1.7-rc.2，结果明确 `browserUIVerified: false`；不泛化为真实provider自然故障、Token计费或浏览器交互证明。

281份发布输入及修正manifest保持。最终217份build冻结SHA256 `AE909E931F6BF0BC7DDFEF1AD9672B48A57B8E51FB74CEEDAE3410ACDC39FDCB`，`build-freeze-receipt.json`关联本轮修正后唯一完整门禁。三个操作helper在完整verify后重新核对新目录/manifest、解析0错误，`post-verify-operation-audit.json`保存。

## 正式加载与数据核对

正式原PID142580/出生标识、插件Junction指向D盘当前仓库、实际running/waiting0再次确认后，执行一次受控重载。原exec49254明确exit0，只启动一个新实例；原进程树捕获的11个实例已确认退出。新PID133572/birth `2026-10-08T15:23:20.0347900+08:00`，原Node/DSH入口及127.0.0.1:3080监听匹配，认证健康HTTP200。

`formal-verification.json`确认217份build和27个关键模块哈希0偏差，413个会话身份和111条workflow完整记录保持，stderr致命匹配0；原parent及历史corrupt child存在，未替换或伪造旧ephemeral线程。workflow完整记录SHA256仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。provider/profile/凭据保持，未commit/push/publish。被自动审批拒绝删除的负向probe目录仍保留，未伪报清理完成；持续优化目标active。
