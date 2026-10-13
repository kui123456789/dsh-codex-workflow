# 第44轮：转换 fork 创建回执的归属

状态：本轮修复、完整门禁和正式重载已完成；正式DSH PID90876。profile、凭据、历史会话与canonical工作流保持。总体持续优化目标保持active，无commit/push/publish授权。下文保留阶段性失败与收尾记录，最终结果见末节。

## 实际问题与RED

`normalizeInFork`在进入资源finally前await普通`thread/fork`。普通RPC取消/超时删除pending后，原远端已创建fork但迟到reply丢失，下一转换创建第二fork，原subscription不释放。

真实SDK/stdIO探针`%TEMP%/dsh-late-fork-receipt-087a58d689164f8aba310d480d1d5408`先验证健康fork1/model1/release1；abort/timeout原RPC3创建fork1但未运行model，晚reply后原fork仍loaded，重试RPC7创建fork2，只在fork2运行model并释放它。证明重复创建与订阅泄漏，不声称已测两次模型生成或Token费用。

新回归首次2G/5R，原RED目录`dsh-fork-creation-receipt-tBQ6nX`、`VR6e4Q`、`dWuZob`、`GqIf3G`、`4ADvjf`均保留于TEMP。同行新增cleanup失败与提交前同步取消两项，首次0/2，证据`aBSDoo`与`TAyzd9`同前缀。后续健康公共调用被过宽屏障拒绝的1R未通过放松断言处理；改源码以保留每次显式调用独立的API契约。

## 采用与范围

[固定GitHub源码研究](../research/github-fork-creation-receipt-patterns-2026-10-07.md)核对VS Code JSON-RPC 9.0.3 snapshot，MIT；借鉴原response登记与取消通知分离，不复制源码或引入依赖。Context7的middleware描述不被误当底层reply策略。

- 以独立创建回执绑定原实际process/source owner/request id，不编造fork或turn id。
- 每个observer仍有界等待和一次timer/listener结算；abort/timeout保留原reply路由。
- 原转换按cwd/prompt/model/schema身份接回同fork，只消费一次；不同材料和同cap并发消费拒绝。
- 创建未确认时不运行model。未采用转换/已放弃公共创建保持source屏障，所有未采用创建阻止idle关闭。
- public晚fork由原owner释放，真实ACK及generation匹配后才claim；cleanup重试合并，失败仍保留资源。健康公共fork调用各自独立。
- public创建在ready-start await后重新检查取消，禁止已取消caller发送新fork。

默认ephemeral Planner/Reviewer直接原线程转换，本轮的persistent-source fork不是新Planner/Reviewer替代线程。停止测试验证原本地Node进程；不声称launcher退出已证明未观察到的全部后代退出，失去原进程仍不能复建旧ephemeral。

## 当前证据与剩余门禁

第一版新增7/7通过，相关既有SDK/callback/owner/control84/84通过（34.56秒，`%TEMP%/dsh-fortyfourth-sdk-target.log`），typecheck/diff通过。最后两个修正及9例正在收尾复核，之后冻结、verify、连续两次release、host和host-recovery、diff；仅在全部通过并正式idle时受控重载。

本轮baseline `%TEMP%/dsh-fortyfourth-baseline-30c8e892-b735-4500-93de-29483394ae9f`复制348份源文件与文档，依赖目录复制0；不递归删除历史TEMP Junction。正式重载前后需复核411sessions、111workflow及完整canonical hash、构建freeze、原process birth和健康200。本节不预告尚未完成的结果。

## 最终目标回归冻结

九项最终9/9通过，第8的held ACK与两个独立fresh公共调用断言保持，第9同步取消为0fork/0model。日志`%TEMP%/dsh-fortyfourth-fork-creation-final-42fc8908647a40e19944f29a80288a31.log`；旧宽屏障回归证据`dsh-fork-creation-receipt-EVBbmr`保留，未改测试迁就实现。最后两方只读审查无新增具体blocker，typecheck/diff通过。当前SDK source SHA256 `3D8843267E3D984FF182874AB297EA841F15624B7D7FBE078FC31D13618787CF`，源码/测试/脚本251份冻结至`%TEMP%/dsh-fortyfourth-source-freeze.json`。

完整门禁已启动，日志目录`%TEMP%/dsh-fortyfourth-final-gates-18f98d78-c172-4811-a0ee-fe20ffffc795`。最终通过结果与正式重载状态仍须按该summary及运行核验记录补齐。

## 首次门禁与登记前置条件

首次verify1188/1188通过，449.03秒。第一次release1187/1188、1失败，454.33秒；失败为既有`bridge-runtime.test.ts`同目录双会话歧义case，实际`delivered`而预期`failed`，异步警告/取消/跳过均0。未因单独复跑通过就重启原门禁；原handle91182继续结算并保留summary。

原单例与整份Bridge文件独立复跑都通过（48项，23.65秒）。源码显示`start()`安排异步共享登记，fixture只在两个本地FakeRegistry中注册便立即入队，没有断言共享SQLite已有两条live记录。受控延迟第二个运行时的登记时，实际claim快照只有`session-ambig-1`，receipt为合法`delivered`，精确复现相同assertion。日志`%TEMP%/dsh-fortyfourth-ambiguity-order-proof-delayed.log`与对应TEMP probe保留；第一次只延迟init且错误查询未规范化cwd的probe仍GREEN，不能当作同一RED。临时仓库probe已移出并删除，不加入测试或package。

修正仅在这个fixture初始化两个BridgeStore、await两次实际发布并断言SQLite exact2行，然后才enqueue；保留终态失败、错误内容、零followup、无dead-letter及原receipt期限。源码/SUT未改以迁就门禁。Bridge全文件48/48通过，19.06秒，`%TEMP%/dsh-fortyfourth-dispatch-ambiguity-suite-ready.log`；typecheck/diff通过，SDK source仍前述3D884...。旧freeze保存为`%TEMP%/dsh-fortyfourth-source-freeze-before-ambiguity-fixture.json`，251份重新冻结，须从verify重跑全部链。

## 最终验收与正式运行

修正后的完整门禁目录`%TEMP%/dsh-fortyfourth-final-gates-6ae763b6-6024-495a-a353-4cf7c228da8f`，文件并发2，场景原有并发、assertion和期限保留。

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1188/1188，exit0 | 448.41秒 |
| `pnpm release:check` 第一次 | 1188/1188，exit0 | 521.22秒 |
| `pnpm release:check` 第二次 | 1188/1188，exit0 | 525.65秒 |
| `pnpm host:check` | exit0 | 5.26秒 |
| `pnpm host:recovery:check` | exit0 | 7.70秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告均0；offline doctor按合同跳过5项真实Codex连接检查。中途turn interruption后接回原live exec74560，未因等待中断重新启动门禁；随后在同句柄确认exit0。251份冻结源码/测试/脚本均匹配。

受控重载前再次核查411sessions、running0、waiting0，原启动参数保持`web --host 127.0.0.1 --port 3080 --no-open`。DSH PID86496→90876，新进程出生时间`2026-10-07T03:21:18.9585750+08:00`；认证exchange303、health200、authenticated=true，唯一listener为127.0.0.1:3080。旧树捕获11个原process instance，按birth证明全部退出。

重载后411sessions、111canonical workflow、原parent metadata保留；完整工作流哈希仍`96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8`。214份冻结build与receipt中21个关键模块hash均一致，stderr fatal0，activity仍running0/waiting0。`lib/app-server.js` SHA256 `2BB0426A454B4CD4995F44C0494D09BDC8A6B99C0CBAF0D517C4B1A60446AC1D`，`lib/workflow.js`保持第43轮 `4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。

重载receipt与核验分别保存在`%TEMP%/dsh-fortyfourth-reload-receipt.json`、`%TEMP%/dsh-fortyfourth-formal-verification.json`。认证state/formal stdout不打印或入库。故障注入使用真实SDK/stdIO和本地合成上游；不冒称已进行真实provider、计费或浏览器验收。尤其fork停止单例不证明未观察到的后代backend退出，该边界仍保持前述限制。

本轮未commit、push或publish；原等待模型的继续预算未增加，失去原process的ephemeral/历史corrupt会话不复建。当前改进与资料已落地，总体持续优化目标保持active。
