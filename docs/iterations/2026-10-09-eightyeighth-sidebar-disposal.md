# 第88轮：侧栏扫描退役与订阅释放

状态：完整verify/release各1504/1504、host/11恢复/diff及授权正式恢复通过。formal PID51892实际认证HTTP200，历史文件/身份及完整workflow/queue保持。此前未完成/失败结果仍保留，异常原因未确认；持续优化目标active。

## 现场与采用

上一轮查询安装宿主确认 projection face 的 subscribe 为闭包，排除了接收对象丢失猜测。本轮进入生命周期边界，复现同一通知内插件先卸载、已捕获 scan 后执行：旧客户端第二次开栏；挂载通知还订阅了下一个会话。切换时原投影 disposer 被调用两次。

[GitHub 研究](../research/github-sidebar-disposal-patterns-2026-10-09.md)比较 VS Code、DSH 与 Cline；采用先标记退役再释放及延迟回调检查，在现有浏览器插件实现。参考的9份实际源码/许可经过 Git blob 和 SHA256 核对，未引入新的执行框架。

## 修正与回归

`src/client.js` 的 apply 保存退役标记；scan、face/open 重试接纳在退役后返回。dispose 先设置标记，再释放定时器、原 projection observer 和注册；重复 dispose 不再次释放。切换和换 face 使用同一个取出/清空原句柄的释放入口。

新 `test/sidebar-disposal.test.ts` 初始6项5失败/1正常控制。注册数量期望初次误写5，按实际4个注册修正，原日志保留；新增两个正常定时重试控制后8项通过。最后相关50项、typecheck和安装宿主实际通知器的隔离RED/GREEN结果均通过。

原 client 的字节副本与测试日志保存在仓库外 `.codex-workflow-verification/eightyeighth-20261009`。实际 notifier probe 在旧客户端产生二次开栏及后继会话监听器，修正后均阻止；没有 Agent、模型网关或正式 UI 卸载。timer 控制是退役回调边界，不将其解释成浏览器定时器取消故障。

## 交付边界

正式 DSH 暂仍 PID3436/birth `2026-10-09T12:29:01.1571740+08:00`。上轮1496项门禁不覆盖本次8项新增测试；本轮完整测试预期1504，必须取得新的verify、release、host、host-recovery与diff结果后，按已授权的空闲守卫受控重载。

保留历史 parent/corrupt child、workflow、queue 与所有本地未提交工作。未 commit/push/publish；未证明真实 provider 故障、Token费用或正式浏览器完整 AgentLoop 组合。

## 原完整门禁与加载守卫

313份源码/测试/脚本与发布输入逐字节保存并冻结，manifest SHA256 `F40D99D4D6FDD0EC673F431F10A51FC64AB5FC8887B741D060F0143BF10DFCA8`。唯一门禁runner PID42476，birth `2026-10-09T12:48:12.9554380+08:00`、birthKey `win32:134359948929554380`；原gate目录 `final-gates-c658b737-989e-44cc-bf73-12618955166a`。顺序执行verify/release/host/host-recovery/diff，测试预期1504（1496+8）。已确认原实例存活，verify实际进入测试；尚无完成回执，不重开原runner。

5份加载/审计脚本绑定本轮313/217/1504、原formal PID3436及出生身份，PowerShell解析错误0。实际提前运行受控reload守卫时，缺失完整summary使它在任何baseline/tree/reload回执写入之前拒绝，原formal仍活。守卫准备不算已加载；必须等原门禁终态，再捕获当时的真实会话文件和空闲状态。

当前正式只读状态：414个会话、111条完整workflow、119条queue，原parent/corrupt child仍存在；workflow/queue哈希与上轮一致，running/waiting/durable pending/active lease为0。此准备采样不替代最终停止时的基线。

## Windows重启后的实际观察与继续

15:29再次查询时，原PID42476及正式PID3436均缺席，3080没有listener。Win32_OperatingSystem报告本次boot为`2026-10-09T15:23:04.5000000+08:00`；原verify日志最后写入13:02:56，停在1194项附近，没有最终计数、summary或完成回执。没有失败subtest/异步警告并不能证明通过，也没有证据解释重启前日志停止的原因。

原证据目录不改写，单独保存reboot-interruption-audit。确认没有残留测试进程、313输入哈希保持后，15:31启动新attempt，PID33780/birth `2026-10-09T15:31:59.4409261+08:00`、birthKey `win32:134360047194409260`；gate目录`final-gates-after-reboot-486dbefd-788c-4a65-a621-c03fdc27e8c2`。独立文件并发4，场景内部并发、原配置、期限和断言保持；没有将旧未完成计数接续伪装为同一次通过。

只读offline-state核对111条workflow与119条queue的完整原哈希保持，durable pending及有效lease为0。新的恢复helper先要求这次gate终态成功及313/217冻结证据，再复查post-original boot、DSH实例/3080缺席和原Junction，临启动前重新捕获当前session文件并双查原数据库，随后只启动一个新实例。

该helper仅在仓库外准备；PowerShell解析通过，缺失完成回执的实际提前调用已在启动前拒绝，没有写final baseline或reload receipt。恢复后将核对实际进程出生身份、认证HTTP、当前完整session文件、原session identities和workflow/queue记录。没有预先采集原3436进程树，重启后不伪造该树的独立退出证据；ephemeral上下文已失去，历史corrupt child不被修复或替换。

### 新attempt中的既有诊断测试失败

该verify实际出现 `not ok 79`：`test/app-server-stderr-origin.test.ts` 的真实retired OS-pipe控制在读取其独立 `states.jsonl` 时ENOENT。错误发生在 fixture 读取阶段，原退出码检查写在读取之后，现有日志不足以确定actor启动/退出的确切原因；之后查看该临时目录也已不存在。没有证据归因于侧栏修正或重启，暂不更改生产SDK与测试断言。

保持同一完整runner运行，独立重放原用例：`pnpm exec tsx --test --test-name-pattern='real retired OS-pipe bytes' test/app-server-stderr-origin.test.ts`，1/1通过，两个模式均实际读取65536字节旧管道、后继公开错误不包含旧marker。该结果只排查当前风险，不将它覆盖原完整失败或代替完整门禁；新完整结果仍需真实结算。

重启后当前429份session文件与第87轮基线逐项路径/字节/SHA256一致，新增/缺失/变化0。恢复时仍须重新捕获即时基线，此观察不提前授权跳过门禁。

### 并发4完整终态与独立并发2门禁

原PID33780于15:43:10实际结算exit1，verify1503/1504，fail1、cancelled/skipped/TODO和异步警告0。唯一失败仍为真实stderr测试的ENOENT，未运行release/host/host-recovery/diff，未写入build freeze或正式启动回执。不把1项独立重放通过计入该完整失败结果。

确认该原PID和测试子进程均不存在后，以仓库已有的独立文件并发2启动新完整链，原场景内部并发、模型/系统时限、断言及313份冻结输入保持。新attempt目录`attempt-stable-concurrency`、gate目录`final-gates-stable-0bc80c44-62de-4813-aec8-4ba4bd3c1c8d`，独立保存启动/完成回执及所有日志。降低文件并发是门禁运行配置，不声称已证明ENOENT根因或修复生产SDK；后续验收必须取得新的真实完整计数。

并发2唯一runner PID10760，birth `2026-10-09T15:44:48.1818179+08:00`、birthKey `win32:134360054881818170`，原313输入及manifest保持。按实际进程出生身份检查确认verify已进入测试，尚无终态。

另启动仓库外一次性交付observer PID36112/birthKey `win32:134360055666687410`，绑定原gate PID10760及出生键，20秒查询同一实例；不会因观察超时或缺少回执重开gate。只有该原gate完成exit0，且独立计数/host恢复审计、最终build freeze均成功后，才进入已授权的offline恢复守卫，启动一个DSH并核对实际身份/完整历史及服务client。失败记入delivery-completion而停止；不新建模型会话，不以旧未完成或1503结果放行。

observer脚本解析通过，原runner/observer实际存在；启动时final baseline/reload receipt均未写。该安排使授权收尾在原后台链中顺序执行，最终结果仍须读取实际delivery回执和正式状态才能宣称完成。

## 并发2完整verify终态

16:01读取原gate的summary及verify完整日志：exit0，1504/1504，fail/cancelled/skipped/TODO与异步警告0；实际测试966.27秒、verify整个步骤974.39秒。未将并发4的1503结果修写成通过，也未据此推定原ENOENT根因。

原PID10760及出生键仍匹配，继续release并实际产生release.log；observer36112仍活、最终gate/delivery回执与formal启动回执尚未生成。release、host、host-recovery/diff和正式恢复仍需各自实际结果；verify通过不等于已经放行。

等待期间另完成[单调重试预算候选研究](../research/github-monotonic-retry-budget-patterns-2026-10-09.md)：默认墙钟回拨可多接纳一次已超预算请求，前跳可过早停止。仓库外原模块实际字节与单点候选在9场景/18项受控结果中分别核对；取消控制先修正VM Error realm差异。没有变更本轮冻结源码、正式系统时钟或模型调用，三个实际重试入口的生产实现待本轮完整交付后继续。

## 并发2 release失败与并发1独立链

19:44再次读取原回执：gate10760已于16:18:24 terminal exit1，delivery36112于16:18:28 terminal exit1。verify1504/1504，但release1503/1504、fail1、cancelled/skipped/TODO与异步警告0，release步骤1040.87秒；失败为`start-receipt-input-handoff.test.ts`的原ACK继续场景，SDK报告原进程树清理未确认。包/doctor输出不改变release总失败，后续host/host-recovery/diff未执行，observer没有启动DSH。

独立重放同一用例1/1通过（6.76秒），没有复现未知清理异常。原日志指出`%TEMP%/dsh-start-receipt-input-handoff-xxBogF`，之后查看该目录已无states/wire；此前stderr控制的临时材料亦缺失。证据不足以判断是系统查询、清理时序或外部临时目录变化，不以重放成功声称根因已修复，不改原系统退出判断/时限。

确认原gate/observer及测试进程均缺席后，19:47以仓库支持的独立文件并发1启动新完整链：PID31020/birth `2026-10-09T19:47:28.1356276+08:00`/birthKey `win32:134360200481356270`，observer14668/birthKey `win32:134360200481773140`。attempt `attempt-single-concurrency`，gate `final-gates-single-ff55e2e9-daea-44df-a27c-8e1d44f87d7b`。313冻结输入、所有场景内部并发/断言与时限保持；完整verify/release/host/host-recovery/diff及真实正式恢复仍需各自终态。

等待中补齐仓库外单调预算实际模块检查24/24，覆盖Planner/Reviewer/CLI同目标与取消原因。首次探针误用CLI私有方法名，修正夹具后取得有效结果；未合入正在验收的源码。

## 并发1完整verify终态

20:23读取原gate的summary及完整verify日志：1504/1504、exit0，fail/cancelled/skipped/TODO与异步警告0；实际测试1994.06秒，整个verify步骤2004.64秒。此前失败的stderr控制与原ACK继续用例本次均通过，不据此证明它们之前的异常原因已经修复。

原runner31020及observer14668出生键仍匹配，release实际进入测试，没有重开verify。最终gate/delivery回执、build freeze及formal启动回执尚未生成；仍须通过release/host/host-recovery/diff和实际正式状态/历史检查。第89轮候选的3源码、36项测试及三份文档已在独立副本准备，313份当前冻结输入保持，未提前合入。

## 最终门禁与实际正式恢复

中断后21:53读取原完成回执：gate31020于20:54:59 terminal exit0，delivery14668于20:55:51 terminal exit0。verify/release各1504/1504，步骤2004.64/2032.71秒；fail/cancelled/skipped/TODO与异步警告0。host4.29秒、host-recovery7.17秒及11个persistedColdReplay场景、diff均通过；offline doctor有5项明确skipped，pack通过且tarball清理。

217份最终build manifest SHA256 `10B44E5D3C0B80F0943941B963B77C13234FCB1BC35F51505043182BC377BC3F`，313源码冻结保持。observer核对原链、重新捕获429份文件当前基线及双次原数据库后启动一次formal PID51892，birth `2026-10-09T20:55:21.9466610+08:00`/birthKey `win32:134360241219466610`。

恢复审计确认认证HTTP200、实际监听/入口/出生身份，414会话身份、111完整workflow、119完整queue及429文件路径/字节/hash保持，新增/缺失/变化0。原parent/corrupt child存在；217build及全部217启动hash偏差0，running/waiting/durable pending/active lease和stderr fatal0。原3436随已观察Windows reboot结束，没有提前采集旧进程树，不宣称独立原树退出证据。

实际服务client包含sidebar退役与冷投影guard，SHA256 `6e04ef980b6b02f6a41136e66370e94d0460c866537e224acdf52d6593c6cfc4`，包装响应SHA256 `6975343955fdba0597f12333c43d43572c6385179b1009c2ef662b1a01ecaec4`。没有模型请求，实际资源检查不替代正式浏览器完整AgentLoop验收。21:53再次实际核对同一个formal仍HTTP200，记录hash和身份保持；随后第89轮才按base hash合入候选，不能将本轮1504项作为其1541预期放行。
