# 研究导航与采用边界

从下面的问题入口找固定源码研究，再查看对应测试与迭代记录。研究说明外部机制和采用方向；实际实现以当前源码为准，正式加载结果以 `docs/iterations/` 中的最终验收及重载记录为准。

先看 [当前采用与验收检查点](adoption-status-2026-10-10.md)，区分已有实现、正式加载和仍在验收中的改动。[此前采用记录](adoption-status-2026-10-08.md)按历史轮次保留，不能作为当前运行状态。

需要在 DSH 中验收原会话继续时，使用[中文测试提示词与身份核对步骤](../dsh-same-session-recovery.md)。它区分人工停止与真实模型故障，不把新线程成功当作旧线程恢复。

## 从用户问题定位

| 问题 | 优先研究 | 当前实现入口 | 验证入口 |
| --- | --- | --- | --- |
| 验证build让未完成门禁的client被正式服务读取 | [构建与HMR隔离](github-verification-build-isolation-patterns-2026-10-10.md) | `scripts/verify-isolated.mjs`、`scripts/verification-stage.mjs` | 已采用；[第96轮](../iterations/2026-10-10-ninetysixth-callback-terminal-precedence.md)副本完整验收与正式产物保护 |
| 终止诊断包含timeout/writer提示却继续模型 | [callback终止优先](github-callback-terminal-precedence-patterns-2026-10-10.md) | `src/app-server-callback.ts` | 第96轮已正式加载，verify/release各1645/1645；保留合法原线程继续 |
| 旧submission迁移改写权限/Schema失败 | [旧迁移分类](github-legacy-recovery-terminal-patterns-2026-10-10.md) | `src/workflow.ts` 的迁移资格判定 | [第97轮](../iterations/2026-10-10-ninetyseventh-legacy-terminal-recovery.md)已合入、完整1651预期门禁进行中，尚未加载 |
| CLI信号退出把终止诊断误判为busy | [CLI信号终止分类](github-cli-signal-terminal-patterns-2026-10-10.md) | `src/codex-cli-audit.ts` 的终止优先级 | [第98轮](../iterations/2026-10-11-ninetyeighth-cli-signal-terminal.md)已正式加载，verify/release1658/1658 |
| 测试超时后原假模型进程导致整套测试等待 | [Node取消清理](github-observation-test-cleanup-patterns-2026-10-10.md) | 原fixture signal/step/close及观察测试after | 第96轮原观察文件verify/release均4/4；原自然超时原因未确认 |
| 侧栏重试达到上限后随模型进度反复重新开栏 | [耗尽状态](github-sidebar-retry-exhaustion-patterns-2026-10-09.md) | `src/client.js` 的原目标耗尽集合 | 已正式加载；[第90轮](../iterations/2026-10-09-ninetieth-sidebar-retry-budget.md)及第96轮完整验收 |
| 系统时间校正后重试超预算或过早终止 | [单调重试预算](github-monotonic-retry-budget-patterns-2026-10-09.md) | `retryClockNow`及三个默认计时入口 | 已正式加载；[第89轮](../iterations/2026-10-09-eightyninth-monotonic-retry-clock.md)及第96轮完整验收 |
| 插件卸载后旧通知又开侧栏、切换会话重复退订 | [侧栏退役机制](github-sidebar-disposal-patterns-2026-10-09.md) | `src/client.js` 的扫描/重试接纳与原投影释放 | `test/sidebar-disposal.test.ts`、[第88轮状态](../iterations/2026-10-09-eightyeighth-sidebar-disposal.md) |
| 规划失败是否留在原会话继续 | [会话与取消](github-workflow-patterns-2026-10-05.md)、[Planner原归属](github-planner-run-ownership-patterns-2026-10-05.md) | `src/application/planner-execution.ts`、`planner-run-identity.ts` | `test/planner-run-ownership.test.ts`、`workflow-resume.test.ts` |
| 下游失败是否重复昂贵的模型步骤 | [审查checkpoint](github-review-checkpoint-patterns-2026-10-06.md)、[阶段恢复](github-foreground-stage-checkpoint-patterns-2026-10-06.md) | `src/application/foreground-review-checkpoint.ts`、`submission-review-checkpoint.ts` | `test/foreground-review-stage-recovery.test.ts`、`bridge-review-checkpoint.test.ts` |
| 继续时工作区或身份已变化 | [恢复身份](github-resume-identity-fencing-patterns-2026-10-06.md)、[审查证据准入](github-review-evidence-admission-patterns-2026-10-06.md) | `src/application/reviewer-run-identity.ts`、`workflow-review-admission.ts` | `test/reviewer-recovery-identity.test.ts`、`review-admission.test.ts` |
| 模型失败后主会话应该做什么 | [失败动作](github-workflow-failure-action-policy-2026-10-06.md)、[工具路由](github-workflow-action-routing-patterns-2026-10-06.md) | `src/application/submission-recovery-policy.ts`、`src/tools.ts` | `test/submission-recovery-policy.test.ts`、`bridge-unavailable-review-routing.test.ts` |
| Token观察重复累计或历史输出太长 | [用量归属](github-usage-budget-patterns-2026-10-05.md)、[工具结果展示](github-tool-result-patterns-2026-10-05.md) | `src/usage-accounting.ts`、`workflow-usage.ts`、`tool-usage-render.ts` | `test/durable-workflow-usage.test.ts`、`tool-usage-render.test.ts` |
| 中文或emoji错误诊断变成乱码、尾部字符被截断 | [Node/Execa增量UTF-8解码](github-stderr-utf8-patterns-2026-10-08.md) | `src/app-server.ts` 的原child诊断流 | `test/app-server-stderr-utf8.test.ts`、[第57轮验收状态](../iterations/2026-10-08-fiftyseventh-stderr-utf8.md) |
| 进程已退出，真实stderr随后到达却没有进入错误诊断 | [Node/Execa退出与流收尾](github-exit-stderr-drain-patterns-2026-10-08.md) | `src/app-server.ts` 的有界原exit诊断与失效结算 | `test/app-server-exit-stderr.test.ts`、[第58轮最终验收与加载](../iterations/2026-10-08-fiftyeighth-exit-stderr-drain.md) |
| 中文错误摘要超出“字节上限”，emoji裁切损坏 | [诊断字节预算](github-diagnostic-byte-budget-patterns-2026-10-08.md) | `src/transient-retry.ts` 的共享compactDiagnostic | `test/compact-diagnostic.test.ts`、`codex-cli-audit.test.ts`、[第59轮最终验收与加载](../iterations/2026-10-08-fiftyninth-diagnostic-byte-budget.md) |
| backoff迟到唤醒后又启动超预算操作 | [等待后截止检查](github-retry-wakeup-deadline-patterns-2026-10-08.md) | `src/transient-retry.ts`、`src/workflow.ts`、`src/codex-cli-audit.ts` | `test/retry-wakeup-budget.test.ts`、[第60轮最终验收与加载](../iterations/2026-10-08-sixtieth-retry-wakeup-deadline.md) |
| 抖动使单次等待超过配置上限，提前耗尽重试预算 | [最终等待上限](github-retry-delay-ceiling-patterns-2026-10-08.md) | `src/transient-retry.ts` 的共享backoffDelayMs | `test/retry-delay-ceiling.test.ts`、[第61轮最终验收与加载](../iterations/2026-10-08-sixtyfirst-retry-delay-ceiling.md) |
| CLI stderr中文字节超限，最终解码绕过输出预算 | [CLI字节保留与最终刷新](github-cli-output-byte-bound-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的原data/close处理 | `test/codex-cli-audit.test.ts`、[第62轮最终验收与加载](../iterations/2026-10-08-sixtysecond-cli-output-byte-bound.md) |
| CLI stderr诊断流报错导致宿主退出 | [每原流错误责任](github-cli-stderr-error-ownership-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的原run与失败出口 | `test/cli-stderr-failure.test.ts`、[第63轮最终验收与加载](../iterations/2026-10-08-sixtythird-cli-stderr-error-ownership.md) |
| CLI提示词写入或模型输出流报错导致崩溃、原子进程遗留 | [输入/输出流失败结算](github-cli-model-stream-ownership-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的原run/abort/close | `test/cli-model-stream-failure.test.ts`、[第64轮最终验收与加载](../iterations/2026-10-08-sixtyfourth-cli-model-stream-ownership.md) |
| CLI已退出但原线程身份仍在保存，caller取消被丢失 | [绑定与取消观察寿命](github-cli-binding-cancellation-lifetime-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的close/binding结算 | `test/cli-binding-lifetime.test.ts`、[第65轮最终验收与加载](../iterations/2026-10-08-sixtyfifth-cli-binding-cancellation-lifetime.md) |
| CLI等待同Reviewer占用时，caller取消不能及时返回 | [等待者独立取消](github-cli-queued-waiter-cancellation-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的waitThreadIdle | `test/cli-queued-waiter.test.ts`、[第66轮最终验收与加载](../iterations/2026-10-08-sixtysixth-cli-queued-waiter-cancellation.md) |
| 同CLI Reviewer的多个等待者同时启动模型进程 | [同步准入预留](github-cli-thread-admission-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的run/reserveThread | `test/cli-thread-admission.test.ts`、[第67轮最终验收与加载](../iterations/2026-10-08-sixtyseventh-cli-thread-admission.md) |
| 按workflow/submission取消漏掉尚无child的排队调用 | [待准入身份与目标取消](github-cli-targeted-queued-cancellation-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的pendingRuns/cancel | `test/cli-targeted-queued-cancel.test.ts`、[第68轮最终验收与加载](../iterations/2026-10-08-sixtyeighth-cli-targeted-queued-cancellation.md) |
| CLI子进程已退出，退避中的原操作仍会绕过目标取消再启动 | [整个retry的取消责任](github-cli-retry-operation-cancellation-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的runWithTransientRetry/pendingRuns/stop | `test/cli-backoff-cancel.test.ts`、[第69轮最终验收与加载](../iterations/2026-10-08-sixtyninth-cli-retry-operation-cancellation.md) |
| CLI已完成审查，等待保存期间取消仍会启动转换或交付成功 | [公开调用与异步回调取消](github-cli-pipeline-cancellation-patterns-2026-10-08.md) | `src/codex-cli-audit.ts` 的withCancellation及公开操作 | `test/cli-pipeline-cancel.test.ts`、[第70轮最终验收与加载](../iterations/2026-10-08-seventieth-cli-pipeline-cancellation.md)；首因交接的后续RED另记 |
| 已接纳操作先取消再stop，跨阶段丢失原取消原因 | [原signal及准入首因](github-cli-firstcause-handoff-patterns-2026-10-09.md) | `src/codex-cli-audit.ts` 的assertAdmission/pendingRuns | `test/cli-firstcause-handoff.test.ts`、[第71轮最终验收与冷启动加载](../iterations/2026-10-09-seventyfirst-cli-firstcause-handoff.md)，含中断及输出编码审计 |
| Windows隐藏控制台损坏Unicode汇总，后台计数误报 | [Node原生TAP与tsx参数](github-test-reporter-console-patterns-2026-10-09.md) | `scripts/run-tests.mjs` 的可选reporter环境入口 | `test/test-runner-reporter.test.ts`、[第72轮记录](../iterations/2026-10-09-seventysecond-test-reporter-console.md)及第73轮完整验收，保留原DSH实例 |
| 测试已超时，等待原lease通知的fixture仍保留模型进程 | [TestContext取消与清理责任](github-test-context-cancellation-patterns-2026-10-09.md) | `test/fixtures/bridge-shared-reviewer-fixture.ts` 的signal/step/close及原after hooks | `test/shared-reviewer-cancellation.test.ts`、[第73轮最终验收](../iterations/2026-10-09-seventythird-shared-reviewer-test-cancellation.md)，原自然通知时序未单独定位 |
| SQLite锁竞争使lease心跳错误逃逸定时器 | [原续租异常与owner通知](github-lease-heartbeat-error-patterns-2026-10-09.md) | `src/workflow.ts` 的makeManagerLease heartbeat | `test/lease-heartbeat-error.test.ts`、[第74轮最终验收与加载](../iterations/2026-10-09-seventyfourth-lease-heartbeat-errors.md)，原自然通知时序未单独定位 |
| 共享Reviewer的旧通知污染新调用 | [消费者归属](github-shared-workflow-consumer-ownership-patterns-2026-10-06.md)、[心跳归属](github-heartbeat-registration-ownership-patterns-2026-10-06.md) | `src/application/submission-review-consumer.ts`、`src/bridge-runtime.ts` | `test/bridge-shared-reviewer-ownership.test.ts`、`review-heartbeat-registration.test.ts` |

## 进程与通道的诊断顺序

1. **启动失败：** [共享初始化](github-shared-initialization-cancellation-patterns-2026-10-06.md) → [初始化中I/O错误](github-initialization-transport-failure-patterns-2026-10-07.md) → [缺失stdio](github-missing-stdio-spawn-patterns-2026-10-07.md)。实现入口为 `src/app-server.ts` 和 `src/infrastructure/process-transport.ts`。
2. **线程/回合未知：** [原RPC归属](github-original-rpc-transport-ownership-patterns-2026-10-06.md) → [待定回执](github-pending-turn-receipt-ownership-patterns-2026-10-06.md) → [原操作寿命](github-observer-cancellation-operation-receipt-patterns-2026-10-06.md)。本地超时不证明远端执行结束。
3. **结果已成功，清理失败：** [转换结果与清理分离](github-completed-task-cleanup-recovery-patterns-2026-10-07.md) → [订阅释放确认](github-subscription-release-validation-patterns-2026-10-07.md)。恢复清理不得重放完成的模型或callback。
4. **launcher/backend退出：** [原birth身份](github-original-process-birth-identity-patterns-2026-10-06.md) → [永久停止](github-permanent-stop-ownership-patterns-2026-10-07.md) → [意外退出](github-unexpected-launcher-exit-ownership-patterns-2026-10-07.md) → [Windows独立缺席](github-windows-process-absence-patterns-2026-10-07.md)。进程数字PID、信号发送成功和stdout关闭都不能替代原实例退出证明。
5. **管道错误：** [写入错误](github-stdio-write-failure-patterns-2026-10-06.md)、[输出寿命](github-stdio-output-lifetime-patterns-2026-10-07.md)、[stderr诊断错误](github-stderr-diagnostic-error-patterns-2026-10-07.md)、[UTF-8分片与完整字符尾部](github-stderr-utf8-patterns-2026-10-08.md)、[exit后的诊断收尾](github-exit-stderr-drain-patterns-2026-10-08.md)。stdin/stdout是控制通道，stderr是诊断通道，失败策略分别验证。

## 如何复用研究

原生侧栏验收参考[日志持久化与释放后回放](github-session-journal-retirement-patterns-2026-10-09.md)及[浏览器模块注册与自动开栏](github-native-client-registration-patterns-2026-10-09.md)。第76轮增强持久化检查，第77轮实际客户端复现Reviewer焦点缺陷，第78轮合入修正并完成候选全过程验收；完整门禁和受控加载以[当前检查点](adoption-status-2026-10-10.md)为入口。受控UI结果不代表真实provider故障或费用已验收。

- 读取固定提交、许可、实际源码机制和未覆盖边界；不能根据项目名或“最佳实践”直接复制实现。
- 先确认对应缺陷和最小回归，再采用机制；历史“建议采用”段不代表当前代码已经完成。
- 持久workflow存在不证明ephemeral线程仍活；原进程丢失时必须报告不可恢复。
- 本地fixture、真实Socket、受控契约回放、真实provider和UI验收分开记录。没有服务器计数时用量保持未知，字节数不能冒充Token或费用。
- 交付门禁见 [release checklist](../release-checklist.md)。每轮真实失败、最终门禁和正式记录保护结果见 [iterations](../iterations/)。

初版在第56轮最终验收期间整理，第57轮补充UTF-8诊断与中文DSH验收入口，第58轮补充实际exit后的诊断收尾。导航不替代各轮最终门禁和正式加载证据，不修改冻结代码或运行中的门禁。

完整测试回执见[Node语义摘要与原进程退出](github-node-test-summary-receipt-patterns-2026-10-10.md)：12份固定来源及本机契约核对后，第92轮补齐dot误拒/zero-exit误放行复现，并合入原run/root、各文件摘要、累计摘要和退出码检查。相关68项及便携Node22.19控制通过，verify/release各1612/1612、169文件/native摘要及host/11恢复/diff完整验收。[实际状态](../iterations/2026-10-10-ninetysecond-native-test-receipts.md)仍保留最低版本全量和真实provider未覆盖范围。

失败前已显示的正文丢失见[中断流与原子回合收尾](github-interrupted-child-output-patterns-2026-10-10.md)：第93轮公开factory真实RED/GREEN及none/zstd冷读控制后保留partial，失败状态与成功权威正文分别保持。verify/release各1620/1620、host/11恢复通过，已精确交付stage产物至formal12176，原数据保持；原thread保持不能单独证明原正文也保留。

流式正文与最终snapshot重复见[原native replacement与临时流退役](github-native-child-replacement-patterns-2026-10-10.md)：第94轮按kind/item更新当前段、退役未提交display attempt并在原turn/step发布修正文字；不新增模型或child。相关56项、独立browser六阶段及verify/release各1632/1632、host/11恢复通过，已精确加载formal59112，全量历史保持。

隐藏provider执行与可见结果位置的指令一致性见[子会话结果载体合同](github-subagent-output-destination-contracts-2026-10-10.md)：第95轮只修正Planner/共用Reviewer的Desktop旧措辞，既有实际接收渠道检查及verify/release各1632/1632、host/11恢复通过，已精确加载formal22108。真实模型遵循程度仍未单独验证。

终止错误附超时文字导致多发模型请求见[原调查](callback-timeout-terminal-precedence-investigation-2026-10-10.md)与[p-retry终止优先级取舍](github-callback-terminal-precedence-patterns-2026-10-10.md)。第96轮处理两层分类绕行，相关95项及typecheck通过；第95轮完整验收/加载后已按hash合入，新的1645预期完整链正在运行，正式尚未加载分类修正。
