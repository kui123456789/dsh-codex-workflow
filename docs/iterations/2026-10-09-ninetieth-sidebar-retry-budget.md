# 第90轮候选：侧栏开栏重试限次

状态：完整verify/release各1557/1557、host/11恢复/diff及授权重载通过；formal PID56144认证HTTP200，原11实例树退出和历史全量数据保持。另记录共享lib构建可热更新client的风险，隔离验证副本运行中；目标active。

## 复现到修正

在实际client VM中令openResource/openTab持续抛`seat not mounted`。原一个初始+8次重试之后，20次普通投影通知再次增加调用；15秒迟到timer亦先额外open后放弃。初始8项4失败/4控制，扩展12项后6失败/6控制。

[固定GitHub机制](../research/github-sidebar-retry-exhaustion-patterns-2026-10-09.md)对照p-retry的原操作耗尽终态。候选client新增按目标key的耗尽集合，mayOpen在open之前检查原窗口；耗尽只发一次give-up警告，普通通知不重授额度，新目标和正常成功路径保持；卸载清理原集合。

只改仓库外副本`.codex-workflow-verification/ninetieth-20261009/candidate`，正式profile/服务、workflow/thread及当前314冻结文件没有调整。首次生成CRLF匹配失败，未算有效候选；修正换行后12/12、补齐依赖后相关62/62及候选typecheck通过。相关初次失败源于副本遗漏backend展示模块，原日志保持；未改原展示测试断言。

## 交付边界

候选client及新`test/sidebar-retry-budget.test.ts`的base/candidate SHA256固定到prepared-change-manifest，12项新增、未来完整1553仅为预期值。暂不合入正在验收的主源码。待第89轮gate/delivery真实成功、正式状态核对后再逐项base check合入，并运行新的完整门禁和必要宿主/界面验证。

验证只执行实际源码与受控Host边界，没有真实浏览器动作或模型请求。原重复child目标不可自动再授额度；显式宿主手动开栏不在扫描拦截范围。本次没有改变浏览器wall-clock选择，不宣称所有UI内存或计时问题已解决。

README、CHANGELOG和release checklist三份配套说明已准备在候选副本，documentation manifest固定其base/candidate hash。说明区分一个初始调用、最多8次自动重试、原15秒窗口、不同目标及显式Host侧栏操作；主工作区对应冻结文件未改。第89轮完整交付后再逐项base check合入，避免覆盖后续用户更改。

## 目标切换与父会话隔离

增加四项原生/summary控制，分别切换新目标后返回原目标、切换另一父会话后返回原父会话。最终新增16项，原副本6通过/10失败；候选相关66/66及typecheck通过。耗尽资格属于原parent+target组合，成功打开新key不能授予旧key新额度，另一个parent的同名目标有独立资格。

候选manifest已按最终字节更新，新完整测试预期1557（第89轮1541+16）。前面的12/62与1553保留为早期证据，最终采用以16/66及新manifest为准；当前仍未合入冻结主源码，不把候选验证当完整门禁或真实浏览器验收。

## 主工作区实际合入

第89轮gate/delivery真实exit0、正式PID25056完成认证/历史/代码核对后，再次health HTTP200及只读metadata确认414会话、111完整workflow、119queue全量hash保持、无live/pending/lease。逐项检查candidate/base hash，新测试不存在，先备份原字节后合入5文件；adoption-receipt记录最终sha，没有重置既有用户工作。

主工作区7个相关测试文件66/66，fail/cancelled/skipped/TODO0，pnpm typecheck通过。正式PID25056仍第89轮版本，完整1557计数和宿主检查尚待运行，不将候选或第89轮结果提前放行。

## 原完整门禁与授权加载守卫

315份源码/测试/脚本与发布输入冻结并逐字节保存，source manifest SHA256 `006287FC76D87B9DFC4198DCFFE3890D5CF01A6F3CC684B1A118D790AC94FD9B`。唯一runner33688，birth `2026-10-09T23:04:44.0289090+08:00`/birthKey `win32:134360318840289090`；原gate目录`final-gates-b7519d6a-373b-4a02-a6e4-59531a4ccbdc`，原文件并发1、内部场景/时限保持，预期1557。

observer41852/birthKey `win32:134360318840779940`只等待原gate，成功后审计实际计数/host恢复、冻结最终217build、复查原formal25056出生身份/空闲、重采当前完整会话文件及双查SQL，再捕获和确认原树退出，启动一个后继并做身份/历史/served-client核对。sidebar耗尽/窗口guard加入实际资源字节检查；已有单调default核对保留。

相关helper PowerShell解析通过；实际提前调用reload在缺少完整summary时拒绝，没有final baseline/tree/reload receipt，正式25056仍活。原runner实际进入verify；当前没有最终gate/delivery回执，不能宣称新完整门禁或正式加载完成。

## 原完整verify终态

23:34读取原summary及完整日志：exit0、1557/1557，fail/cancelled/skipped/TODO与异步警告0；实际测试1782.29秒、verify步骤1791.25秒。原1557计数独立取得，没有把第89轮1541与候选16拼成通过。

原PID33688及observer41852出生键仍匹配，release.log实际进入测试；未重开verify。最终gate/delivery和重载回执尚未生成，release/host/host-recovery/diff及正式数据检查仍待结果。315份源码输入保持冻结，正式25056仍运行第89轮验收版本。

## 最终门禁及正式交付

原gate33688于2026-10-10 00:04:52 terminal exit0，delivery41852于00:05:31 terminal exit0、五步全部完成。verify/release各1557/1557，步骤1791.25/1805.32秒，fail/cancelled/skipped/TODO及异步警告0；host3.91秒、host-recovery6.63秒、11场景persistedColdReplay与diff通过，pack/doctor通过（5项offline skipped明确保留），临时tarball清理。

217build manifest SHA256 `D7BA0C8A0266E6D62B905F2940D6AE29B3DC1C97B4CC136603D9999506E82BBA`，315source freeze保持。原formal25056的11个捕获进程实例确认退出，只启动PID56144/birth `2026-10-10T00:05:10.8630850+08:00`/birthKey `win32:134360355108630850`；认证HTTP200、监听/入口/出生一致。

414会话身份、429文件路径/字节/SHA、111完整workflow与119完整queue保持，变化/缺失/新增0，原parent/corrupt child存在。217build与27关键模块hash偏差0，running/waiting/durable pending/active lease/stderr fatal0。00:12再次实际核对同一formal及原SQL全量hash保持。

### 前端资源版本的额外观察

00:00在未重载的旧formal25056读取实际boot/resource，已包含第90轮client，旧client字节不在响应中。这说明之前“正式仍第89轮”只能指后台进程；profile Junction共享canonical lib，HMR会把构建client发布到图，不能把未重启等同于前端仍旧。读取未执行浏览器，实际materialization未观察。

这个风险独立于本轮完整通过；不以最终成功掩盖预门禁可见。已完成[构建隔离研究与prototype](../research/github-verification-build-isolation-patterns-2026-10-10.md)，副本315输入、217编译产物与canonical一致，66 UI/host/11恢复通过且正式217文件内容与HMR相关metadata未变。独立全量verify仍待结果，主验证流程尚未改为隔离。
