# 第三十三轮：终止错误也必须确认原回合清理

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。上一轮正式 PID58576、411 会话，认证 HTTP200 且运行/等待 workflow 为0。保留既有全部修改，没有 commit/push/发布或修改 provider/登录配置。

## 真实缺陷与固定上游

真实 SDK、原生 DSH child、SQLite、本地协议进程重复 **2/2 RED**：Planner 私有 conversion 意外 native question，零 interrupt，却 failed/dispose/unsubscribe/endRound，原 writer 仍活；公开再次 start 创建第二个 Planner。另实证 Planner/Reviewer onStarted 注册拒绝且 ACKfailed 时同样释放原资源，显式新审查轮次绕过未知旧 writer。原有 confirmed controls 与合法可见原生提问正常。

SDK新增回归最初 **10 RED／5 CONTROL**，范围包含 Planner/Reviewer 注册、settings、ephemeral/durable conversion、silent review、visible review 的非法 input。结果在 `%TEMP%/dsh-thirtythird-planner-terminal-probe-1acc30db-5732-4169-a2c4-0ddae3558841/` 与 `dsh-thirtythird-terminal-audit-c10e39d5-7829-4682-94d9-656583292d11/`；所有诊断进程最终 ESRCH 已确认，没有调用正式模型。

参考 [固定源码研究](../research/github-terminal-cleanup-confirmation-patterns-2026-10-06.md)：RxJS from(Promise) unsubscribe 只阻止投递；Node destroyed 提前置位且当前 iterator return 不等 close，asyncDispose 另外等待 eos；CPython TaskGroup 等原任务并保留 body/finally 两类错误。源码/许可/测试固定到具体提交，未运行上游测试或增加框架依赖。第三十二轮已验收的 compiled `lib/` 保全至 `%TEMP%/dsh-thirtythird-built-baseline-0aa21dd7-e1f0-4f07-82ab-476ee952c826/src`，依赖 Junction 已标禁止递归删除；Reviewer/Bridge旧32矩阵 **4/4 RED**。

## 最小采用与边界

- SDK `CodexTurnInterruptionError` 新可选 cleanupOnly，原 timeout/abort 默认语义不变。拒绝注册或不支持的 private/native input 后，先确认原 pair；ACKfailed 保原 cause、PID tree、订阅与 turn 状态。正常 Planner native clarification仍可回答。终态 notification 清旧 input，但保 completed receipt 供幂等确认。
- Planner、前台 Reviewer、后台 Dispatcher 保终止错误的原资源，等待时只允许 cleanup；确认后仍返回原 primary error，不执行 startTurn/normalize/新 Reviewer。只清理原 writer；child/订阅/pin 仅释放一次，child cleanup错误另作诊断。
- 独立 SQLite guard 只持久 workflow/session/PID tree，不保存 ephemeral pair或模型产物。取消、owner/task变化、workflow marker缺失、lease_until过期均不能证明原 writer结束；精确 ACK或所有已捕获 PID 的 ESRCH才确认。确认凭证独立保存，旧 owner不能写后继工作流。
- cancel/stop 未确认时保资源。整个插件先停止 manager，再停止 SDK，之后复查同一批保留清理能力，最后关闭 store；单一 Manager不强停共享 SDK。后台 consumer在未确认时不被退役，恢复仅清理原 Reviewer而不重审。
- 返回的 conversion失败保留 SDK原 error envelope（含permission/Schema原因），非空失败输出不走 generic recovery。原生输入不假造答案。

## 实现中捕捉的问题与目标验证

新增 SDK **16/16**，含原49场景的冻结组合 **65/65**。Planner **9/9**、Reviewer/Bridge **7/7**，合并 **16/16**；原普通 callback 对照 **26/26**。两个真正完成的非空失败 conversion 保原permission/Schema envelope **2/2**，不额外 interrupt或模型请求。

持久 guard四场景真 SDK/native/SQLite两次复验 **4/4**，固化 `terminal-cleanup-guard.test.ts`：expiredTTL取消/owner变化后 cold start仍零进程，后继 SQL完整行不变；原进程实际 exit后重复stop仅一次释放；并发resume/cancel共享held清理flight。owner变化控制还实际调用原owner resume：只清原资源并拒读取后继业务结果，原row不变。正式目标 **4/4**。

原恢复组合捕捉首次 review-only admission 在 store.init 前读新 guard造成 unable to open database；一个门闩场景因此停住。确认只属于诊断 pwsh60380的完整后代树并停止，正式58576未触碰；记录 `%TEMP%/dsh-thirtythird-invalid-diagnostic-stop.json`，不把这次中止当通过。补原存储初始化顺序后，旧恢复、澄清、stage缓存、callback、stop/status及新guard组合 **146/146**，日志 `%TEMP%/dsh-thirtythird-original-domain-fixed-init.log`。Typecheck/diff已通过。

最终完整门禁、发布/宿主与正式重载结果将在真实执行后追加。本轮持续优化目标仍 active；本地协议计数不冒称正式 provider故障/真实费用验证。

## 最终门禁与正式重载

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1047/1047，210.52s，异步警告0 |
| `pnpm release:check` 第一次 | 1047/1047，221.43s，doctor/pack通过，异步警告0 |
| `pnpm release:check` 第二次 | 1047/1047，317.29s，doctor/pack通过，异步警告0 |
| `pnpm host:check` | 退出0，3.67s |
| `pnpm host:recovery:check` | 退出0，7.80s |
| `git diff --check` | 退出0 |

新增38场景全部进入完整1047：SDK16、Planner11（含两个具体返回诊断）、Reviewer/Bridge7、独立SQLguard4。所有全套失败/取消/跳过均0，未以65/65或146/146局部组合冒称全套证明。结果 `%TEMP%/dsh-thirtythird-final-gates-764ac3ca-c96d-4c01-bc86-3670ae7c9945/summary.json`；两次临时tgz已清，仓库松散包0，offline doctor有5个明确跳过项，非provider登录证明。

即时核验原PID58576的可执行文件、DSH命令、3080监听以及411会话、runningIds=[]、waitingWorkflowCount=0后，才停止其精确进程树并按同参数重载。实际新PID **31516**，`127.0.0.1:3080`由该进程监听，认证HTTP **200**；receipt `%TEMP%/dsh-thirtythird-reload-receipt.json`包含三个主构建与15个相关模块SHA256，重载后逐模块复核一致。

原parent `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55`精确metadata存在，重载后仍411会话，没有读取其聊天。旧Playwright handle权威报missing后按同名新开、载新私有认证，标题 **DeepSeek Harness**，warnings=0；唯一error为旧wallpaper-engine音频404，未改插件。页面加载后availableCount=1，runningIds=[]、waitingWorkflowCount=0；服务器stderr仅SQLite experimental warning。源码无空文件，原资料、配置和所有既有dirty修改保留。

本轮研究、实现、回归、文档与正式构建已更新。持续优化目标保持active，没有commit、push或发布；正式模型故障和费用未注入/测量。
