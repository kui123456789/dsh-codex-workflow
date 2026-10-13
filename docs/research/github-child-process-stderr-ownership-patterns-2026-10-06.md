# 子进程 exit/close 与 stderr 错误归属：固定来源研究

日期：2026-10-06。范围：iteration 40，一手源码研究及主执行方提供的本地受控 RED；不表示生产修复已完成。Node 实际目标版本为 24.14.0。本轮不重新研究 iteration 39 的 PID 身份，不涉及真实 provider 调用、配置修改、依赖安装或正式 DSH PID 89732。

## 结论与证据范围

`ChildProcess` 的 `exit` 证明该进程结束，不能证明其 stdout/stderr 已关闭或已完成排空。`close` 在进程结束且该 child 的 stdio 关闭后发出；共享 stdio 可使这两个时间不同。旧 child 的尾部数据仍属于旧调用，不能追加到已重连的新 child 缓冲，也不能改变新连接的错误分类；这不要求退出后继续无损保存其全部输出。

Node 自带 `execFile` 和 execa 都把 child、streams、缓冲和错误保存在单次调用的上下文中；execa 还明确保留原始错误为 `cause`。这些来源用于解释主执行方已复现的受控场景，**不表示生产实现已采用、真实上游错误已确认或自然 idle 必然触发该缺陷**。外部官方测试只读取，未执行。

## 固定来源与许可证

仅实际研究以下两个代码仓库。原文、测试和实际 LICENSE 均保存在本 TEMP 目录。

| 来源 | 固定版本 | 许可证与范围 |
| --- | --- | --- |
| [nodejs/node，v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a) | `f657bb8ed86365ff3fdbe32e27563e778b41486a`；2026-02-23T23:51:55Z；`2026-02-24, Version 24.14.0 'Krypton' (LTS)` | 所研究 Node 自身代码为 MIT；[实际 LICENSE](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/LICENSE) 另列随附第三方组件许可，不能把整个发行包笼统称为只有 MIT |
| [sindresorhus/execa，10.0.1](https://github.com/sindresorhus/execa/tree/8017b279e19347efaf2587711c2d57dbd4330740) | `8017b279e19347efaf2587711c2d57dbd4330740`；2026-07-31T02:10:08Z；`10.0.1` | [MIT](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/license) |

Context7 已按 `resolve-library-id("Node.js")` → `/websites/nodejs_latest-v24_x_api` → `query-docs` 核对 exit/close/error 的相互关系。检索目标为 v24 系列；下述源码及测试结论固定到实际 24.14.0 提交，不把最新文档误称为该补丁版本的测试结果。GitHub 通过 agent-reach 的 `gh` 后端只读获取，无登录或仓库写操作。

## Node：exit 之后还有 stdio 生命周期

- [`doc/api/child_process.md:1456–1460`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md#L1456-L1460)：`close` 在进程结束且 stdio 关闭后发出，可能多个进程共享同一 stdio；其顺序在 exit 后，或启动失败的 error 后。
- [`:1521–1530`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md#L1521-L1530)：error 可来自启动、终止、发送消息或 signal abort；其后可能有也可能没有 exit。监听两者时必须防止重复执行结算。不能将每一个 error 都当作某个新连接已终止的证明。
- [`:1545–1551`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md#L1545-L1551)：exit 发出时 stdio 仍可能开放。
- [`lib/internal/child_process.js:270–305`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js#L270-L305)：原 process handle onexit 更新原 child 的 exit/signal 值，销毁 stdin，发出 exit/error，再以 nextTick 调用 `flushStdio` 并推进 `maybeClose`。这说明 exit 回调中的清理与后续排空有不同阶段。
- [`:450–458`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js#L450-L458) 与 [`:1096–1101`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js#L1096-L1101)：输出 socket 的 close 回调推进同一 child 的关闭计数；满足该 child 的所需计数才 emit close。不能拿另一个 child 的 close 结算前一个 owner。

### 自带 execFile 的诊断归属

[`lib/child_process.js:349–424`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/child_process.js#L349-L424) 在每次 `execFile` 调用内捕获局部 `child`、`_stdout`、`_stderr`、`ex` 与一次性 `exited` 门。[`492–522`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/child_process.js#L492-L522) 的 stderr data 回调仅累积该调用的数组，并施加 maxBuffer；普通退出通过该 child 的 close 汇总缓冲构造结果或错误。

不能声称所有错误都等待 close：[`427–436`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/child_process.js#L427-L436) 的 error handler 保存原错误、销毁该 child 的输出并直接进入结算。可借鉴的是原 child 与缓冲/错误闭包一致，以及结算一次；不应复制完整 execFile 的等待、销毁或 maxBuffer 策略到长连接 RPC。

## execa：同次调用的 process、streams、结果与 cause

- [`lib/methods/main-async.js:85–140`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/lib/methods/main-async.js#L85-L140)：每个 spawn 持有局部 subprocess、捕获的 `originalStreams`、controller/context，并将这些作为同一次等待的参数。
- [`lib/resolve/wait-subprocess.js:41–125`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/lib/resolve/wait-subprocess.js#L41-L125)：该 subprocess 的 exitPromise 与 stdio 结果分别等待；成功同时收齐，失败保留触发的 error、该 exit 与已缓冲输出。没有从一个可被新进程覆盖的全局 stderr 字段重建原错误。
- [`lib/resolve/stdio.js:19–46`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/lib/resolve/stdio.js#L19-L46)：输出读取和 stream 结束分别等待。原始 streams 和变换后的 streams 也被明确区分，不能仅见到 process exit 就断言诊断完整。
- [`lib/return/final-error.js:1–6`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/lib/return/final-error.js#L1-L6)：新包装错误把原始错误保存在 `cause`；内部仅用于中断控制流的 `DiscardedError` 是明确的例外。
- [`lib/return/result.js:168–170`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/lib/return/result.js#L168-L170)：code 来源于该包装错误的 cause，stdout/stderr 来源于该调用的 stdio 结果。消息、结构化 code/cause 和输出是相互关联但不同的证据。

execa 并不是本仓库的重连 RPC 实现，其每次调用隔离不能代替本地的连接替换探针；这里不引入 execa 或其依赖，也不照搬 stream 内部 hook、全部 promise 编排或取消策略。

## 官方测试的真实性与限制

| 测试 | 所读断言 | 限制 |
| --- | --- | --- |
| [Node `test-child-process-flush-stdio.js:10–32`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/parallel/test-child-process-flush-stdio.js#L10-L32) | 实际 echo 子进程；在 close 确认退出并检查 readable 收到的完整 `123` | 不是旧/新 RPC 连接或晚 stderr 分类测试 |
| [Node `test-child-process-stdout-flush-exit.js:26–60`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/parallel/test-child-process-stdout-flush-exit.js#L26-L60) | 实际子进程立即 exit，close 时检查 stdout 开头与结尾 | **源码明确该缓冲表现不是 API 契约保证**，不能用于承诺任意输出必然保全 |
| [Node `test-child-process-spawn-error.js:29–55`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/parallel/test-child-process-spawn-error.js#L29-L55) | 实际不存在的命令，无 pid/no spawn，error 保存 ENOENT/syscall/path/args | 启动失败证据，不是 provider 权限失败或新连接错误 |
| [Node `test-child-process-stdio-reuse-readable-stdio.js:1–34`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/parallel/test-child-process-stdio-reuse-readable-stdio.js#L1-L34) | 实际 cat/head 共用 pipe，head exit 后仍读取 cat 输出 | 官方测试跳过 Windows；不能当作当前 Windows 验收 |
| [execa `test/resolve/buffer-end.js:40–77`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/test/resolve/buffer-end.js#L40-L77) | 实际 fixture 子进程，成功/失败、直接读等场景均保存 stderr/stdout，完成时输出 stream destroyed | 部分用 100ms delay；不复制该计时到本地确定性探针，不证明连接替换安全 |
| [execa `test/return/final-error.js:41–69,91–108`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/test/return/final-error.js#L41-L108) | 同一旧 error 可被下一调用包装；新对象不同且 cause 仍指向旧 error；取消 cause 留存 | 启动实际子进程，但 error 事件是显式 emit；不是实际上游权限错误 |
| [execa `test/resolve/wait-error.js:10–43`](https://github.com/sindresorhus/execa/blob/8017b279e19347efaf2587711c2d57dbd4330740/test/resolve/wait-error.js#L10-L43) | 实际 fixture，主动销毁/报错 stream，包装结果 cause 为注入原对象，exitCode 可为 0 仍 failed | 注入 stream error，不证明操作系统或 provider 自发失败 |

## 主执行方提供的本地受控 RED

以下事实来自主执行方的实际 trace，本研究员没有运行或复演该探针。

| 时间或观察 | 实际结果 |
| --- | --- |
| `2026-10-06T13:35:36.274Z` | 旧 Node A，PID 84800，发出 exit |
| `2026-10-06T13:35:36.332Z` | 新 Node B，PID 62540，启动 |
| `2026-10-06T13:35:36.333Z` | 实际 A stderr 晚数据到达，65536 bytes（64 KiB），当时 SDK 当前 child 已是 B |
| B 的失败结算 | B 自身 stderr 为 0，退出码 42；其公开 pending 错误为 16424 bytes，含 A 的旧 marker |

探针受控暂停实际 Readable，在校验 A 的 PID、parent 和 birth 后实际终止 A，使被阻塞的旧 stderr 得以继续交付。它没有通过 `emit` 伪造 Node 的 exit/data 事件。该结果证明这个受控时序中存在旧 A 数据污染 B 错误正文，不能推导自然 idle 必然产生同样时序，也不能将 marker 内容宣称为已验证的真实 provider 权限失败。

原脚本需手动终止旧 A 才能解除阻塞；主执行方随后建立了 Flood ACK 后针对 exact child 终止的自动回归。完整回归及生产验收结果由主执行方另行记录；本文不以这段 RED 证明修复已部署、取得所有 close/ACK 或真实模型结果。本地 RED 与前述外部官方测试的读取是两类证据。

## 本地验证目标与范围

下表是覆盖目标，不是全部用例已执行或通过的声明。本研究员没有运行这些探针；已取得的本地 RED 由主执行方提供，见后文。不把正常 stdout 测试当作本地连接替换测试。

| 本地场景 | 应观察的结果 |
| --- | --- |
| 原 A exit 后，其 stderr 尚有数据，B 已初始化 | A 的晚数据留在 A 的有界诊断上下文；B 的 stderr、错误分类、初始化与待办不被 A 改写 |
| A 写出 `permission denied`，B 是正常连接或不同错误 | A 的原 cause/诊断不能重建成 B 的连接错误；B 不因 A 的文本被误判为权限终态 |
| 已开始排空 A，但 B 新增 pending RPC/turn | A exit/error/close 的结算只作用于 A 已拥有的原待办，不能拒绝或清除 B 的待办 |
| A error、exit、stdio close 相继到达 | A 的失败/清理结算一次，原错误保留；无需再次调用模型，不能重复关闭 B |
| stderr 分块、UTF-8 边界和缓冲上限 | 按同一原 owner 解码和截断；诊断有界，既有隐藏/脱敏规则保留，不记录凭据 |
| 共享 stdout/stderr 被后代持有，close 延迟 | 区分 exit 与诊断完整度；遵守现有 operation deadline、abort/stop 优先级，不无限等待 close 或增加模型预算 |
| 原 A 失败且没产生可用 stderr | 保留可验证的原 error/code/cause；不借 B 的文本补全，不伪造权限或连接根因 |

## 本轮最小设计边界

可以比较两种局部模式：在 spawn 时捕获原 child 的独立有界 stderr 缓冲和终态数据；或为最终诊断在既有截止时间内等待该原 child 的输出结束。选择必须以本地实际丢失/串写证据为依据。及时拒绝原 RPC 与完整诊断的取得是两个阶段，不应通过等待所有 close 无限制延长工具调用。

一次性结算和异步回调都应保留实际 owner。晚事件可补充旧 owner 的诊断，但不能取得新 child 的模型执行、状态或取消权限。`error.cause` 与诊断正文也不应被新的连接状态反向重写。本文不建议整体框架替换、增加依赖或改 provider/model 配置。

本轮 SDK 修复候选仅限绑定原 child 的局部有界 stderr 诊断；保持既有错误前缀、`slice(-16_384)` 尾部限制与 exit 结算策略。这个限制沿用字符串单位，不能宣称任意 UTF-8 内容都严格限制为 16 KiB。当前受控 RED 没有要求引入 Decoder、修改错误分类或调整模型预算，本文不将这些额外改动列为已采用方案。
