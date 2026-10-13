# 当前采用与验收检查点

截至2026-10-12第112轮完整验收与正式加载完成。下表区分源码采用、完整验证与正式加载；历史轮次见[此前采用记录](adoption-status-2026-10-08.md)。

## 当前状态

| 机制 | 固定源码研究 | 本项目入口 | 验收状态 |
| --- | --- | --- | --- |
| 验证构建与正式client隔离 | [Node/Execa构建隔离](github-verification-build-isolation-patterns-2026-10-10.md) | `scripts/verify-isolated.mjs`、`scripts/verification-stage.mjs` | 已采用；第98轮330输入副本验证，正式217产物内容及metadata保持至受控交付 |
| 原生测试收据防止错误放行 | [Node测试收据](github-node-test-summary-receipt-patterns-2026-10-10.md) | `scripts/test-receipt.mjs`、`test-receipt-reporter.mjs` | 第98轮verify/release均独立核对174份file摘要及累计摘要，缺失、取消、跳过及异步警告均不得放行 |
| 侧栏重试耗尽和卸载清理 | [重试耗尽](github-sidebar-retry-exhaustion-patterns-2026-10-09.md)、[侧栏退役](github-sidebar-disposal-patterns-2026-10-09.md) | `src/client.js` | 已正式加载，正式boot所服务client与已测产物一致 |
| 单调时钟约束重试预算 | [单调预算](github-monotonic-retry-budget-patterns-2026-10-09.md) | `src/transient-retry.ts`、workflow及CLI默认时钟 | 已正式加载，第96轮完整门禁覆盖原预算控制 |
| 失败保留partial输出及精确replacement | [中断输出](github-interrupted-child-output-patterns-2026-10-10.md)、[replacement](github-native-child-replacement-patterns-2026-10-10.md) | `src/codex-child-session.ts` | 第93/94轮实现，随第96轮完整门禁继续验证；原会话身份和已提交历史保留 |
| callback终止诊断优先于timeout/writer提示 | [p-retry终止优先](github-callback-terminal-precedence-patterns-2026-10-10.md) | `src/app-server-callback.ts` | 第96轮已正式加载；终止错误不再触发第二次可见模型请求，合法原线程继续保持 |
| 共享Reviewer测试超时清理 | [Node取消清理](github-observation-test-cleanup-patterns-2026-10-10.md) | `test/bridge-shared-reviewer-observation.test.ts` | 第96轮verify/release该文件均4/4；受控超时仍报告取消，但原夹具自动清理；自然超时原因未确认 |
| 旧submission迁移保留终止诊断 | [p-retry迁移分工](github-legacy-recovery-terminal-patterns-2026-10-10.md) | `src/workflow.ts`、`test/bridge-legacy-terminal-recovery.test.ts` | 第97轮已正式加载；verify/release1651/1651、host/11恢复/diff通过 |
| CLI信号退出保留终止诊断 | [Node close/exit与p-retry](github-cli-signal-terminal-patterns-2026-10-10.md) | `src/codex-cli-audit.ts`、`test/cli-terminal-signal.test.ts` | 第98轮已正式加载；RED3/7、GREEN7/7、相关91/91、verify/release1658/1658 |
| SDK callback信号退出保留终止诊断 | [Node close/exit与p-retry](github-cli-signal-terminal-patterns-2026-10-10.md) | `src/codex-callback.ts`、`test/callback-terminal-signal.test.ts` | 第99轮已正式加载；RED1/5、GREEN5/5、verify/release1663/1663 |
| retryState checkpoint 形状严格校验 | [Checkpoint恢复校验](github-checkpoint-resume-validation-patterns-2026-10-11.md) | `src/state/workflow-schema.ts`、`test/workflow-schema.test.ts` | 第100轮正式加载；61项回归及verify/release各1666/1666、175份文件摘要、host/11恢复/diff通过，首次1663/1664失败保留 |
| 已退出子进程避免重复清理 | [Execa/Node退出判断](github-signal-exit-cleanup-patterns-2026-10-11.md) | `src/infrastructure/process-transport.ts`、`test/process-signal-stop.test.ts` | 第101轮正式加载；生产旧2/6、GREEN6/6，旧PID夹具探针0/1→1/1，相关45/45，verify/release各1673/1673、host/11恢复/diff通过 |
| 模型目录缓存快照 | [模型目录快照](github-model-catalog-snapshot-immutability-2026-10-11.md) | `src/application/app-server/model-selection-gateway.ts`、`test/model-selection-cache-generation.test.ts` | 第102轮正式加载 detached/frozen snapshot；verify/release各1674/1674 |
| 同generation模型目录single-flight | [模型目录共享请求](github-model-catalog-snapshot-immutability-2026-10-11.md) | 同上 gateway 与generation回归 | 第104轮正式加载；15项目录回归、verify/release各1677/1677、host/11恢复/diff通过 |
| schema迁移备份失败 fail-closed | [Checkpoint备份边界](github-checkpoint-backup-fail-closed-2026-10-11.md) | `src/store.ts`、`test/store.test.ts` | 第103轮正式加载；18项回归、verify/release各1675/1675、host/11恢复/diff通过 |
| Bridge queue claim fencing audit | [Queue claim fencing](github-queue-claim-fencing-audit-2026-10-11.md) | `src/infrastructure/queue-repository.ts`、`src/bridge-store.ts`、`src/bridge-runtime.ts` | 第104轮审计保留现有 epoch/owner/lease fencing；未引入另一套claim协议 |
| Bridge非法retry deadline写入前拒绝 | [Deadline与queue回归](github-queue-claim-fencing-audit-2026-10-11.md) | `src/bridge-store.ts`、`test/bridge-store.test.ts` | 第104轮正式加载；原构建RED0/1、候选GREEN1/1，BridgeStore26/26，verify/release各1677/1677、host/11恢复/diff通过 |
| Foreground清理拒绝后尝试全部独立资源 | [Node hook与清理错误](github-foreground-cleanup-rejection-patterns-2026-10-11.md) | `test/foreground-new-review-round.test.ts`、`test/foreground-cleanup-failure.test.ts`及原场景preload actor | 第105轮完整验收；RED0/1、GREEN1/1、组合13/13，verify/release各1678/1678、host/11恢复/diff通过；生产源码及正式进程保持 |
| 进程树确认grace采用单调计时 | [单调清理预算](github-process-cleanup-monotonic-grace-2026-10-11.md) | `src/infrastructure/process-tree-cleanup.ts`、`test/process-tree-cleanup.test.ts` | 第106轮正式加载；RED5/7、GREEN7/7，verify/release各1683/1683、host/11恢复/diff通过 |
| 原owner仍有效时补读一次退役清单 | [有界原清单观察](github-process-retirement-census-observation-2026-10-11.md) | `src/app-server.ts`、`test/retirement-census.test.ts`及preload actor | 第106轮正式加载；RED1/3、GREEN3/3，相关31/31和callback28/28；持续不可用及退役仍拒绝，未认定自然CIM异常根因 |
| 原进程清单脱敏诊断 | [清单诊断](github-process-census-diagnostics-2026-10-11.md) | `src/infrastructure/process-transport.ts`、`src/app-server.ts`、`test/process-census-diagnostics.test.ts` | 第107轮正式加载；producer10/10、扩展12/12、退役3/3、相关44/44、组合40/40；verify/release各1695/1695、host/11恢复/diff通过 |
| Fork清理复用清单诊断 | [清单诊断](github-process-census-diagnostics-2026-10-11.md) | `src/app-server.ts` fork evidence、callback/retirement regressions | 第108轮补充正式加载；rerun verify/release各1695/1695、host/11恢复/diff通过；只追加 `lib/app-server.js` 及 map |
| 丢失原进程后的刷新诊断 | [刷新诊断](github-lost-process-refresh-diagnostics-2026-10-11.md) | `src/infrastructure/process-transport.ts`、`src/app-server.ts`及刷新/永久停止回归 | 第109轮正式加载；刷新10/10、真实SDK3/3、组合49/49；verify/release各1699/1699、179份原生摘要、host/11恢复/diff通过；正式PID77536认证HTTP200 |
| 原启动清单诊断前缀 | [启动清单前缀](github-startup-census-diagnostic-prefix-2026-10-11.md) | `src/app-server.ts`、`test/startup-census-ownership.test.ts`及永久停止回归 | 第110轮正式加载；两项RED确认、owner退役GREEN1/1、SDK组合12/12、初始化组合31/31；verify/release各1700/1700、179份原生摘要、host/11恢复/diff通过；正式PID81424认证HTTP200 |
| Reviewer绑定回写同线程恢复 | [绑定恢复](github-reviewer-binding-recovery-2026-10-11.md) | `src/app-server-callback.ts`、`test/callback-binding-persistence.test.ts` | 第111轮正式加载；RED后GREEN1/1、callback组合75/75；verify/release各1701/1701、179份原生摘要、host/11恢复/diff通过；正式PID87604认证HTTP200 |
| Reviewer绑定取消竞态清理 | [绑定取消竞态](github-reviewer-binding-cancel-race-2026-10-11.md) | `src/app-server-callback.ts`、`test/callback-binding-cancel-race.test.ts` | 第112轮正式加载；RED后cancel/cancelSubmission/stop GREEN、typecheck通过；verify/release各1702/1702、182份原生摘要、host/11恢复/diff通过；系统重启后正式PID23948认证HTTP200 |

## 已完成的正式验收

[第96轮](../iterations/2026-10-10-ninetysixth-callback-terminal-precedence.md)原门禁62488真实exit0：verify/release各1645/1645，172份原生文件摘要，失败/取消/跳过/TODO和异步警告0；offline doctor与包审计、宿主加载、11个恢复/冷回放场景和diff均通过。

只在实际空闲、原身份及数据双查后受控加载：旧22108原树11实例退出，新65896认证HTTP200；217份产物哈希匹配。414会话身份、429session文件、111workflow和119queue完整记录保持，原parent、历史corrupt child、取消诊断marker及休眠inbox保留。

宿主恢复使用scripted-local网关，正式boot检查不等于浏览器交互。真实provider自然断流、Token账单与历史corrupt子会话修复不在已证明范围。原21308门禁1644通过/1取消及清理证据保留；后续成功没有改写旧失败。

## 历史与当前验收

[第97轮](../iterations/2026-10-10-ninetyseventh-legacy-terminal-recovery.md)原47664/birthKey `win32:134360681580520070`在`isolated-9olNA1`验证329输入；verify/release1651/1651、173份原生文件摘要、host/11恢复/diff通过，正式加载后数据保持。

[第98轮](../iterations/2026-10-11-ninetyeighth-cli-signal-terminal.md)已取得新完整门禁、实际进程退出、原数据/身份保护与精确产物交付证据，CLI信号候选正式加载到PID37280。第99轮 callback 候选随后以PID29964正式加载，331输入、175文件摘要和1663测试全部通过；第97轮原失败证据与第98轮后继退出证据仍保留。当前415会话、430文件、111 workflow和119 queue保持；provider/profile未改，未commit/push/publish，持续优化目标active。

[第100轮](../iterations/2026-10-11-hundredth-retry-checkpoint-validation.md)原47604在`isolated-oxdyLi`真实exit0；verify/release各1666/1666、175份原生文件摘要、host/11恢复/diff通过。只交付schema JS及map两份产物，正式PID51296/`win32:134361396830022610`健康HTTP200；415会话、430文件、111workflow、119queue及7份受保护配置字节保持。首次失败与历史失败、corrupt child均保留，持续优化目标active。

[第101轮](../iterations/2026-10-11-hundredfirst-signal-exit-stop.md)修正门禁原38860在`isolated-8le4t3`真实exit0；verify/release各1673/1673、176份原生文件摘要、host/11恢复/diff通过。正式PID61132/`win32:134361442103445850`健康HTTP200；只交付`lib/infrastructure/process-transport.js`及map，415会话、430文件、111workflow、119queue和7份受保护配置保持。首次1670/1672失败与第100轮证据均保留，持续优化目标active。

[第103轮](../iterations/2026-10-11-hundredthird-backup-fail-closed.md)原61448 gate verify/release各1675/1675、176份原生文件摘要、host/11恢复/diff通过。正式PID63232/`win32:134361498286863260`健康HTTP200；只交付`lib/store.d.ts`、`lib/store.js`及map，415会话、430文件、111workflow、119queue和7份配置保护保持，持续优化目标active。

[第102轮](../iterations/2026-10-11-hundredsecond-model-catalog-snapshot.md)原49796 gate verify/release各1674/1674、176份原生文件摘要、host/11恢复/diff通过。只交付`lib/application/app-server/model-selection-gateway.js`及map，正式PID60728/`win32:134361472106544430`健康HTTP200；415会话、430文件、111workflow、119queue和7份配置保护保持，持续优化目标active。

[第104轮](../iterations/2026-10-11-hundredfourth-retry-deadline-validation.md)原64904/`win32:134361517349580680`在`isolated-q7X0V5`实际exit0，verify/release各1677/1677、176份原生摘要、host/11恢复/diff通过。交付5份BridgeStore及模型目录产物，217份哈希匹配；正式PID47864/`win32:134361539107257510`认证HTTP200，415会话、430文件、111workflow、119queue及7份配置保护保持。首次失败、预计数量修正及文档追加另存证据，持续优化目标active。

[第105轮](../iterations/2026-10-11-hundredfifth-foreground-cleanup-rejection.md)原59344/`win32:134361549934795450`在`isolated-5QsNDT`实际exit0，verify/release各1678/1678、177份原生摘要、host/11恢复/diff通过。只改测试清理及回归，217份生成产物与正式构建及metadata一致；保留PID47864和全部415会话、430文件、111workflow、119queue及7份配置。自然清理异常原因仍未确认，受控清理早退缺口已验证修复，持续优化目标active。

[第106轮](../iterations/2026-10-11-hundredsixth-process-cleanup-monotonic-grace.md)修正原42160/`win32:134361590175203420`在`isolated-IIomJm`实际exit0，verify/release各1683/1683、178份原生摘要、host/11恢复/diff通过。交付四份App Server/cleanup产物，217份哈希匹配；正式PID46240/`win32:134361611415782030`认证HTTP200。保留当前416会话、431文件、111workflow、119queue及7份配置；新增未播种空白会话的运行态经有界空闲证明后随原进程释放，其header和所有旧记录字节保持。首次1679/1680失败、探针修正及回滚保留，持续优化目标active。

[第107轮](../iterations/2026-10-11-hundredseventh-process-census-diagnostics.md)修正原56676/`win32:134361634216697300`在`isolated-2OlXo9`实际exit0，verify/release各1695/1695、179份原生摘要、host/11恢复/diff通过。交付六份App Server/transport产物，217份哈希匹配；正式PID64836/`win32:134361658820367440`认证HTTP200。保留416会话、431文件、111workflow、119queue、7份配置和新增空白header会话；首次106轮失败、107轮所有RED/探针、回滚证据保持，持续优化目标active。



