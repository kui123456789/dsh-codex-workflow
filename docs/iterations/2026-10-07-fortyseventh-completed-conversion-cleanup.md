# 第47轮：完成的转换与失败清理分离

状态：修复、完整门禁和正式重载已完成。正式DSH已加载第47轮PID104552；重载前后412sessions/111workflow及完整canonical记录保持，新增会话保留。总体持续优化目标active，未commit/push/publish。下文保留阶段性失败与修正记录，最终结果见末节。

## 真实问题与复现

`normalizeInFork`的finally过早标记released并吞掉unsubscribe错误。首次模型输出有效且按原接口返回成功，但原fork仍loaded，后续相同转换没有可恢复清理记录。最终保留API语义的RED为2/2失败，`%TEMP%/dsh-fortyseventh-completed-release-api-red.log`；wire为fork3/model4，原fork未释放。初探把清理失败解释成首次模型结果失败的断言未采用，初探日志仍保留。

## 固定研究与实现

[LangGraph和p-retry研究](../research/github-completed-task-cleanup-recovery-patterns-2026-10-07.md)记录固定SHA、manifest及许可，未引入依赖或复制实现。

- SDK保留原fork创建证据、进程/owner、输入签名及独立结果副本；首次成功输出或模型主错误保持。
- 同材料恢复只执行原清理；材料/owner改变及失去原进程拒绝恢复。缓存不持久化ephemeral句柄。
- 并发清理共用flight，取消单个observer不取消另一个；缓存输出不重放模型回调。
- 原模型中断未确认时先确认真实原pair，不把订阅释放当作模型中止。
- pending资源阻止idle关闭；SDK stop按捕获birth证明原backend退出才清记录。
- 明确释放源订阅可先清它自己的fork；外部交接传播清理错误，拒绝关闭仍有活动或未确认工作的SDK。

## 目标验收

核心转换两项、缓存副本、并发/取消、idle、主错误、原pair、源释放、外部交接及SDK停止控制已通过。新增真实launcher/backend case验证转换完成后launcher退出、backend存活，再由stop清理原实例；1/1通过，3.33秒，日志`%TEMP%/dsh-fortyseventh-completed-backend-green.log`。该项没有修复前原生RED，不混同于核心wire RED。

最终相关检查117/117通过，86.59秒，日志`%TEMP%/dsh-fortyseventh-fork-release-reviewed-final-target.log`；typecheck/diff通过。SDK source SHA256 `975C71FD4629DFA28C26D9DFDA2206D8A27D48B1EB184BEDAE5EE0669511BC15`。

中途一次过宽文本替换误删public forkId绑定，typecheck报TS2304，目标运行111/116；已恢复正确public返回值，未改测试迁就。随后115/116的唯一失败为既有callback visible-timeout fixture：全局80ms故障预算继续影响后来转换的RPC。原日志均保留。

## 回调故障预算的控制证明

TEMP原actor首次`.ts`被按CJS处理，不能算wire证据，随后用`.mts`执行。旧预算行为加真实后续转换回执延迟120ms，得到同一retryable_busy。为排除初始metadata也受80ms影响的混淆，再只在原80ms模型回执等待结束后模拟旧预算泄漏；两次模型start中只有原第一个held，后续120ms回执确实在80ms预算下变成pending。日志`%TEMP%/dsh-fortyseventh-callback-budget-followup-wire-red.log`，证据目录`%TEMP%/dsh-fortyseventh-callback-budget-8daeb349-78ee-4ab8-ae65-0296df42eee6`。

修正只在fixture的同步requestRaw seam给指定原模型启动采样80ms，立即恢复正常预算；assert记录原requestId/80ms。后续120ms真实延迟现在通过，`%TEMP%/dsh-fortyseventh-callback-budget-wire-green.log`；业务断言和原模型故障期限不变，未修改生产代码为观测延迟兜底。

baseline `%TEMP%/dsh-fortyseventh-baseline-93c7cd5d-31fa-4fb1-8c9e-3c7ce7f81026`有360份源码/测试/文档，依赖目录0。临时probe均在TEMP，历史数据和corrupt会话未删除。完整verify、连续两次release、host/host-recovery及最终freeze一致、正式idle后才重载。当前证据未覆盖真实provider、Token计费或浏览器交互；Linux pidfd没有在WSL执行。

## 完整门禁已启动

首链目录`%TEMP%/dsh-fortyseventh-final-gates-c7a07908-984d-4318-aa02-01b00f6f9f8a`，原exec93809已确认terminal exit1；verify1208/1209、fail1，545.05秒，取消/跳过/异步警告0，未进入后续release或host。文件并发2，全部场景assertion和期限保持。受控重载、formal-verify及tree-verify helper已准备，但须改为后续实际成功链；完整门禁六项通过及最终build freeze匹配、原正式PID23616与已知birth核对后才执行。正式411sessions/running0/waiting0，本轮尚未重载。

## 首次全量verify与stdio fixture正常ACK

首个verify出现旧`app-server-stdio-failure.test.ts`的old-late case失败。独立复跑同样失败（1.25秒），不是偶发GREEN；直接执行原actor保留states/wire，证明在startup就因`thread/unsubscribe`的response.status非法而拒绝，尚未触发retired stdin error。证据`%TEMP%/dsh-fortyseventh-retired-stdin-e6d1e665-cb8c-4898-8094-afc0908578bd`及`%TEMP%/dsh-fortyseventh-retired-stdin-actor-red.log`。

该fake backend将unsubscribe落入通用`{ ok: true }`分支；第47轮交接入口现在正确传播清理错误，暴露了fixture缺少真实正常ACK。只为该方法返回`{ status: "unsubscribed" }`，没有放松生产校验、旧stdin隔离断言或期限。stdio/stderr/RPC控制11/11通过，10.62秒，日志`%TEMP%/dsh-fortyseventh-stdio-contract-green.log`；SDK source仍975C71...。

原exec93809已收集其失败链终态，唯一失败就是上述fixture正常ACK不合法。旧freeze保存在`%TEMP%/dsh-fortyseventh-source-freeze-before-stdio-contract.json`，修正后254份已重新冻结并匹配；从verify重跑全部门禁。正式第46轮未重载。

## 修正后的新完整链

目录`%TEMP%/dsh-fortyseventh-final-gates-7509e507-aefb-47e4-b5dc-24e165179384`。新verify1209/1209、exit0通过，551.00秒；第一次release同样1209/1209、exit0通过，574.40秒。旧stdin隔离case正常完成，completed-fork原生backend停止、缓存输出及外部交接保护case均通过。原exec52415已结算terminal exit0，全部最终结果见末节；254份输入匹配，文件并发2。重载helper采用本链目录，旧失败链引用0，语法检查0错误。重载前重新核查正式412sessions/available1/running0/waiting0，较起始多一个会话，按当前412快照验收；未使用旧411数字覆盖新增历史。

## 最终门禁与正式运行

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1209/1209，exit0 | 551.00秒 |
| `pnpm release:check` 第一次 | 1209/1209，exit0 | 574.40秒 |
| `pnpm release:check` 第二次 | 1209/1209，exit0 | 664.15秒 |
| `pnpm host:check` | exit0 | 5.48秒 |
| `pnpm host:recovery:check` | exit0 | 11.68秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告均0；两个release的offline doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理完成。门禁在同一exec52415中结算，没有因观测等待到期重新启动。文件并发2，场景原并发、assertion及期限保持。254份冻结源码/测试/脚本匹配0偏差；SDK source仍`975C71FD4629DFA28C26D9DFDA2206D8A27D48B1EB184BEDAE5EE0669511BC15`。

重载前核查当前412sessions、running0/waiting0；已有1个loaded Agent但没有运行中任务或等待workflow。受控helper验证原PID23616/birth、原命令、唯一listener、完整门禁及217份最终build freeze，随后PID23616→104552。新birth为`2026-10-07T10:33:59.8675500+08:00`，参数保持`web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303、authenticated=true、health200，唯一listener为127.0.0.1:3080；捕获旧树11个原process instance按birth独立证明全部退出。

重载后412sessions、111workflow及原parent metadata保留，完整canonical哈希仍`96a21988c539b969a69eb9576d546bf24c4cab43f1e634cce028543cc778c2d8`。217份冻结build与receipt中22个关键模块哈希全部匹配，stderr fatal0，activity为running0/waiting0/available0。loaded Agent的内存实例随重载结束，本节只证明会话历史及工作流记录保持，不冒称保留该Agent的运行态。

`lib/app-server.js` SHA256 `39D74787CFDBB7F7E24F7ED087E6CEB406470D11EA2E4CE09E9E438F94A90497`；`lib/workflow.js`保持`4DCA8A6612083AE4D9F8A395608BE08A99573A356D7623FAFE5993FA90B2D999`。receipt和核验保存于`%TEMP%/dsh-fortyseventh-reload-receipt.json`、`%TEMP%/dsh-fortyseventh-formal-verification.json`。认证state/formal stdout不打印或入库。

host恢复验收使用已安装DSH服务、真实SDK/stdIO及本地合成上游；不冒称真实provider故障、Token计费或浏览器交互验收。新增Windows原生launcher/backend场景实际执行；Linux pidfd没有在WSL执行。profile/provider/凭据未改，历史corrupt和失去原进程的ephemeral会话未复建，未commit/push/publish。第47轮落地，总体持续优化目标保持active。
