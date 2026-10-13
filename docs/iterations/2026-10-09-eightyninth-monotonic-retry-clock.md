# 第89轮候选：单调重试预算

状态：完整verify/release各1541/1541、host/11恢复/diff及正式重载全部通过，formal PID25056认证HTTP200。原进程树退出、历史文件/身份和workflow/queue全量hash保持，单调预算已正式加载。持续优化目标active。

## 采用依据

[p-retry/Node研究](../research/github-monotonic-retry-budget-patterns-2026-10-09.md)确认墙钟校正会破坏进程内重试预算：实际已超过deadline而墙钟回拨时多发请求，墙钟前跳又会提前停止预算内操作。固定源码、许可、Git blob/SHA256、Context7传输失败和实际网络读取路径分别记录。

候选在现有transient-retry模块提供`retryClockNow()`，以`performance.now()`保留receiver并返回本进程elapsed milliseconds；共享控制、WorkflowManager和CLI三个默认计时入口复用它。显式now/sleep/random注入保持，持久时间戳、lease、submissionRetryAt与独立自动continuation权限没有调整。

原GitHub研究的4份Temp源码/许可后来已不可读。已按同一固定提交通过agent-reach的GitHub CLI重新获取，保存到本轮仓库外`source-evidence`；4份Git blob全部核对一致，新的manifest记录实际字节和SHA256。没有用旧读取回执冒称临时文件仍存在，没有改代理/provider配置。

## 候选与验证

独立副本位于仓库外`.codex-workflow-verification/eightyninth-20261009/candidate`；包含原src的字节副本和3份候选修改，node_modules Junction仅复用开发依赖，没有调整正式profile Junction。

新增候选`test/retry-monotonic-clock.test.ts`共36项：四个入口（控制、规划、审查、CLI）分别检查回拨到达/超过deadline、前跳仍在预算内、正常重试、取消优先、零预算失败/成功、显式时钟覆盖和连续回拨。原同组测试20通过/16失败，候选36/36通过，cancelled/skipped/TODO0；候选独立typecheck通过。

测试执行现有实际重试循环，替换模型执行边界，断言只访问原thread、保留最后真实outcome/错误对象且没有thread/start。Mock Date/performance在finally恢复；只清理经scope检查的测试临时目录。生产SDK的系统进程清理规则没有参与本次修改。

真实本地CLI控制通过：原代码因时钟回拨启动2个Node子进程，第二个额外请求给出终端错误；候选只启动1个，保留原503暂时失败。两版均使用同一个Reviewer resume目标，所有实际child已退出。它是本地替代upstream，并非真实Codex CLI/provider或Token计费证明。

## 合入与交付守卫

`prepared-change-manifest.json`固定3份候选源码、1份测试的原始/候选SHA256；新增公开流程回归后预期未来完整计数1541（第88轮1504+37）。这个数字是计划值，只有实际全量计数才是验收结果。

第88轮原源码仍冻结为313输入；本轮不重建其lib或改变正在执行的gate。先读取第88轮实际gate/delivery回执和正式状态，再逐项确认候选base hash后合入，随后新增README/CHANGELOG及维护者检查，运行新的独立完整门禁。本候选结果不能提前放行第88轮，也不能宣称主工作区已修复。

README、CHANGELOG及release checklist三份配套说明现已准备在候选副本，`prepared-documentation-manifest.json`记录base/candidate哈希；原工作区对应文件未改。说明限定为每个进程内重试操作的elapsed预算及原请求/取消边界，README及清单指向36项候选回归，CHANGELOG描述行为。初次文档审计误要求CHANGELOG也含测试文件名，纠正审计范围后核对三份实际字节并更新hash；没有改产品代码。合入时同样需重查base，避免覆盖用户或其他迭代的更新。

## 公开Planner流程与预算独立性

新增第37项回归从真实`WorkflowManager.start/status/resume/cancel`执行：两次503失败在默认单调预算耗尽后进入waiting，同一thread/child保留；手动resume只提交一次短指令，不重置此前已用的一次自动continuation；最后cancel只释放原child/round一次。候选37/37与typecheck通过。

初次在原副本运行公开负向探针时，重复回拨使默认墙钟预算持续有效，形成连续重试。只按已核对出生身份停止该3个Node测试进程，未触碰正式门禁/会话；原终止回执不冒充正常RED。随后在同组夹具加上最多3次模型调用的失败边界，原副本在超额第四调用确定失败exit1，候选仍按initial+自动continuation+manual共3次完成，原线程/子会话不变。生产重试次数和清理规则未因探针更改。

## 实际合入与定向检查

21:53确认第88轮gate/delivery均真实exit0，formal51892出生键/监听及认证HTTP200保持，414会话、111完整workflow、119queue无变化、无live/pending工作。逐项验证3源码和3文档base hash、新测试不存在及候选sha后，先保存原字节再合入7文件，`adoption-receipt.json`记录最终sha；既有未提交工作未重置。

主工作区`retry-monotonic-clock`、`retry-wakeup-budget`和`retry-delay-ceiling`三个文件46/46通过，fail/cancelled/skipped/TODO0；`pnpm typecheck`通过。当前只是定向结果，完整1541预期门禁、host恢复和授权正式加载仍待完成。本轮default elapsed时钟变化不改变系统退出证明，也未宣称此前测试清理异常已修复。

## 新完整门禁与一次性交付

314份源码/测试/脚本与发布输入逐字节保存并冻结，source manifest SHA256 `CEB1456BF5EC7BB97335CD5AB56890A70163FF5C4552C8CF0F78A28ADFFA8BEA`。原gate目录`final-gates-04743099-0505-41a0-9106-a22239aa3fb2`，独立文件并发1、内部场景和原时限保持，预期1541项。

21:56唯一runner PID25348，birth `2026-10-09T21:56:48.7758785+08:00`/birthKey `win32:134360278087758780`；observer44648/birthKey `win32:134360278088348960`只观察该原实例，完成回执及全量计数通过后才审计/冻结build/受控重载。12份仓库外helper绑定本轮输入、计数及原formal51892/birthKey `win32:134360241219466610`；相关PowerShell解析错误0。

实际提前调用controlled reload因缺少完整summary在任何停止/基线/新实例之前拒绝；final baseline、old tree和reload receipt均未写，原formal仍活。reload的停止前空闲、当前429等文件基线和双次完整数据库检查仍须运行时重做，21:53只读采样不替代它们。

实际runner及observer出生身份已核对，verify已进入测试。服务资源审计除sidebar guard外增加3个编译模块的共享单调default检查。未取得完整gate/delivery回执前不宣称已验收或正式加载。

## 原完整verify终态

22:29读取原summary及完整verify最终计数：exit0、1541/1541，fail/cancelled/skipped/TODO与异步警告0。实际测试1920.01秒、verify整个步骤1929.62秒；不是把第88轮1504结果与候选回归拼成通过。

原PID25348及observer44648出生键仍匹配，release.log已产生，原链继续release。最终gate/delivery回执和正式重载回执仍未生成，host/host-recovery/diff与完整发布检查尚待终态；verify单独通过不意味着正式放行。第90轮候选只在仓库外准备，314冻结输入保持。

## 最终门禁与正式交付

原gate25348于22:59:50结束exit0：verify/release各1541/1541，步骤1929.62/1838.82秒，fail/cancelled/skipped/TODO与异步警告0。host4.09秒、host-recovery6.70秒，11个场景persistedColdReplay及diff通过。offline doctor的5项skipped明确保留，pack通过且临时tarball清理。

217份build manifest SHA256 `5F24C8DEAA4D606047001A6E75DA0D9969E3992AC1E1C3D77EDBE6D201075A8D`，314source freeze保持。observer在停止前重新捕获当前429文件、双查真实空闲/SQL全量记录，原formal51892的11个捕获实例全部退出；只启动一次PID25056，birth `2026-10-09T23:00:05.8989130+08:00`/birthKey `win32:134360316058989130`。

delivery44648于23:00:43 terminal exit0，五步审计全部完成。实际认证HTTP200、监听/入口/出生身份匹配，414会话身份、429文件路径/字节/hash、111完整workflow与119完整queue保持，新增/缺失/变化0；原parent/corrupt child仍存在。217build及27关键模块hash偏差0，running/waiting/durable pending/active lease/stderr fatal0。

实际boot/served client及3个编译重试入口核对通过，默认函数使用共享retryClockNow并保留performance receiver；clientSHA `6e04ef980b6b02f6a41136e66370e94d0460c866537e224acdf52d6593c6cfc4`，服务包装SHA `f695c1411573f3925b145c95a1c6e1687c91271796c8973b8d54676dbe56244d`。此次资源核对未请求模型，不宣称真实provider故障/Token费用或完整浏览器AgentLoop验收。23:01再次核对同一新实例与正式metadata保持，再按hash进入第90轮合入；本轮1541结果不覆盖新的1557预期改动。
