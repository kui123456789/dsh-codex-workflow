# 第三十二轮：Planner 成功阶段复用与原运行预算

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。继第三十一轮的启动响应认领修复，继续核查同会话恢复，保留全部既有未提交修改，没有 commit/push/发布。旧源基线 `%TEMP%/dsh-thirtysecond-source-baseline-4ef3f747-0681-49d9-82d0-84ee5ac10c8a` 含依赖 Junction，禁止递归删除。

## 真实缺陷与参考

采用真实 App Server SDK、本地协议、SQLite 和原生 DSH child，未调用正式上游模型。初始预算 probe 实际 initial visible=2 waiting，第一次人工继续又失败时旧实现偷发第4个 visible 并进入 executing。完整可读规划后 conversion 首次失败则 phase=failed、child disposed=1，原线程被释放。

一致旧源的正式矩阵 **4 RED／5 CONTROL**：预算重置、conversion 失败丢结果、completion 成功后 conversion 失败丢结果、实际业务成功但 child 最终仍显示 initial acknowledgement；权限、Schema、混合401/stream、无效JSON、可读JSON泄漏控制通过。另一个独立 completion 模型失败实际 RED，原资源被释放且没有允许的自动继续。日志在 `%TEMP%/dsh-thirtysecond-planner-budget-probe-60d728ed-1319-41cf-8fe0-057e267845fd/`。

参考 [固定上游研究](../research/github-planner-stage-retry-scope-patterns-2026-10-06.md)：LangGraph 缓存成功步骤，官方测试成功 task 仍只执行一次；它人工恢复时重给局部 retry 额度，不能照搬预算。Temporal 普通 resume 保留 Attempt，显式 reset 才清零，达到 maximumAttempts 的 backoff 测试停止重试。两个固定 MIT 来源的源码与测试只读，未执行上游测试或加入框架依赖。

## 实现

- `planner-run-checkpoint.ts` 保存原范围、有效模型/effort、可读结果、转换结果、补全结果和 nextStep；产物仅在原进程内，持久 `retryState.plannerCheckpoint` 只含阶段。初始省略模型是被捕获的选择，不随全局设置改变。
- 原业务最多一次自动继续，覆盖可读规划、转换、补全、澄清和人工恢复。成功步骤不重放，失败私有步骤只发送短 continuation 与输出 Schema，不重复完整任务/计划。
- 成功 response 先验证原线程、有效文本/JSON并缓存，再核 caller signal 与当前范围；最终 CAS 仍核原 scope。完整 converted 后的恢复零模型调用，cancel/stop 不提交旧输出。
- controlled completion 连接原 child 多回合与 progress，最终收尾显示真实完整计划。Schema/显示/权限终止控制保留，原可读文本不能自行授权 executing。
- 原 writer 未确认中断必须精确 ACK；运行态线程或 checkpoint 丢失不新建替代者。澄清新答案清旧 artifact，保留原设置与预算，不重复已提交 native RPC。

## 实现中暴露的窗口与验证

首个新目标 22 场景全部在首次发送前被初始化 scope 拒绝。真实 save/load 比对定位 `reviewContractFailures` 原省略而 SQLite 默认0，已按原语义规范化 mode/cycles/contract 默认值。一个旧组合因此在等待门闩前停住；精确验证其自有 pwsh PID77544与8个后代后停止该无效诊断树，正式 DSH PID75648未触碰。记录 `%TEMP%/dsh-thirtysecond-invalid-diagnostic-stop.json`；没有将中止组合当作通过证明。

独立 SDK receipt probe 又实证：转换实际成功后 callerabort 重复转换1→2，补全实际成功后 callerabort 重复 visible2→3。修复缓存时机后两控制分别保持1/1和2/2，原thread/child仍各1、dispose1；日志 `%TEMP%/dsh-thirtysecond-post-receipt-abort-verified.log`。

新正式回归原 **23/23**，新增 receipt **2/2** 单独通过，不称25一次全跑。旧相关组合实际 **120/123**，三个 legacy fixture仍保留新checkpoint却删除settings，属于新范围漂移。已忠实构造无新marker/无cached checkpoint的原legacy handle，三个fallback控制通过；另增新checkpoint settings删除必须拒绝、原row/handle不变控制，相关 **4/4**。类型已通过，最终门禁与正式重载将在执行后追加。

进一步 receipt 检查实证初始可读成功后 callerabort 重放 visible1→2；加入同步非空/非JSON显示校验缓存后保持visible1，仅转换一次。原生澄清请求收到后 callerabort 又丢 pending/input，向远端仍活请求发两个新turn导致writerConflicts=2。修复通过原scope/cancel/stop CAS保留真实输入等待，resume拒绝零新turn，continue回答原request一次；已提交native答案成功后只转换、不重答。新增四个实际 SDK/native/SQL 控制 **4/4**，包括 cancel/stop 与迟到input receipt竞争，日志同probe目录 `native-receipt-green-attempt-1.log`。

等待已持久解析模型A后删除该字段，旧checkpoint容许初始化省略值undefined，真实probe仍恢复并改写row。已让waiting/waiting_input严格要求保存设置，拒绝状态为identity_changed、visible仍2、完整row不变，日志 `%TEMP%/dsh-thirtysecond-resolved-settings-deletion-verified.log`。

原 `workflow.test.ts` fake无视sourceEphemeral，在Planner转换虚造fork线程；真实SDK是在原线程。修正fake遵守该参数，并让teardown精确检查原Reviewer上的转换pair，原核心 **14/14** 通过；未为fake放宽生产原线程检查。

上述目标验证期间，正式 DSH 保持第三十一轮 PID75648、411 会话；最终重载结果见下节。实际正式模型断流与费用未注入/测量。

## 首个完整门禁与最后兼容修正

首个完整 `pnpm verify` 实际1009项：996通过、13失败、取消/跳过/异步警告均0，267.16s。结果 `%TEMP%/dsh-thirtysecond-final-gates-14b0f81f-ab20-4433-8c74-fb4ea9043d75/summary.json`，其后发布/宿主/重载没有运行。三项是等待设置严格校验误拒真正legacy无checkpoint/无marker句柄；十项是在review-authority夹具先执行Planner时仍虚构fork身份，与sourceEphemeral真实SDK不符。

legacy仅在原无checkpoint/无marker路径有临时默认设置待提交状态，成功领取或停车CAS持久后清除；新等待状态的解析模型删除仍拒绝。精准5/5通过，日志 `%TEMP%/dsh-thirtysecond-legacy-settings-surgical-green.log`。AuthorityGateway按sourceEphemeral返回原线程，原权限层级、冲突、真实范围变化与不可丢finding断言全部保留；原套件29/29，日志 `%TEMP%/dsh-thirtysecond-authority-fake-identity-verified.log`。最终完整门禁另行执行，不将此前失败全套称为通过。

## 最终完整门禁与正式重载

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1009/1009，267.17s，异步警告0 |
| `pnpm release:check` 第一次 | 1009/1009，266.63s，doctor/pack通过，异步警告0 |
| `pnpm release:check` 第二次 | 1009/1009，279.96s，doctor/pack通过，异步警告0 |
| `pnpm host:check` | 退出0，4.11s |
| `pnpm host:recovery:check` | 退出0，9.90s |
| `git diff --check` | 退出0 |

所有完整运行失败/取消/跳过均0。新增31个协议场景与1个新设置漂移控制进入最终全套；没有以23+2的目标合计替代完整证明。结果 `%TEMP%/dsh-thirtysecond-final-gates-1b264ff4-3da4-4075-a0cc-0a52da264f97/summary.json`。两次pack临时tarball已清，仓库松散tgz=0；offline doctor有5项明确跳过，未声称provider登录或实际模型验证。

即时确认原PID75648的可执行文件、DSH命令、3080监听及认证metadata：411会话、runningIds=[]、waitingWorkflowCount=0，才停止该精确进程树并以相同参数重载。实际新PID **58576**，`127.0.0.1:3080`监听归该进程，认证HTTP **200**。receipt `%TEMP%/dsh-thirtysecond-reload-receipt.json`包含三个主构建与十一个相关模块SHA256，重载后逐模块核对一致；没有改provider、登录配置、profile或历史corrupt child。

重载后仍411会话，指定原parent `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` 精确metadata存在，没有读取聊天内容。浏览器复用原handle并加载新私有认证，标题 **DeepSeek Harness**，warnings=0；唯一error是已有wallpaper-engine背景音频404，未改该插件。服务器stderr仅SQLite experimental warning。源码零空文件，全部既有修改与诊断快照保留。

本轮研究、代码、回归、文档与正式构建已更新；持续优化目标保持active，没有commit、push或发布。真实正式模型故障/费用没有注入或测量。
