# 第56轮：stderr诊断错误不能终止健康控制通道

状态：本轮修复、最终串行完整门禁及正式重载完成。2026-10-08正式DSH PID120796已加载第56轮，412sessions/111workflows与完整canonical保持。下文保留实际失败、配置选择和阶段反馈，最终结果见末节。总体持续优化目标active，未commit/push/publish。

## 当前现场和RED

上一轮已实际落地，为已验证进展。本轮再读第55轮PID112348/birth `2026-10-07T22:22:59.1108720+08:00`，412sessions/111workflows、available0/running0/waiting0、完整canonical/session hash和原parent/历史corrupt保持；HEAD仍abb6174，既有dirty工作保留。

隔离SDK worker实际启动本地protocol，保存原birth树后，毁掉原stderr Socket并提供真实Error。旧代码只有data listener，没有error listener；worker自然退出1，monitor观察到诊断read error，健康RPC无法继续。RED日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftysixth-20261007/stderr-read-red.log`，现场 `%TEMP%/dsh-stderr-read-failure-fjKNqy/states.jsonl`。没有全局uncaughtException handler或强制success，外层仅清理已捕获原身份的诊断child。

原因候选为stderr没有error消费、诊断与协议能力混用、未按原child隔离。代码及native反馈支持前者；修复直接消费，局部marker由当前child拥有，健康JSON-RPC不触发failTransport或改变owner。

## 研究、实现与控制

[固定Playwright/MCP研究](../research/github-stderr-diagnostic-error-patterns-2026-10-07.md)记录实际机制和未覆盖的Readable错误限制，Context7核对Node默认fatal规则。未复制实现或增加依赖；389份baseline、固定源码和日志在本轮持久目录，依赖目录0。

当前stderr错误只设自己的局部unavailable标记，actual exit body尾部固定说明诊断丢失，不附private stream-error内容；原exit prefix/cause规则保持。旧stream事件始终被消费，但失去owner不能标记后继。物理退役仍需原树proof，不因本地诊断故障成立。

首轮4项原stderr控制通过，17.19秒。新四模式ready/initializing/active/exit-diagnostic通过，14.39秒；active test最初signal参数位置错误导致超时，按SDK第三参数修正，未改预算。随后新旧stderr组合8/8，29.12秒，实际旧pipe65536字节及旧marker隔离保持。

新增late-read-error独立模式在真实退休OS字节到达并且新owner已存在时，毁掉仍开放的旧Socket；current-own/current-silent均不含旧diagnostic marker，原晚到无fault/drained断言不变。typecheck/diff通过，关联控制正在原句柄中结算。

verify、连续两次release、host、host-recovery及diff全部通过，源/build freeze一致且正式idle后才重载。profile/provider/凭据、canonical/历史corrupt保持，认证state/formal stdout仅TEMP不输出内容，未commit/push/publish。本地真实Socket故障，未声称provider/Token计费/浏览器/Linux实机验收。

相关96/96、exit0，192.77秒，失败/取消/跳过0，日志 `stderr-read-controls.log`。完整链目录 `final-gates-cce97e5a-de53-43b1-9835-1fbaa8445297/`，原exec77039持续结算。265份源码/测试/脚本冻结，每项完整门禁前后校验；文件并发2，原场景期限及业务断言不改，预期1275项。SDK源码SHA256 `3E082214F7242ED15CA97182EB601E0F7DC0A2E9FCF7ADD642B83B938407C2F4`。受控reload核对原PID112348及birth、六项最终门禁、源/build freeze和现场idle，没有因观测超时重复运行或启动新实例。

verify1275/1275、exit0，1131.40秒，失败/取消/跳过/异步警告0；连续release和host继续原exec77039执行，尚未正式重载。

release第一次1275/1275、exit0，1113.00秒，失败/取消/跳过/异步警告0；offline doctor明确跳过5项真实连接检查，pack audit和临时tarball清理通过。第二次继续原exec77039，尚未正式重载。

## 首轮第二次release的实际失败

原exec77039 terminal exit1，release2为1274/1275，1失败，1091.39秒，取消/跳过/异步警告0；host未运行，正式仍第55轮。失败为既有Windows independent absence的denied-then-retry：原退出proof成功后，后续SQLite guard查询未确认。该轮verify和release1完整通过，但未用于放行。原完整目录保留。

恢复后的OS查询加入仅记录原PID对应结果的诊断，有界8次单项重复全部通过；首次未确认查询的具体原因未能证实，不冒称已制造PID复用或具体权限故障。测试把恢复后的同一只读guard确认限定在既有4000ms control预算内再次观察；只有unconfirmed cleanup可重试，每次都断言原token/epoch仍未确认，最终原成功断言不变，没有模型/线程/信号或生产probe规则变化。不是把unknown变为成功，也没有扩大预算。最终target和新完整链将重新结算，原失败链绝不放行。

最终目标组合21/21、exit0，33.92秒，日志 `stderr-absence-final-target.log`；typecheck/diff通过。生产SDK源码仍 `3E082214F7242ED15CA97182EB601E0F7DC0A2E9FCF7ADD642B83B938407C2F4`。更新265份freeze后，新完整链位于 `final-gates-5438b4d5-2c4e-4f97-ac7b-e9beec8033c1/`，原exec3627持续结算，reload只引用这个目录。正式仍第55轮PID112348，412sessions/111workflows和完整hash保持，未重载。

## 验收期间的研究整理

接续poll原exec3627确认新链verify1275/1275、exit0，1158.50秒，失败/取消/跳过/异步警告0；连续release和host仍在同一原进程结算。日期跨到2026-10-08仍保留本轮开始时的目录与证据身份，未重复发起门禁或重载。

## 第二条完整链的实际停止与串行控制

原exec3627明确terminal exit1。release1为1272/1275、3失败，1357.15秒，取消/跳过/异步警告0；release2和host未启动，正式第55轮保持。失败为fork fixture的初始化birth缺失、completed-fork stop未确认、stdin ready fixture握手未到达；此前verify已1275/1275通过但不足以放行。完整目录 `final-gates-5438b4d5-2c4e-4f97-ac7b-e9beec8033c1/`保留。

现场可用物理内存约1.1GiB，520个进程，无匹配的遗留diagnostic进程，PowerShell进程3个。没有据此断言内存是三个失败的确切原因，没有停止浏览器、正式DSH或其他用户服务。失败initialize wire仅记录initialize和最终input-ended，两个fork wire记录原模型/原unsubscribe/EOF，未据局部事件冒称whole-tree SDK证明成立。

按AGENTS.md允许的独立文件并发1运行原 `fork-creation-receipt.test.ts` 与 `initialization-input-failure.test.ts`，27/27、exit0，84.35秒，失败/取消/跳过0，日志 `serial-pressure-target.log`。各场景内部并发、原预算、断言和生产源码均保持；串行通过只表明该执行配置可以通过这些边界，不作为完整门禁或根因结论。

后续完整verify/连续release/host链独立文件并发1，以新的gate目录及同一265份source freeze重新执行。只因上条完整链已确认失败才重跑，旧失败结果不放行正式重载。总持续优化目标active。

串行完整链实际目录 `final-gates-393f1481-f1e7-42d0-a406-0a8d5e202513/`，原exec52486，运行器已打印文件并发1，265份freeze无偏差。受控reload helper只引用该目录；当前正在verify，正式未重载。

后续接续poll同一exec52486仍running，串行verify已通过stderr诊断、旧pipe错误隔离、活跃turn、并发stop等原断言，未调场景内部并发。再读265份freeze0偏差、正式412sessions/111workflows完整hash与idle保持，diff检查通过。当前没有完成最终release/host门禁，仍不放行正式重载；下一次接续继续观察同一句柄。

再一次接续确认原exec52486仍running，串行verify推进到Planner checkpoint/失去原进程检查，未替代进程，fork结果复用、初始化首因和物理stop检查保持通过。当前没有新完整终态结果，正式依旧第55轮；没有重复启动验收或重载。本次只作为实际运行句柄的verified wait记录，不作为第56轮完成证明。

后续在原exec52486结算串行verify1275/1275、exit0，2144.83秒，失败/取消/跳过/异步警告0。独立文件并发1的第一次release已开始，仍需第二次release及host门禁，尚未正式重载。这证明该完整verify运行通过，不将降低独立文件竞争当作先前失败原因已查明的结论。

验收期间新增 `docs/research/adoption-status-2026-10-08.md`，将8类已实现机制对应原固定源码研究、实现及测试/完成记录；明确第56轮未正式加载及本地/provider/Linux证明边界。研究导航加入入口，两份文档共62个相对链接检查全部有效，生产freeze未修改，diff通过。

接续工作先实际poll原exec3627，确认仍running，再核对265份freeze无偏差，正式412sessions/111workflows完整hash及idle保持。没有重启运行中的完整链。

新增 `docs/research/README.md` 按用户问题组织既有研究，映射到当前代码和回归入口：同会话继续、阶段checkpoint、证据/身份、失败动作、Token来源/展示及共享Reviewer消费者；进程诊断按启动、回执、结果清理、原树、读写/诊断流顺序导航。29个相对文档链接全部有效，diff检查通过。明确历史研究的“采用建议”不是当前完成证明，最终加载以迭代验收记录为准。该新增仅为文档，未改变冻结生产源码或正在运行的门禁。

## 最终完整验收与正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1275/1275，exit0 | 2144.83秒 |
| `pnpm release:check` 第一次 | 1275/1275，exit0 | 1985.50秒 |
| `pnpm release:check` 第二次 | 1275/1275，exit0 | 2168.86秒 |
| `pnpm host:check` | exit0 | 5.88秒 |
| `pnpm host:recovery:check` | exit0 | 12.50秒 |
| `git diff --check` | exit0 | 已记录 |

最终三个全量运行失败/取消/跳过/异步警告0；两次release offline doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理。独立文件并发1（AGENTS允许），各场景原内部并发、时限和最终断言保持；265份source freeze前后匹配，217份build冻结。此前两条失败链完整保留，未放行；当前采用配置的通过不当作先前失败根因已被证明。

原exec52486明确terminal exit0后才重载。监视器末尾尝试对空diff日志做regex统计，出现显示层null-input错误；原六项summary及原进程exit0已核实，未误当测试失败或重启完整链。受控reload原exec89486只启动一次新实例，等待同一句柄完成认证/健康检查，未再启动。

reload核对原PID112348及birth、六项最终门禁、源/build freeze、唯一listener与现场idle。现场412sessions、available0/running0/waiting0、111workflows。已打开原handle/birth安全清理捕获树11实例并独立证明退出后，仅启动PID120796。新birth `2026-10-08T02:23:59.9336880+08:00`；入口、工作目录和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`，认证exchange303/authenticated=true、health200，唯一127.0.0.1:3080 listener匹配。

正式217份build和receipt的27个关键模块hash0偏差，stderr fatal0。412sessions排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持；111workflow完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent及历史corrupt child存在，running0/waiting0。

`lib/app-server.js` SHA256 `219050B8A681D417BEABE89E6D80C77A2F9EBB4671F53F2CE488C274046D73E2`。formal-before/after、原树证据、reload-receipt和formal-verification在本轮持久目录；认证state/formal stdout仅TEMP，未输出内容。未修改profile/provider/凭据，未复建丢失ephemeral或替换历史corrupt，未commit/push/publish。

研究导航与采用状态表共62个相对链接有效，代码/验证入口已经核对；验收期只新增文档，未动冻结的生产输入。host为已安装DSH服务、实际SDK/stdIO和本地合成上游，stderr错误为真实本地Socket故障；没有声称provider自然故障、Token费用、浏览器或Linux pidfd实机验收。本轮落地，总持续优化目标保持active。
