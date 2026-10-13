# 第45轮：fork创建的原backend进程树清理

状态：修复、完整门禁与正式重载已完成。正式DSH已加载第45轮，PID96564；411sessions/111workflow及完整canonical记录保持。总体持续优化目标active；未commit/push/publish。下文保留首次失败与修正过程，最终结果见末节。

## 真实反馈

第44轮的单Node停止测试不能证明launcher背后的backend结束。本轮真实SDK/stdIO回归先RED：原fork已创建、reply保持、model0；SDK stop返回后捕获树仍有原backend。原日志`%TEMP%/dsh-fortyfifth-fork-stop-red.log`与证据`%TEMP%/dsh-fork-creation-stop-tree-7nBKKb`保留。测试用独有marker清掉原backend，全部捕获实例退出后才结束。

## 来源与实现

[固定GitHub研究](../research/github-process-tree-exit-proof-patterns-2026-10-07.md)比较Playwright、Execa和.NET reference source，另以Context7核对Node/Python API。没有复制库、安装依赖或将exit/close/信号发送混为完成证明。

- SDK fork创建保存原树证据，stop在原launcher处理后清理剩余原实例。
- 新`process-tree-cleanup.ts`分离安全终止与独立退出校验：缺出生身份不裸PID强杀，发送成功不等于完成。
- Windows打开原Process handle后比较微秒精度出生时间，终止同一handle；Linux使用现有Python/pidfd，不可用则未确认。
- 证明成立才清创建记录；失败保留树，下一stop只重试原清理。并发/重复成功停止保持单flight，不允许重新bootstrap或model。

## 验收

目标17/17通过，17.12秒：原生树停止3项（launcher正常/提前退出/真实终止helper失败后重试）、证明策略4项和不匹配出生的存活进程1项，既有fork控制9项。日志`%TEMP%/dsh-fortyfifth-tree-target-reviewed.log`。类型检查/测试harness的namespace只读execFile赋值错误仅修测试导入，未改业务assertion。

既有SDK/callback控制94/94通过，54.27秒，日志`%TEMP%/dsh-fortyfifth-sdk-target.log`；typecheck/diff通过。Windows native实例实际测试通过；Linux pidfd仅核对API和实现，未在WSL运行，不冒称跨平台运行验收。

baseline `%TEMP%/dsh-fortyfifth-baseline-fffb48c2-3162-4f92-b3cd-6433431e87ab`含354份源文件与文档、依赖目录0。完整verify、两次release、host/host-recovery与冻结检查完成且正式idle后，才受控重载。认证state和formal stdout不打印或入库，历史corrupt/丢失ephemeral不复建。

## 首次全量门禁与取消前置条件

首次门禁`%TEMP%/dsh-fortyfifth-final-gates-c22435a1-de73-495e-8314-9007ef05835b`：verify1196/1196（541.83秒）、release1同样通过（537.14秒）；release2 1195/1196（603.25秒）失败于旧`app-server.test.ts`活动回合取消case。其固定50ms定时器并不证明模型准备已经完成；单项复跑GREEN，受控在SDK准备步骤延迟150ms则实际onStarted0、同样等不到interrupt，RED日志`%TEMP%/dsh-fortyfifth-active-cancel-preparation-red.log`与TEMP probe保留，临时仓库文件已移出/删除。

该fixture现在在真实onStarted后才取消实际HANG回合，保留原中止marker、错误、request/marker期限。未让生产源码对不存在的turn制造中止请求。App Server整文件42/42通过（31.40秒），`%TEMP%/dsh-fortyfifth-active-cancel-suite-ready.log`；typecheck/diff通过。首次完整日志仍保留，取消/跳过/异步警告0；旧freeze保存在`%TEMP%/dsh-fortyfifth-source-freeze-before-active-cancel-fixture.json`，254份重新冻结，须重新从verify跑完整链。

## 第二次门禁与独立观测通道

第二次完整链`%TEMP%/dsh-fortyfifth-final-gates-be699147-acf6-45f3-9c22-fdefa9bf213b`：verify1196/1196（558.12秒）、release1同样通过（563.63秒），release2 1195/1196（565.42秒）。唯一失败是跨stage Bridge测试的`fixture/stats`超时，而不是guard/assertion失败。保留的`%TEMP%/dsh-bridge-start-receipt-evidence-9rIqqE`显示process-start、sending、pin1、guard0，仍在观测初始化阶段。

该fixture给模型启动注入200ms超时时，意外也压缩了stats观测RPC。先用TEMP模拟观测器局部超时定位，但不把它算作原SDK wire证据；随后真实backend延迟stats reply250ms，原SDK requestRaw定时器确实报同一超时（`%TEMP%/dsh-fortyfifth-generation-observer-wire-red.log`），修复后相同真实delay通过（wire-green.log）。

修正只在测试helper的同步requestRaw seam为`fixture/*`采样原正常4000ms观测预算，再立即恢复；模型及其它真实RPC的200ms故障预算、scenario期限与全部业务assertion保持。同步调用在返回Promise前采样timer，不能异步延长native model期限。generation backend只有可选stats延迟参数。Bridge目标5/5通过（11.77秒），typecheck/diff通过；SDK source未变。原证据及两次失败链保留，temporary repo probe已删除。254份再次冻结，旧版本`%TEMP%/dsh-fortyfifth-source-freeze-before-observation-fixture.json`保留，须从verify重跑全部门禁。

## 最终门禁与正式重载

最终门禁目录`%TEMP%/dsh-fortyfifth-final-gates-c9b60a72-017d-422f-94fb-8a29a34e1141`。接回同一个exec92532并确认exit0，没有重跑已完成的门禁。文件并发2，场景内部并发、原assertion和期限保持。

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1196/1196，exit0 | 542.17秒 |
| `pnpm release:check` 第一次 | 1196/1196，exit0 | 548.81秒 |
| `pnpm release:check` 第二次 | 1196/1196，exit0 | 547.50秒 |
| `pnpm host:check` | exit0 | 5.88秒 |
| `pnpm host:recovery:check` | exit0 | 9.68秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告均0；offline doctor明确跳过5项真实Codex连接检查。254份冻结源码/测试/脚本匹配0偏差；SDK源码SHA256 `8E4F9ACE5B1CEDCC3F6F267F5E542845B4CE7503F8040137A4223F58D98C744D`。

正式重载前再次核查411sessions、running0/waiting0。DSH PID90876→96564，出生时间`2026-10-07T07:38:36.6347160+08:00`；原参数保持`web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303、authenticated=true、health200，唯一listener为127.0.0.1:3080。捕获的旧树11个原process instance按birth独立证明全部退出。认证state生成前的一次提前只读metadata查询返回ENOENT；原重载继续完成后再查询成功，没有因此第二次启动服务。

重载后411sessions、111workflow、原parent metadata保留，完整canonical哈希仍`96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8`。217份冻结build及receipt中22个关键模块hash全部一致，stderr fatal0，activity仍running0/waiting0。`lib/app-server.js` SHA256 `BA404E6BBD6114D2437590A39B50756D39973998A1DEE7A4BD02865487A54243`，`lib/infrastructure/process-tree-cleanup.js`为`30121443180695268ADEF61C18FBEF7C5B0AA5AE2EADA87F1059ADA997AE58E0`；`lib/workflow.js`保持`4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。

重载与核验分别保存于`%TEMP%/dsh-fortyfifth-reload-receipt.json`、`%TEMP%/dsh-fortyfifth-formal-verification.json`，认证state/formal stdout不打印或入库。Windows native退出回归已经执行；Linux pidfd未在WSL运行。host恢复验收使用已安装DSH服务、真实SDK/stdIO及本地合成上游，不冒称真实provider、Token计费或浏览器交互验收。

## 无返回ID的恢复边界复核

用户贴出的旧回复把“没有active workflow”解释为“记录根本不存在”，并把start防重复说明解释成永久一次配额。当前工具契约已明确：启动中断先调用无ID的`codex_workflow_status`；`codex_workflow_resume`的workflowId可省略，由当前DSH会话查找原工作流。只有`continuation.available=true`才发送模型继续；pending receipt仅检查原操作，interruption未确认仅重试原清理。不可用时报告精确原因，不创建替代Planner/Reviewer，也不由父会话代写结果。

实际只读核查该历史parent有两条canonical记录（cancelled及failed），corrupt child仍保留metadata、agentAvailable=false；这不证明该child对应其中哪一条，也不提供可恢复的ephemeral句柄。全量门禁覆盖无ID恢复、启动前中止、真实thread/start失败的可查询诊断和禁止伪造原线程。旧corrupt/丢失进程的会话未复建。本轮完成既有部署收尾；总体持续优化目标保持active。
