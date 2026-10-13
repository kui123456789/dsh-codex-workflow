# 第三十五轮：恢复与清理只使用原远端线程 owner

本轮验收过程的完整结果和测试观察方式调整见文末；交接时的待验收记录保留。

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。本轮完整门禁通过，正式 DSH 已从 PID59600 重载至 PID75844，411会话与原父会话保留。最终实时证据见文末。保留全部既有修改、历史数据与配置，没有 commit/push/发布。

## 已复现的边界

第三十四轮将 ACK 回执绑定原运行；取得 ACK 的 RPC 也必须绑定原连接。下列探针使用真实 SDK、原生 DSH child、SQLite 和独立本地协议进程。公开 ID 的复用由夹具主动构造，不宣称生产 CLI 的 UUID 已发生碰撞。

| Evidence | Finding | 本轮处理路径 |
|---|---|---|
| 原 A 后端及捕获进程树实际退出；B 复用 thread/turn 后，旧 A 的公开 resume/cancel/stop 均发 interrupt 并 unsubscribe B，三例 RED；不同 thread 文本控制 GREEN | 字符串地址加“当前 SDK 有线程”无法选择原远端执行 | 保存原实际 ChildProcess 与线程注册 owner；只清原资源 |
| 普通等待 Planner 的原进程退出后，status 错报可继续，resume 在 B 发 readable/status 两回合并进入 executing | 原 child/run 尚存在不等于原 App Server 上下文可用 | status/resume、Planner input/checkpoint 和模型入口共同校验 owner |
| Bridge 等待 Reviewer 同地址替换后仍报告可继续，恢复在 B 执行 readable/verdict/私有 alignment 并清其订阅 | 保留 Reviewer 对象仍可能错误路由到新进程 | 后台操作、重试、转换及 release 保存原 owner |
| 冻结旧 Reviewer 与计量测试分别复现三例 RED；A 的历史 100 被 B 的 900 覆盖 | 按 thread 文本读取计量，或按文本释放 binding，会污染后继来源 | snapshot、source 绑定与 release 精确匹配 owner |
| 首次修复后的真实 Observer/SQLite：迟到 A.bind 使 B 的新 1000 通知遗漏为 900；等待 drain 的 B.bind 将已接纳 C 的 model-C 改为 mixed | 只防错误读数不足以防迟到绑定驱逐或改写新来源；读数遗漏和模型归属丢失会破坏 Token 统计及后续费用分析 | bind 入口及每个 await 后重新校验原 owner，拒绝 retarget |

本地证据位于独立 TEMP：`dsh-thirtyfifth-process-generation-probe.results.json`、`dsh-thirtyfifth-owner-audit/normal-waiting-results.json`、`dsh-thirtyfifth-reviewer-usage-owner-frozen-red.log`、`dsh-thirtyfifth-callback-thread-owner-red.log` 和 `dsh-thirtyfifth-usage-binding-owner-red.log`。公开文档不附正式聊天、认证信息或宿主 stdout。

## 实现与边界

- SDK 每次 thread start/fork/resume 注册独立 opaque owner，关联实际 ChildProcess；同进程重新注册同一文本也失效旧 owner。`captureThreadOwner()` 返回当前能力，`expectedOwner` 不发送到上游或写入工作流记录。
- 模型预备、turn/review、native answer、interrupt 和 unsubscribe 在发送前及异步交接后核原 owner。模型目录准备的控制请求也保留原进程上下文；旧注册不能清新缓存或关闭新进程。
- `CodexTurnInterruptionError.originalThreadOwner` 不可枚举。Planner、Reviewer、私有种子、后台回调、active turn 和 checkpoint 保留各自 owner；原确认回执与 SQL session/token/epoch 继续独立校验。
- 原进程不可用时，普通 status/resume 报原线程不可用。终止清理仍需原 ACK 或捕获的整个原进程树退出；完成后只释放原 child/pin，不能向同地址 B 发补偿 RPC。
- 计量保存每个原来源的历史快照，当前 B 通知只归 B。迟到 binding、drain 和 release 必须保留后继绑定及模型归属。

合法的新业务审查仍可创建新 Reviewer。已经启动而丢失的 ephemeral 审查不能从持久 request/evidence 伪造恢复；持久队列及已验证结果的交付保持原恢复契约。自动 continuation 预算、provider 和错误分类未扩展。

## 研究采用

[固定源码研究](../research/github-original-rpc-transport-ownership-patterns-2026-10-06.md)核对 vscode-jsonrpc 的 connection/pending/cancellation 闭包，以及 gRPC 捕获 stream/transport、取消后停止退避 attempt 的机制。分别固定 MIT 与 Apache-2.0 来源，未复制实现或添加依赖。上游测试只读，未执行；本地 wire/process 与原生会话证据负责证明本项目行为。

## 已执行的局部验证

| 范围 | 实际结果 | 证明边界 |
|---|---|---|
| 新 SDK owner 与原 cleanup-only 组合 | 22/22 | 当前 owner 控制、复用地址、native reply、缓存和 await fences |
| 原 SDK 与 usage-accounting 组合 | 48/48 | 原协议、停止、闲置生命周期、转换及计量兼容 |
| 初始冻结恢复/计量矩阵（补强 bind 前） | 84/84 | Planner/Reviewer/callback、原 owner 控制与此前计量隔离；不能代替后续修改验收 |
| 新计量 binding 回归 | 两例真实 RED → 2/2 GREEN | B 的 1000 与 C 的 2100 通知被保存；C 的模型归属和单来源保持，旧来源没有新增污染 |
| binding、Reviewer、持久 usage 与 callback 组合 | 25/25 | 补强 bind 后再次验证当前来源、后继绑定和旧控制兼容 |

## 最终验收待执行

运行并保存 `pnpm typecheck`、`pnpm verify`、两次 `pnpm release:check`、`pnpm host:check`、`pnpm host:recovery:check` 和 `git diff --check` 的实际退出状态、测试数量及警告。本文不预估完整套件数量。

完整门禁通过后，先复核正式进程、监听、运行会话及等待工作流，再按受控脚本重载。记录新 PID、认证 HTTP、插件 metadata、会话数量、原父会话存在性与浏览器检查。当前没有本轮正式重载或全套验收成功的声明；最终执行者须将真实结果追加于此。

## 验收中的测试观察改进

第一轮完整 verify 为1082/1085：三例旧状态探测测试发现无计量时新增多余可用性查询。保留真实 SDK 的 owner 校验，同时恢复有限 gateway 的按需查询；组合45/45通过。第二轮为1081/1085，四例 Bridge 测试超过固定5秒状态观察窗口；三套单独及并行复验均17/17通过。此时可用物理内存实测0.56–0.71GiB，不能据此推断当时被 finally 取消的原任务后来均已完成。

测试启动器新增 `DSH_WORKFLOW_TEST_CONCURRENCY=1..4`，默认4，本机后续完整门禁选2。Context7 官方 Node 文档确认该参数只限制并行文件，不改变单场景并发或筛掉文件。原115个测试文件、1085项测试及业务超时不变。非法值0实际退出2；启动器和贡献指南已经同步。

并发2的完整 verify 首次1085/1085通过（594.02s）；随后第一次 release 的持久计量测试仍因短观察窗口得到 sending，1084/1085。为验证原因，在原模型 admission 前加入受控6秒门闩：旧5秒 poll 在约5783ms判失败，但原进程、一个已接纳任务仍在；不重发或恢复，约10725ms原任务真实 received、释放租约并保存原240 Token。此受控证据不推广到之前所有超时场景。

新增 `test/fixtures/workflow-background-settlement.ts`，四个最终状态测试等待本 fixture 已接纳的原后台 promise 与 finally 资源屏障，然后一次读取并运行原状态、租约、child、模型次数和计量断言。作用域／租约拒绝保留原 allSettled 语义；故意阻塞的在途 sending 仍使用已有 entered 门闩。看门狗采用 fixture 已有完整操作预算，只提供安全诊断，不触发新任务、模型调用或重试。

同一受控6秒场景改进后约8067ms真实完成，received／租约释放／240计量保持；四套组合29/29通过，typecheck／diff通过。证据位于 `%TEMP%/dsh-thirtyfifth-background-settlement-probe/` 的 red／green log及trace，以及 `dsh-thirtyfifth-background-settlement-target-green.log`。运行时14个源文件在观察改进阶段哈希不变。最终完整门禁正在以并发2重新执行，实际结果另行追加。

## 最终门禁与正式重载

以上保留交接与诊断时的状态；以下是修改测试观察后实际完成的最终结果。三次完整套件均运行115文件、1085项测试，文件并发2，原场景内部并发、断言与业务超时不变。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1085/1085，447.52s，异步警告0 |
| `pnpm release:check` 第一次 | 1085/1085，451.73s，离线 doctor／pack通过，异步警告0 |
| `pnpm release:check` 第二次 | 1085/1085，438.64s，离线 doctor／pack通过，异步警告0 |
| `pnpm host:check` | exit0，3.97s |
| `pnpm host:recovery:check` | exit0，9.43s |
| `git diff --check` | exit0 |

完整套件的失败、取消、跳过均为0；离线 doctor 的5个正式 Codex 检查按契约 skipped。记录位于 `%TEMP%/dsh-thirtyfifth-final-gates-22bb487f-21f3-4133-9fb9-516d75f3512a/summary.json`。旧失败日志保留，不替换为最终通过日志。

重载前核验正式PID59600的入口与参数，411会话、runningIds=[]、waitingWorkflowCount=0。运行时14个源文件、14个冻结构建文件，以及启动器／最终观察测试的7个文件哈希均匹配。仅停止已核验的正式 DSH 进程树，并按原入口、profile及参数隐藏启动；未修改 provider、凭据或历史 corrupt 会话。

重载后实时核验：旧PID59600已退出；PID75844监听 `127.0.0.1:3080`，认证HTTP200，页面标题 `DeepSeek Harness`，stderr fatal匹配0。411会话数量不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata存在，runningIds=[]、waitingWorkflowCount=0。正式receipt的18个运行模块构建哈希再次核验，全部一致。

证据位于 `%TEMP%/dsh-thirtyfifth-reload-receipt.json`、`dsh-thirtyfifth-formal-metadata-before.json`、`dsh-thirtyfifth-formal-metadata-after.json`、`dsh-thirtyfifth-source-freeze.json`、`dsh-thirtyfifth-build-freeze.json` 与 `dsh-thirtyfifth-verification-files-freeze.json`。第34轮基线保全于 `%TEMP%/dsh-thirtyfifth-baseline-ac475e90-fb76-4fae-8499-111b12f451ca/`，依赖 Junction 仅用于冻结诊断，禁止递归删除该目录。

本轮证明本地协议、真实SDK及原生DSH service下的原线程继续、拒绝错用新进程、原回合清理和计量归属。正式会话未注入模型故障，未测量真实Token费用或声称CLI UUID实际复用；认证页面与metadata检查不等于完整交互UI验收。持续优化目标保持 active。
