# 第38轮：RPC结算回收与原stdin迟到错误

日期：2026-10-06。仓库 `D:/工作文件/projict/dsh-cc/dsh-codex-workflow`；HEAD保持 `abb6174`，保留已有修改，不commit/push/publish。上一轮已完成修复、1117/1117三次完整门禁和正式DSH44296重载，属于实际progress。本轮从当前源码与运行态继续；正式provider与历史会话不作故障注入。

## 实际反馈与缩小范围

本轮最初检查stdin读端关闭。两次独立Node上游的 `process.stdin.destroy()`／fd0 `closeSync`＋EBADF观测，都只产生正常RPC timeout，没有未捕获EPIPE。文件描述符关闭不能当作整条Windows原生pipe关闭，本轮保留该negative，不据此修改活进程退休或恢复策略。

| 反馈环 | 修复前实际证据 |
|---|---|
| 真实SDK＋原held-thread fixture，thread/start超时500ms | pending已0，但未取消caller的abort listener从0变1，client.stop后仍1；原PID73960实际退出：RED |
| 独立SDK worker＋暂停读取的真实Node上游，4MiB JSON | writableLength4194362，needDrain=true，pending1；stop先以stopped结算原请求并确认OS子进程退出，随后原Socket的write EOF未捕获，SDK worker默认exit1：RED |
| 正常上游 | 小请求正常完成；后续仓库回归确认真实4MiB写入也能在普通背压下完成 |

超时探针：`pnpm exec tsx "$env:TEMP/dsh-thirtyeighth-rpc-timeout-listener-red.mts"`；原管道探针：`node "$env:TEMP/dsh-thirtyeighth-queued-write-stop-probe.mjs"`。它们驱动真实SDK与本地协议，不patch stdin.write，不调用正式模型。`uncaughtExceptionMonitor`只采证，保留Node默认fatal行为；只处理被验证属于本次actor的诊断PID。

## 固定研究与最小采用

[vscode-jsonrpc与MCP固定源码研究](../research/github-stdio-write-failure-patterns-2026-10-06.md)记录16处源码／官方测试引用及许可边界。vscode的RequestWriteFailure测试检查pending撤销和取消登记一次清理；MCP server处理write/error/drain，但child client的send不拥有同等保障，不能泛化。未复制框架或增加依赖。

通过Context7 resolve Node.js后query `/nodejs/node`核验Writable契约：write callback的异步error在error事件之前，false表示backpressure。当前实际Node24.14.0。本轮通过原stdin的常驻error listener消费错误，保持已有RPC响应语义，没有把本地写入或流关闭当成远端ACK。

唯一生产改动 `src/app-server.ts`：

- 每个RPC的原entry使用once finish，精确匹配原map项后删除pending、清timer并off原signal；response/error/timeout/abort/stop和同步write throw共用此路径，保留原cause。
- onLine调用entry.resolve/reject，由entry自己完成清理；旧callback不重结算请求，只有原ChildProcess仍current时才能安排idle。
- stdin error handler捕获原ChildProcess；当前child的error沿已有failProcess传播，已stop/detach或旧A的迟到事件仅被消费，不清B的缓存、thread owner或等待者。

不主动退休仍活的后端，不修改全进程树门禁、原线程continuation、自动继续次数或用户侧恢复路由。

## 持久回归与当前验收

新增 `test/rpc-settlement-cleanup.test.ts` 五场景：初始1RED/4GREEN；新stdio三场景使用真实协议、独立actor和自然退出，包含健康大写入、queued-stop及late A／successor B控制。没有强制exit0掩盖晚错误。

主任务在精确备份38源码之后，短时恢复37源码运行持久组合，实际8场景为3RED/5GREEN；finally按完整文件字节恢复38源码，SHA256 `4D1E8B51042F0C8288A4D89B7661EE89F95592FC88675FA279F33FCD051B1BB0`。生成lib和正式44296均未改变。证据 `dsh-thirtyeighth-guarded-regressions-red.log` 与 `dsh-thirtyeighth-guarded-source-restore.json`。

恢复38源码后，RPC／stdio／共享初始化／模型目录／原thread owner／模型timeout组合37/37 GREEN，typecheck通过。原standalone管道复验默认worker exit0、无uncaught、stopped cause保留且原PID退出，原报告label为OBSERVED，不能替代持久测试的严格断言。

基线 `%TEMP%/dsh-thirtyeighth-baseline-166b4759-a5b3-4e46-9ebd-288e5486d25d` 保存源码、构建、测试、脚本和文档，没有新建dependency Junction。更早基线含Junction，仍禁止递归删除。完整门禁与正式重载待追加；不以第37轮结果冒称本轮完成。真实provider故障、Token费用与完整浏览器UI未实测，持续优化目标保持active。

## 冻结与独立审查

新stdio回归3/3 GREEN，actor自然退出并观察最后一次event loop，不以强制exit0掩盖晚错误；原诊断PID均为ESRCH。测试SHA256 `FD27AA031D2E541489759A2BCE1384F8317892307439E0FA0CA6392C3828F832`，actor `66AAA6B506A022183E38EE5C1CB73CFABCFE0A3281A95B43F4ADC21182F84806`，fixture `F46CA4C61A3FE070E64A3856538DE6CE044370DFC7192E5ED90807000A37AE82`。

只读peer确认恢复后的源码SHA完全匹配，检查once entry CAS、Map迭代删除、late response/error顺序、current owner的idle安排和旧stdin消费；未发现可达新增风险，没有执行额外测试或修改文件。

全部71个source与138个test/fixture已冻结到 `%TEMP%/dsh-thirtyeighth-source-freeze.json` 和 `dsh-thirtyeighth-test-freeze.json`；相对37基线唯一生产变化为app-server.ts。完整120个测试文件以文件并发2开始门禁，原场景内部并发与断言保持；门禁目录 `dsh-thirtyeighth-final-gates-a7897449-6e9b-4a95-9518-fac677a26d78`。正式44296尚未重载，最终结果待追加。

## 首轮门禁与未复现的退出等待失败

初轮verify实际1125/1125、312.26s，release第一次1125/1125、385.77s；release第二次1124/1125、400.13s，失败1，取消／跳过／异步警告0。保留该目录summary与完整日志，不删失败或改等待条件。

唯一失败为 `test/thread-owner-cleanup.test.ts:32` 的 `old terminal resume cannot interrupt or unsubscribe a reused address in a new SDK process`：`Shared Reviewer fixture did not reach the captured original process tree exited`。该步骤在创建对照B、调用旧resume之前，因此本次失败不证明旧恢复影响了新进程；原日志没有具体仍存活PID，原因尚未确证。

原用例单独复验1/1 GREEN，之后最多五次TEMP诊断副本均GREEN，约3.0–3.6s。诊断逐个过滤原capturedPID，保存PID／PPID／CreationDate／exe；捕获树均为原Node及conhost子进程，退出后均ESRCH且身份查询为空。没有全进程调查、源码／仓库测试／超时修改，也没有把重跑通过当作根因已修复。

诊断日志 `%TEMP%/dsh-thirtyeighth-captured-tree-run1.log` 至run5；原单例日志 `dsh-thirtyeighth-terminal-resume-gate-probe.log`。以相同冻结源码补跑连续两次release、host与diff门禁，目录 `dsh-thirtyeighth-revalidated-gates-a8b5250f-4c05-46ea-ab9e-4d1958e3536f`。正式44296仍运行，重载待复验结果。

## 重复失败后的诊断与最终验收

上述补跑release再次实际1124/1125、334.01s，唯一失败改为old terminal stop，同样发生在原tree退出等待，未创建B。两份失败目录均保全，不把它们写成通过。随后仅修改 `test/thread-owner-cleanup.test.ts` 增加失败现场诊断：before退出保存过滤后的原PID／PPID／CreationDate／exe，catch原15秒wait失败时记录alive PID与原ChildProcess exitCode／signalCode，然后重抛原错误。没有修改断言、15秒期限或生产代码。

可能的PID复用、历史PPID假边或原conhost退出延迟均未确认；一次当前只读快照未见假边，不能补造历史现场。诊断版完整verify及后续两次release均通过，仍不称两次等待超时的根因已修复。保留诊断供再次发生时判断，最终测试冻结SHA `9143E0222586E3AECD4A712E56616423E532CB600438B0ADB8739FF6B7E711D3`。

| 最终检查 | 实际结果 |
|---|---|
| 诊断版 `pnpm verify` | 1125/1125，exit0；test runner304.17s |
| 连续 `pnpm release:check` 第一次 | 1125/1125，352.80s |
| 连续 `pnpm release:check` 第二次 | 1125/1125，344.08s |
| `pnpm host:check` | exit0，4.12s |
| `pnpm host:recovery:check` | exit0，7.08s |
| `git diff --check` | exit0 |

最终三次完整套件失败、取消、跳过、异步异常均0，两次doctor／pack审计和tarball清理通过；5项正式Codex检查按offline契约skipped。诊断版verify日志为 `%TEMP%/dsh-thirtyeighth-process-identity-diagnostic-full.log`，连续release及host结果为 `dsh-thirtyeighth-final-after-diagnostics-gates-5342c6ee-f624-42b0-93bc-7c6be029b093/summary.json`。首次失败与复验记录按各自真实结果列出。

## 正式重载与保全

重载前重验71个source与最终138个test/fixture冻结哈希，差异0；211个构建文件保存到 `dsh-thirtyeighth-build-freeze.json`。旧44296入口、监听及实时活动确认：411会话、runningIds=[]、waitingWorkflowCount=0。随后仅停止该已确认的进程树，用原profile／参数隐藏启动86052。

实际结果：旧44296退出，新86052监听 `127.0.0.1:3080`，认证HTTP200；411会话不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata保留。111条workflow的有序整体SHA256重载前后相同，历史故障会话未改。211个构建文件与receipt的19个模块哈希匹配，stderr fatal匹配0，当前runningIds=[]／waitingWorkflowCount=0。

证据 `%TEMP%/dsh-thirtyeighth-reload-receipt.json`、`dsh-thirtyeighth-formal-verification.json` 与formal-metadata-before/after.jsonl。没有修改provider或凭据、执行正式模型故障注入、测量实际Token费用或完整浏览器UI验收。本轮确认的RPC监听器泄漏与queued-stop未捕获EOF已修并部署；原tree等待的两次间歇失败原因仍待后续现场，不冒称该根因已修复。持续优化目标保持active，未commit/push/publish。
