# 第三十四轮：成功清理确认限定原执行代次

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。本轮完整门禁通过，正式 DSH 已从 PID31516 重载至 PID59600，411 会话及原父会话保留。最终实时证据见文末。保留全部既有工作、历史文档和配置，没有 commit/push/发布。

## 已证实缺陷与证据

成功 ACK 表明某次原执行结束，不能成为相同业务地址上未来执行的通行证。

| Evidence | Finding | 本轮处理路径 |
|---|---|---|
| 真实 SDK、原生 DSH child、SQLite、本地协议两次稳定 RED；旧进程实际退出，新协议进程故意复用原 thread/turn 文本 | 新回合失败 ACK 后，旧 terminal receipt 误授权释放新 child/pin，实际新 writer 仍活着 | `confirmTerminalCleanup` 以原 `RecoverableWorkflowRun` 对象限定 receipt，另保精确 pair |
| 独立 SQLite guard 读取历史 confirmed 行、缺少当前 marker，及旧 owner 对后继 epoch 的释放探针 | 历史 tombstone 与 workflowId 不足以证明当前清理代次；同 scope／相同 primary error 也可能属于后继运行 | `TerminalCleanupGuard` 比较 workflow/session/token/epoch，使用原 owner 生成且复用自己的 marker |
| 冻结旧源码走真实 `withAuxiliaryReviewThread` 创建和清理入口，3 场景中 **2 RED / 1 CONTROL** | 新辅助执行读取旧 ACK；旧 cleanup flight 完成时删除相同 thread 地址的新 owner | 原 `RetainedAuxiliaryTurn` 对象限定确认；ACK 后再次核 registry owner，只释放自己的 pin |

SDK 两次 RED 均有五项独立不变量失败：waiting、awaitingCleanup、原新 child 保留、新 pair ACK 请求以及新 pin 保留。新 writer 活着、cleanup 零模型请求和每进程仅一个 thread 控制均成立。此协议故意使用进程内递增 ID，不声称正式 Codex CLI 会复用 UUID。诊断进程最后实际退出，未注入正式 provider 故障。

公开研究见 [TanStack Query／etcd 固定证据](../research/github-confirmation-execution-generation-patterns-2026-10-06.md)：TanStack 同 key 成功回调重入后新 Promise 与旧 Promise 不同，旧 finally 只清原 retryer；etcd 写入／删除在事务内比较原 key 的创建 revision。源码、License 和官方测试固定到 SHA；只读取上游测试，未执行或引入依赖。

## 最小采用与保持的边界

- terminal receipt 使用原运行对象，auxiliary receipt 使用原保留 turn 对象；中断错误到 owner 的关联仅保存在当前进程。相同公开 pair 或同一个 PID 不代表相同执行。
- 持久确认要求原 workflow/session/token/epoch。无 marker 的旧记录仍能读取，但不能借历史确认获得清理权限；过期 TTL 也不是原 writer 已结束的证据。
- 同原 owner 的重复／并发确认共享原 cleanup flight，成功后不再次 interrupt、unsubscribe、dispose 或 endRound。新的执行生成自己的 token/epoch，先建立 guard 再发布 waiting marker，冷 Manager 在这个窗口不能启动替代者。
- 旧 ACK 到达后可记录旧 owner 自己的确认，不能删除／释放新 registry owner。旧辅助执行只结束自己的 process pin；它不能对复用地址发送 unsubscribe。
- lifecycle 完成原清理后，写入诊断／移除持久 marker 还要精确比较原 token/epoch/session。后继行即使 task、cwd、primary error 都相同，也须保持完整 SQLite 行不变。
- SQL 协调 Manager owner 变化不自动等于原 App Server execution 换代。仍属于同一真实执行的确认继续有效；ephemeral 进程重启后不伪造旧恢复句柄。失败 ACK 恢复只清理原资源，零模型 continuation。

## 已完成的回归验证

| 范围 | 实际结果与证据 |
|---|---|
| 新增持久 generation guard | 6 场景：历史 marker、原 owner 幂等、callback wrapper 身份、旧 release、新 lease fencing、Schema；进入目标组合通过 |
| 真实 SDK execution 换代／原运行并发 cleanup | 首次 **1 RED / 1 CONTROL** → 当前 **2/2 GREEN**；`test/confirmation-generation.test.ts` |
| 新辅助 owner／并发确认／迟到 ACK | 冻结 **2 RED / 1 CONTROL** → 当前 **3/3 GREEN**；`test/auxiliary-confirmation-generation.test.ts` |
| lifecycle 后继 marker／waiting 发布窗口 | 相同 scope 后继 marker 冻结旧源码 **1/1 RED**；当前新增 **2/2 GREEN**；`test/terminal-cleanup-generation-lifecycle.test.ts` |
| 原终止错误与 generation 目标组合 | **48/48 GREEN**，失败／取消／跳过均0；`%TEMP%/dsh-thirtyfourth-target3.log` |
| 原公开 status/resume 组合 | **31/31 GREEN**；`%TEMP%/dsh-thirtyfourth-public-original-session-resume-current.log` |
| 原创建响应／启动边界／工具契约 | **30/30 GREEN**；`%TEMP%/dsh-thirtyfourth-original-creation-receipt-tools-current.log` |

本轮新增13场景：guard6、SDK2、auxiliary3、lifecycle2。局部组合有重叠，不相加冒称全套数量。初始组合发现审查确认相位遗漏，随后修复；另一失败来自测试直接比较含 `mode` 的完整 protocol event 与 pair，改为只投影 threadId/turnId，真实请求次数及资源断言保留。辅助迟到 ACK 控制还捕捉旧 pin 必须释放，修复后保新 owner 且 pins=1、ends=1。

公开恢复契约也由当前测试重新核对：`status({})` 与省略 workflowId 的 resume 可以定位当前原任务；失败 start 的一次调用不是永久 quota；已接纳 thread/start 的 caller abort 仍收集原响应并保留同一 child/thread；`running`、`interruption_unconfirmed` 和可恢复原句柄分别处理。父会话不得代写计划／审查，损坏会话元数据不用于伪造运行态能力。

复跑本轮核心边界：

```powershell
pnpm exec tsx --test test/terminal-cleanup-guard.test.ts test/confirmation-generation.test.ts test/auxiliary-confirmation-generation.test.ts test/terminal-cleanup-generation-lifecycle.test.ts
pnpm exec tsx --test test/planner-late-thread-start.test.ts test/start-boundary.test.ts test/tools.test.ts
```

RED 基线 `%TEMP%/dsh-thirtyfourth-baseline-60655754-3efe-4c03-9c04-3f4bcf97658d` 保全原源码，含指向共享依赖的 `node_modules` Junction，已写禁止递归删除标记。SDK探针 `dsh-thirtyfourth-confirmation-generation-probe.run1.results.json`、`run2.results.json` 为 RED；当前 `dsh-thirtyfourth-confirmation-generation-probe.results.json` 的9项断言全部 GREEN。辅助 RED／GREEN 日志为 `dsh-thirtyfourth-auxiliary-generation-red.log` 与 `dsh-thirtyfourth-auxiliary-generation-first-green.log`；lifecycle RED 保存在 `%TEMP%/dsh-thirtyfourth-confirmation-generation-audit/generation-lifecycle-frozen-red.log`。

## 门禁交接状态：最终结果待追加

下表记录文档交接时的证据边界；完整门禁已由主任务启动，结果及正式重载尚待追加。

| 必须检查 | 当前证据状态 |
|---|---|
| `pnpm typecheck` | 主任务已执行通过；全量门禁还会重核 |
| `pnpm verify` | 已启动，尚无本轮全套完成证据 |
| `pnpm release:check` 连续两次 | 待执行，尚无本轮包审计／临时包清理证据 |
| `pnpm host:check`、`pnpm host:recovery:check` | 待执行，尚无本轮宿主完整结果 |
| `git diff --check` | 五份文档交接检查退出0，所有相对链接有效、无行尾空格；最终门禁再核 |
| 正式 DSH 重载、认证 HTTP、构建 hash、会话／活动状态 | 待实时核验旧进程与活动后再操作；目前不能宣称已重载本轮 |

最终命令结果、全套数量、正式重载 PID／会话核验将在实际完成后追加。持续优化目标保持 active；局部模拟不代表正式模型故障、Token费用或真实 UI 完整验收。

## 最终门禁与正式重载

上节保留文档交接时的状态；以下是之后实际执行的最终结果。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1060/1060，204.29s，异步警告0 |
| `pnpm release:check` 第一次 | 1060/1060，287.50s，离线 doctor／pack 通过，异步警告0 |
| `pnpm release:check` 第二次 | 1060/1060，285.78s，离线 doctor／pack 通过，异步警告0 |
| `pnpm host:check` | exit0，4.33s |
| `pnpm host:recovery:check` | exit0，10.63s |
| `git diff --check` | exit0 |

三次完整套件的失败、取消、跳过均为0。离线 doctor 的5项正式 Codex 检查按契约 skipped，不能据此声称真实 provider 故障或费用已经验证。门禁记录位于 `%TEMP%/dsh-thirtyfourth-final-gates-f6f1667d-53d8-40f2-b8c0-cb722049ac26/summary.json`。

重载前复核正式进程31516的启动路径及活动：411会话、runningIds=[]、waitingWorkflowCount=0。本轮9个源文件及12个冻结构建文件 SHA256 无变化，profile 的插件 Junction 仍指向本仓库。只停止已核验的正式 DSH 进程树，再用同一入口和参数隐藏启动；未修改 profile、provider、凭据或历史 corrupt 会话。

重载后实时核验：旧 PID31516 已退出；PID59600 监听 `127.0.0.1:3080`；认证 HTTP200，页面标题 `DeepSeek Harness`，stderr fatal 匹配0。411会话数量不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` 的 metadata 存在；runningIds=[]、waitingWorkflowCount=0。正式 receipt 保存16个运行模块构建哈希；本轮改动已经随新进程加载。

证据：`%TEMP%/dsh-thirtyfourth-reload-receipt.json`、`dsh-thirtyfourth-formal-metadata-before.json`、`dsh-thirtyfourth-formal-metadata-after.json`、`dsh-thirtyfourth-source-freeze.json` 与 `dsh-thirtyfourth-build-freeze.json`。第三十三轮基线保全于 `%TEMP%/dsh-thirtyfourth-baseline-60655754-3efe-4c03-9c04-3f4bcf97658d/`，其中依赖 Junction 仅供诊断，禁止递归删除该目录。

同会话 continuation 已通过真实 SDK／原生 DSH service 的本地协议回归。本轮未在正式会话注入模型故障或测量真实 Token 费用，也不能重新挂接进程已经丢失的历史 ephemeral 线程。持续优化目标保持 active。
