# 第72轮：后台验收的TAP环境入口

状态：本轮原verify1448/1448通过，原release1447通过/1取消失败记录保留。TAP入口随后连同第73轮测试取消/清理修复，完整verify/release各1455/1455及host/diff通过；生产build与正式版本一致，保留PID4448，维护者脚本通过原链接生效。持续优化目标active。

## 基线与反馈环

HEAD保持abb6174，保留全部既有dirty。正式PID4448/birth2026-10-09T03:29:22.6331920+08:00，认证只读查询413个会话身份、111条workflow完整记录保持，running/waiting0，原parent及历史corrupt child保留。

第71轮实际发布的隐藏控制台乱码使外围Unicode计数误报；release-check的实际exit判断未受影响。本轮新增共享测试入口环境设置，避免verify/release外层分别修乱码。旧run-tests.mjs已保存为本轮证据目录../.codex-workflow-verification/seventysecond-20261009/run-tests-before.mjs。

初始fixture直接import CLI及继承NODE_TEST_CONTEXT未执行独立runner；两份无效诊断日志保留，不作为有效RED。使用真实CLI子进程并删除仅测试内部的NODE_TEST_CONTEXT后，12项有效初始回归7失败5控制通过。后来过滤断言假定单个匹配用例计数1，实际Node还计空过滤文件；按官方版本差异校正夹具，不修改生产过滤行为，并增加多reporter控制，最终13/13通过，10.29秒。typecheck通过。

## 实现与真实Windows证据

仅scripts/run-tests.mjs增加可选DSH_WORKFLOW_TEST_REPORTER=spec|tap；非法值在启动前exit2，unset/empty保持原默认，显式reporter及destinations优先。原测试文件清单/排序、并发范围、过滤和真实失败退出码不变。

hidden-tap-probe.mjs实际启动隐藏pwsh并设置代码页936，旧/新入口均跑同一个小型真实tsx测试，exit0；旧入口无选择后的TAP汇总，新入口保留六项ASCII计数tests2/pass1/fail0/cancelled0/skipped1/todo0。原日志字节及SHA256、hidden-probe-result.json保存。此探针不代表本项目完整测试或业务模型恢复。

## 外部研究与完整验收边界

[Node/tsx固定源码](../research/github-test-reporter-console-patterns-2026-10-09.md)核对6份字节、Git blob与许可。Context7确认Node22/24 reporter契约和多destination；文本格式版本敏感，TAP入口不冒充永久程序协议。无依赖升级或最低Node版本变化。

预期完整测试1448（原1435+新增13）。完整verify/release启用TAP，核对实际退出码和完成计数；通过前不加载变更。host加载/恢复与diff仍需通过，之后实时核对正式实例、实际空闲状态及新前后数据基线。provider/profile/凭据与历史会话保持；未commit/push/publish。

## 冻结与后台完整门禁

304份代码/测试/脚本及发布输入冻结，保存同数快照；manifest SHA256为`D6062052ED482F6E4976012080128FCAD65CC25E38EBA3EDEEDCE74A25F99E52`。相对第71轮改动README/CHANGELOG及scripts/run-tests.mjs，新增test/test-runner-reporter.test.ts；发布清单及研究/迭代文档在此冻结集合外，插件生产源码保持。

唯一门禁目录final-gates-6b014e82-afda-48da-8e77-6a34bd9dfd9d/，依次verify、release、host、host-recovery和diff，每阶段前后校验原freeze。verify/release各要求1448/1448、失败/取消/跳过和异步警告0。使用DSH_WORKFLOW_TEST_REPORTER=tap、文件并发2，场景内部并发/时限不变；配置UTF-8仅在当前验收进程，未修改系统代码页。

durable-final-gates.ps1由隐藏后台pwsh单次启动，durable-gates-start.json保存PID/ISO出生时间/Windows键，finally写durable-gates-completion.json真实退出码。观察超时按同一PID出生及原日志等待，不依赖可丢失的会话执行句柄。操作helper绑定正式PID4448/birth2026-10-09T03:29:22.6331920+08:00/win32:134359613626331920，只读guard通过、解析0错误、retirement语法通过；完整结果和最终build冻结尚未生成，不放行重载。

## 完整verify结算

后台原PID9792/birth2026-10-09T03:45:58.3425330+08:00/win32:134359623583425330的verify明确exit0：1448/1448，失败/取消/跳过/TODO及异步警告均0，825.98秒。原summary.json由TAP的ASCII汇总直接提取，不需要乱码修复或手工补数字；verify-completion-audit.json重新核对原收据及304份输入hash偏差0。

同一个后台实例继续release，没有因观察等待到期重复测试。文件并发2及原场景时限保持；本轮13项真实launcher回归在完整运行通过，包含原失败退出和多reporter/destination控制。三个操作helper解析0错误、目录绑定正确、正式PID4448的Windows出生键匹配、retirement语法通过，post-verify-operation-audit.json留存。release/pack、host加载/恢复及最终diff仍待结算，不放行重载。

额外TODO审计最初使用LF行尾匹配，Windows CRLF导致未匹配；允许行尾空白后确认原`# todo 0`唯一存在。原门禁的tests/pass/fail/cancelled/skipped解析始终通过，未改写日志、重跑测试或修改冻结输入。

## release中共享Reviewer用例的等待现场

04:17实时核对：后台PID9792及出生键仍匹配。release在03:59开始；bridge-new-review-round-request.test.ts的原worker PID2812/birth04:02:38.930372及其本地fake-turn-interruption-app-server PID17872/birth04:02:39.617806仍活着，该文件声明单用例30秒。TAP日志在04:03:19停于200条顶层通过行，没有失败或完整汇总；另一个worker持续执行后续文件，因此按文件顺序输出的总日志不能用于判断整个runner已停止。

held-release-observation.json及held-release-last-worker.json保存实际原PID/birth、文件名、日志更新时间和仍在执行的另一worker。只读取原隔离目录dsh-shared-reviewer-ownership-qc4Fup的SQLite：workflow revision7、executing/running、submissionState sending，submission lease已释放（owner空、leaseUntil0）。首次直接读取存储envelope漏掉字段，随后改用原parseWorkflowJson正确解码；未修改该库、原输入或进程。

独立shared-reviewer-diagnostic.mts运行同一unavailableSharedReviewer入口，约1秒取得结果，exit0，完成自己原协议进程停止及清理；阶段JSONL保留。初次.ts因证据目录缺少ESM声明而未执行，原错误日志保留，切换.mts后才作为实际结果。此正向对照不能排除原现场的时序问题，也没有证明根因。原fixture及生产代码不变，未重启/终止原门禁，未向正式DSH发送模型请求；后续继续查租约心跳/取消/清理时序。

本轮仅测试入口变更，生产src保持。完整门禁结束后比较217份构建及当前正式版本：若全部相同，直接确认链接的维护者脚本生效，保留原DSH进程，不为文档和测试入口重复重载。当前尚无release完成收据，不能称第72轮已验收或已发布。

## 超时用例的原实例退休与失败结算

04:25核对其他测试文件已全部结束，仅余bridge-new-review-round-request.test.ts的原worker2812及其协议进程。该用例声明30秒，但worker和已释放lease的原submission仍等待超过20分钟。没有将观察超时当成runner已停止：先保留SQLite只读状态、原PID/birth及唯一剩余文件证据，然后明确退休这个遗留诊断scope，让原runner输出实际失败。

retire-held-test.mjs使用原项目captureProcessTreeEvidence及stopCapturedProcessTree，核对原worker2812/birth`win32:134359633589303720`及父runner34500，采集3个完整实例并确认原树退出；held-test-process-tree.json与held-test-retirement.json保存。没有终止后台gate9792或正式DSH4448，没有更改原测试输入、声明时限或正式workflow数据。

原后台PID9792在04:26:12正常结算并保存durable-gates-completion.json：exit1、failureType null。原release命令exit1，TAP完整计数tests1448/pass1447/fail0/cancelled1/skipped0/todo0、异步警告0，1587.03秒。实际第201项为an explicit new business round may review unchanged evidence without masquerading as original continuation，错误明确`test timed out after 30000ms`；后续两个同文件用例和其他文件通过。release-check最终输出RELEASE_CHECK_FAIL（tests），不冒充通过，host/build-freeze/reload未执行。

此结果确认超时及其遗留清理问题，但独立正常重放未复现超时的时序原因；下一步须在隔离反馈环中复现TestContext取消与lease gate/模型清理，再做有回归证据的修复。第72轮TAP入口、13项回归及完整verify证据保留，整轮验收仍未完成，不重复原已结束进程或改写它的失败日志。

## 后续完成证据

[第73轮](2026-10-09-seventythird-shared-reviewer-test-cancellation.md)用受控lease notice等待证明原TestContext取消不能离开helper，修复signal观察、after hook、幂等close及先stop manager的清理顺序。原30秒业务用例及所有断言保持，真实超时actor仍exit1并自然清理，7项新回归及38项相关回归通过。

新唯一后台门禁verify/release各1455/1455、失败/取消/跳过/TODO和异步警告0，host加载/恢复及diff通过，原超时业务用例在两次完整执行正常通过。第72轮13项TAP入口回归纳入两个完整执行；TAP数字汇总直接解析成功，包审计通过。这些新收据不改写本轮原失败日志或宣称原自然通知竞态已定位。

最终217份生产build与正式第71轮逐项一致。正式DSH保留PID4448/birth及原Junction，health HTTP200、413个会话身份及111条workflow完整记录保持，未重载；维护者launcher通过链接仓库直接执行，新入口已验收生效。完整结果与边界以第73轮final-gates及formal-maintenance-verification.json为准。
