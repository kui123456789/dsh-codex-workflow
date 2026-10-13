# 第二十三轮：Reviewer 恢复句柄的原始身份

## 实际故障

Planner 句柄有原身份，Reviewer 原先仅保存 thread、child、input 和 evidence。真实 reviewOnly 两次失败进入等待后，分别更改 task、model、effort、attempt，再查询 status 并调用 resume/review，**8 项红例**都得到 available=true、公开操作成功、额外 3 次模型调用，原恢复对象被消费，child dispose、pin 释放。原线程实际接受了新的记录范围，而 evidence 没变。

主任务独立重跑 9 用例，**8 红/1 原身份正常对照**。后续生命周期补充测试首次运行时源码已经修复，记录为当前绿色覆盖，不冒领旧实现红例。

## 实施

- 新增 `reviewer-run-identity.ts`，捕获原 workflow/session、cwd、task、createdAt、mode、model/effort、waiting phase 和 attempt。对象冻结并只保存在进程内；不把 ephemeral thread id 写入 durable 状态。
- 等待事务成功后从实际 outcome 捕获身份。status、Manager resume、ReviewExecution resume 和显式新 workspace 审查准备共用身份检查；变化报告 identity_changed，缺原身份报告 handle_unavailable/明确异常。
- 在 interruption ACK 后重新检查原身份，先于取消捷径、清 marker 或发送下一 turn。读取变化不能借用当前记录重造“原始”基准。
- 领取 recovery 后到 observation 开始之间发生变化，恢复同一原对象，保留 child/thread/pin，拒绝新模型回合与 replacement 写入。cancel/stop 仍清理原资源一次。
- continuation 正常开始后允许 attempt 递增；如果再次失败，新 waiting 句柄捕获新的合法 attempt，复用同一原 thread/child。
- workspace 真正变化后的显式新审查仍需通过原 scope 验证；仅改 task/model/attempt 不能借此释放旧 Reviewer 并创建替代。

## 证据与边界

```powershell
pnpm exec tsx --test --test-timeout=30000 test/reviewer-recovery-identity.test.ts test/reviewer-recovery-ownership.test.ts test/workflow-resume.test.ts
```

组合 **44/44**，类型检查通过。身份组 9 用例检查 status 与 resume/review 的拒绝、完整 row/revision 和 child history/模型调用/原恢复对象不变；正常对照继续原 model/effort/thread/child，只应用一 cycle。

归属组 5 用例覆盖 public read 窗口 task/model/attempt 变化、实际 interruption ACK 期间 model 变化、已领取句柄后的新 task、缺 identity 以及两次合法 waiting 后同线程成功。stop 连续调用两次仍原 cleanup 一次。它们首次运行即新实现绿色，不声称旧源码实测失败。

最终复核追加第 6 个窄用例：句柄已领取并从 waiting map 移除，真实 owned 读取前更换 owner，新 owner 的公开 cancel 已完成 child cleanup；旧 owned 随后实际拒绝，恢复分支却把 cancelled 原句柄放回 map，pin 未释放。主任务独立锁定红例，随后在恢复前重读当前记录并拒绝 cancelled/已清理 child；修后无 reinsert、pin=0、原 thread/child 各 cleanup 一次，不靠后续 stop 救场。归属组加完整 workflow-resume **36/36**，类型检查通过，普通 caller abort 仍保留原句柄。

旧 recovery-status 夹具此前手造 Reviewer 句柄，没有新 identity，因此 9 个 evidence 测试先停在 handle_unavailable。只在该 fixture 创建时捕获身份，恢复其测试前提；证据、归属、并发和 read-only 断言未放宽。修正后 status/ownership/resume 组合 **66/66**。

[Temporal 固定机制研究](../research/github-resume-identity-fencing-patterns-2026-10-06.md)核验原 execution handle 与当前 workflow-task token 的分层身份/attempt 检查。固定 SDK/server SHA 和 MIT 许可见研究；上游测试只读，未运行。Temporal 并不自动比较本项目 task/model/evidence，原基准由本插件在真实 waiting commit 捕获。未复制源码或增加依赖。

status 不是锁，resume 仍需复查；证据 freshness、权限和取消仍独立生效。未知原身份不重建，原进程丢失不恢复 ephemeral thread。历史 corrupt 不迁移，没有正式模型故障 UI 验收或 Token 估算。完整门禁与正式加载结果另以实际执行记录为准。

## 首次门禁中的 API 负控前提

先前完整 verify 为 **877/878**、异步警告 0；唯一失败是 runtime-smoke 的 API 拒绝对照，在 1000ms 全观察预算内还未到拒绝端点，先返回前置 RPC TimeoutError。失败日志 `%TEMP%/dsh-twentythird-final-gates-4ecb5a43-cfb4-4438-904a-2ddf878b0d28/summary.json` 保留，且此运行未覆盖之后补齐的窄取消用例，不作为最终冻结版验收。

受控 trace 在同样 initial projection 延迟 1200ms 时，1000ms 预算只发送 initial inspection 并超时；既有默认 30000ms 预算抵达 accepted prompt 后的 selected projection，返回精确 gateway/internal 拒绝。历史日志没记录每次 RPC，不宣称其具体超时发生在 initial 还是 prompt。只让该 API 负控使用既有默认预算，并在错误断言前核验完整 4 个请求确实到达目标；原 300ms、确定性 1000ms deadline 用例和生产预算均未改变。

## 全文件调度与剩余租约夹具

上述修改后默认文件并发的完整 verify 得到 **869/879**、异步警告 0：10 个失败集中在无关夹具的 initialize、fixture/waitForInterrupt、submission settle 和保存屏障等待。日志 `%TEMP%/dsh-twentythird-final-gates-a21f568e-d64d-4a13-a482-d6d69580f46e/summary.json` 保留。

只读现场为 16 个逻辑处理器、16GB 内存、约 3GB 可用；没有匹配的残留 test/fake App Server 进程，不批量终止 Node。通过 Context7 查询 [Node 24 CLI](https://nodejs.org/docs/latest-v24.x/api/cli.html#--test-concurrency) 与 test runner execution model，默认最多 availableParallelism()-1 个独立文件进程，本机为 15。file concurrency 不决定每个业务场景的显式并发或跳过文件。

完整 `tsx --test --test-concurrency=4 test/*.test.ts` 对照为 **878/879**、异步警告 0；上述 10 项都通过，剩余一个旧 callback lease-loss 夹具未在等待期收到 B 的完成状态。对照日志 `%TEMP%/dsh-twentythird-bounded-concurrency.log` 保留。`pnpm test` 现默认四个文件进程；所有文件、用例、单场景双管理器与并发断言保留，生产 timeout/lease 未调整。不将该对照写成全通过或普适性能提升。

确定性对照在 B 的 authority 完成后、真实 lease 检查前加入 400ms 停顿：300ms TTL 从剩余 236ms 变为非 owner，B sending/checkpoint pending、queue0；正常 10000ms TTL 剩余约 9508ms 后仍 owner，B received、queue1 且仅 B verdict。两次均真实撤销 A 的 lease，验证 A 取消和迟到结果的业务状态/队列拒绝。原测试的 300ms winner 前提并不成立，不能把 production 拒绝过期写入当缺陷。

仅该夹具使用正常 TTL，实际 release 必须成功、实际取消 predicate 替代固定 500ms，等待 B/A 后台任务真实结束，finally 释放 DeferredCallback 并 await stop 替代固定 300ms。原 received/unapplied/队列 exactly1/B verdict/submissionId/requestId/staged summary 断言全部保留。修改后独立用例通过，类型检查通过；生产 TTL、完整条件等待上限未提高。临时 probe 代码已删除，日志保留。

probe 另观察到迟到 A 可能改变进度字段/revision；这超出原队列/业务状态用例的证明范围，尚未作为本轮已修复声明，后续需定位其 finalizer 路径。Reviewer 新身份用例的完整 replacement row 拒绝仍有独立实测证据。

## 最终冻结门禁与正式重载

最后源码、测试、四文件并发设置冻结后，从头完成门禁：

| 门禁 | 实际结果 |
|---|---|
| `pnpm verify` | **879/879**，156.02 秒 |
| 连续两次 `pnpm release:check` | 各 **879/879**，269.84/294.27 秒；离线 doctor 和包审计通过 |
| `pnpm host:check` | 安装 DSH **0.1.7-rc.2**，九工具、peer/sidebar 契约通过 |
| `pnpm host:recovery:check` | **11/11 场景**，安装服务与 scripted-local 网关，browserUIVerified=false |
| 异步与差异 | 三次全量失败/取消/跳过均 0；全部门禁异步警告 0；`git diff --check` 通过 |

最终日志 `%TEMP%/dsh-twentythird-final-gates-2ccbcba7-0f6b-43ad-bbe5-459fef55291e/summary.json`。相较上轮新增 **15 个回归**。前述失败与对照日志保留，没有结束测试进程，没有正式模型调用。

重载前核验旧 PID **51152** 完整命令/可执行文件、3080 listener 及 409 sessions 无 running/waiting；只重启已确认服务。新 PID **65672**，认证交换 **303**、健康 **HTTP 200**、listener owner 匹配；重查仍 409 sessions，无 running/waiting。

复用 Playwright `dsh-recovery-20261005`，页面标题 **DeepSeek Harness**。唯一 console 错误仍为 wallpaper-engine 背景音频资源 **404**，无 workflow 错误；未改该插件。receipt `%TEMP%/dsh-twentythird-reload-receipt.json` 保存旧/新 PID 及 workflow/App Server/Planner/ReviewExecution 构建 SHA256，token/cookie/旧聊天未输出。

历史 corrupt 未迁移，真实上游模型故障 UI 恢复未由本地脚本或页面健康替代验收。已记录的 Bridge 迟到 metadata 写入仍待后续定位；新 handle 捕获的是记录中的模型选择，未记录的历史/默认实际模型选择不推测，需另行核验其 continuation 设置稳定性。变更留在工作区，未 commit/push/publish，持续优化目标保持 active。
