# 第46轮：有效订阅释放回执后才提交本地清理

状态：修复、完整门禁和正式重载已完成。正式DSH已加载第46轮，PID23616；411sessions/111workflow及完整canonical记录保持。总体持续优化目标active，未commit/push/publish。下文保留阶段性失败与修正记录，最终结果见末节。

## 实际问题

`unsubscribeRegisteredThread`先删liveThreads/threadOwners/tokenUsage，再读取response.status，并将未知shape当作unsubscribed。真实SDK/stdIO的废弃public fork晚回执遇到缺失或未知status时，原backend仍loaded fork1，客户端却释放其保护状态，随后允许fork2及源模型。null结果会删owner后抛TypeError，原fork无法再次安全释放。

原命令`pnpm exec tsx --test --test-name-pattern='unsubscribe reply retains' test/fork-creation-receipt.test.ts`为3/3 RED。日志`%TEMP%/dsh-fortysixth-unsubscribe-red.log`及三个失败目录均保留，fixture停止并独立证明捕获原进程退出。候选原因包括本地清理先于验证、服务端已释放但回执缺字段、进程已经退出；wire/stats证明服务端存活且原fork loaded，将后两项排除。

## 来源与实现

[固定GitHub及官方文档研究](../research/github-subscription-release-validation-patterns-2026-10-07.md)记录openai/codex、TypeScript App Server客户端及Context7命中范围。只采用验证先于交付/状态提交的顺序，没有复制实现或安装新依赖。

- `requestRaw<unknown>`结果先验证required三值status，再删除本地订阅owner及usage。
- 非法响应抛既有CodexProtocolError，保留原句柄和废弃fork清理保护，不回显payload。
- 仍接受官方unsubscribed/notSubscribed/notLoaded；不改原process及owner匹配规则，不把unsubscribe变成模型中止证明。
- 新增三个真实wire回归覆盖缺失、未知及null，随后held ACK验证原owner直到有效确认才被释放一次。
- 两个健康fixture改为协议规定的status；业务assertion、场景期限及模型预算保持。

## 当前验证

`pnpm exec tsx --test test/fork-creation-receipt.test.ts`为12/12 GREEN，17.64秒，日志`%TEMP%/dsh-fortysixth-unsubscribe-green.log`；typecheck通过。相关SDK/callback/原进程控制91/91通过，60.11秒，日志`%TEMP%/dsh-fortysixth-subscription-target.log`，包含现有三种有效状态、取消、回执恢复及出生身份控制。diff通过。

首次完整门禁目录`%TEMP%/dsh-fortysixth-final-gates-cea35940-b34a-47a9-afbc-a64613da248b`。verify1199/1199、exit0通过，541.10秒；第一次release同样1199/1199、exit0通过，605.21秒。两次运行失败/取消/跳过/异步警告均0；新增缺失、未知及null unsubscribe回执三项均通过。第二次release出现旧共享Reviewer测试超时，见后节；同exec35265已结算exit1，855.19秒，1199项中pass1198/cancelled1/fail0，异步警告/跳过0，未进入host或host-recovery。文件并发2，场景内部assertion与期限保持。旧254份冻结记录保存在`%TEMP%/dsh-fortysixth-source-freeze-before-shared-lease-fixture.json`，修正fixture后的254份已重新冻结，须从verify重跑完整链。

baseline `%TEMP%/dsh-fortysixth-baseline-f0b5c5e7-d36c-48a6-9ffd-58221d07421d`包含358份源码、测试与文档，依赖目录0。门禁遵循verify、连续两次release、host、host-recovery、diff；正式idle和freeze一致后才重载。历史corrupt会话与丢失ephemeral不复建。当前证据仅本地合成上游，不声称真实provider/浏览器/Token计费验收。

SDK源码SHA256 `897BB4A91BB6FC5945C7C8D75AD11BF3F369E411E6925EE32372DBEE7F53223B`。Agent Reach只读check-update返回当前v1.5.0已最新，未安装或更新工具。

## 重载准备与未完成门禁保护

已准备`%TEMP%/dsh-fortysixth-controlled-reload.ps1`、formal-verify及service-tree-verify三个helper；重载helper额外校验六项最终门禁、三个全量运行1199/1199、254份源码及217份最终build冻结，缺失或失败均拒绝执行。原正式PID96564还需匹配已核实出生时间`2026-10-07T07:38:36.6347160+08:00`、原启动命令及唯一127.0.0.1:3080 listener，并再次检查idle。

实际在当前门禁未完成时运行helper，返回`Final gate summary is not available; reload forbidden`；随后CIM证明原PID/birth不变，新formal认证state未创建。脚本语法检查0错误。这仅验证提前重载被阻止，不冒称已经正式部署。verify通过后仍接回live exec35265等待剩余门禁，全部通过后再生成最终build freeze并捕获前后canonical metadata。

## 首次第二次release与租约通知前置条件

旧`bridge-shared-reviewer-ownership.test.ts`的active case触发30秒测试超时，原日志仍保留。独立复跑1/1通过（1.73秒），但不把偶发GREEN当修复。该测试在释放SQL lease后先让B接管，再等待A的heartbeat观察SQL丢失；合法接管会结束A的等待并停止其heartbeat，因此这个事件可能已经无法产生。

TEMP受控重放只把第一份原lease的heartbeat周期延至5000ms，保留生产SDK及原断言。首个1500ms观测界限探针定位后，又以相同7000ms观测界限重放：先日志显示B发送及A heartbeat停止，后等待SQL loss失败；stats为thread1/model1/child1，A signal已中止、B signal仍live、interrupt0/dispose0。RED日志`%TEMP%/dsh-fortysixth-lease-order-bounded-red.log`与目录`dsh-fortysixth-lease-order-SHUioy`保留。

修正仅移动原测试的`await lossSeen.entered`到SQL release之后、B recover之前，确保真实续租失败已经产生且其通知仍由既有gate保持。原30秒test timeout、全部业务断言、模型预算不变。相同5000ms延迟/7000ms观测重放GREEN，6.94秒，日志`%TEMP%/dsh-fortysixth-lease-order-green.log`及目录`dsh-fortysixth-lease-order-UKacH9`保留。共享归属/观测/退役/Bridge回执控制12/12通过，26.81秒，日志`%TEMP%/dsh-fortysixth-shared-lease-suite-ready.log`。SDK source仍897BB...。

原超时case的未结算promise留下worker90388，妨碍门禁退出。核对原test文件命令及出生时间`2026-10-07T08:10:00.2537000+08:00`后，保存isolated SQLite副本及3个原实例birth证据，使用本项目安全handle helper只清理这组诊断实例，并独立证明全部退出。证据目录`%TEMP%/dsh-fortysixth-failed-lease-worker-a098fecf-8d71-4038-ad7b-c5201f38c4d6`。这次强制退出后的门禁结果必须记作失败，不能冒称原case正常完成；正式PID96564及411sessions保持，历史数据库未触碰。

所有临时probe位于TEMP，仓库未新增诊断文件。旧门禁已经在原句柄确认terminal exit1；下一完整链采用重新冻结的254份输入，从verify重跑全部检查。后续受控重载helper须改为最终成功链目录，不得沿用首次失败summary。

## 修正后的完整门禁

新链目录`%TEMP%/dsh-fortysixth-final-gates-7d661b1f-3ac9-4886-9a89-9d6e2e922e53`。新verify1199/1199、exit0通过，631.75秒；第一次release同样1199/1199、exit0通过，645.25秒。先前超时的共享租约通知case在verify正常完成（1.66秒）、release1再次正常完成（1.49秒）、release2正常完成（1.72秒）；旧retry finalizer及三种非法unsubscribe回执case也通过。原exec98333已确认terminal exit0，全部最终结果见末节。254份冻结输入匹配0偏差，源SDK仍897BB...，文件并发2。受控重载helper采用该新目录，语法检查0错误，旧失败链引用0；首次helper版本保存于TEMP。前一次失败链的结果没有替代本链验收。

## 最终门禁与正式运行

全部检查在同一新门禁进程中结算，未因观测等待到期重启检查。文件并发2，场景内原有并发、assertion及期限保持。

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1199/1199，exit0 | 631.75秒 |
| `pnpm release:check` 第一次 | 1199/1199，exit0 | 645.25秒 |
| `pnpm release:check` 第二次 | 1199/1199，exit0 | 728.78秒 |
| `pnpm host:check` | exit0 | 7.44秒 |
| `pnpm host:recovery:check` | exit0 | 14.77秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告均0；两个release的离线doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理完成。254份冻结源码/测试/脚本匹配0偏差。当前SDK源码SHA256 `897BB4A91BB6FC5945C7C8D75AD11BF3F369E411E6925EE32372DBEE7F53223B`。

重载前重新核查正式411sessions、running0/waiting0、完整门禁及最终217份build freeze。helper核对原PID96564的已知birth、命令、唯一listener后受控重载为PID23616；新birth为`2026-10-07T08:57:34.3178900+08:00`，参数保持`web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303、authenticated=true、health200，唯一listener为127.0.0.1:3080；11个捕获旧process instance按birth独立证明全部退出。

正式重载后411sessions、111workflow、原parent metadata保持，完整canonical哈希仍`96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8`。217份冻结build及receipt中22个关键模块哈希全部匹配，stderr fatal0，activity仍running0/waiting0。`lib/app-server.js` SHA256 `1431E446512AC48770FA7354F72C779FAE1D8B86AED110159A8EA09A125E9649`；`lib/workflow.js`保持`4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。

receipt和核验分别保存于`%TEMP%/dsh-fortysixth-reload-receipt.json`、`%TEMP%/dsh-fortysixth-formal-verification.json`；认证state/formal stdout不打印或入库。host恢复验收使用已安装DSH服务、真实SDK/stdIO及本地合成上游；不冒称真实provider故障、Token计费或浏览器交互验收。Windows原生清理证据已执行，Linux pidfd没有在WSL执行。本轮未修改profile/provider/凭据，历史corrupt/丢失ephemeral会话未复建，未commit/push/publish。总体持续优化目标保持active。
