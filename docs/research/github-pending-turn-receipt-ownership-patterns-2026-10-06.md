# Pending turn receipt：原请求归属与早到错误缓冲研究

日期：2026-10-06。范围：iteration 42，两组固定源码及主执行方的真实 pipe RED；研究员未运行该本地探针，不修改 production/tests/lib、provider 或正式 DSH PID 67176。本文不声称补丁完成、回归 GREEN 或生产已部署。

本轮针对原 native model-start 请求已发送、合法 start receipt 尚未返回时的早到 handler fault。第 41 轮 reader/post-JSON handler 隔离原则仍适用，本篇只展开 pending call 的登记与 receipt 归属；不复制完整框架、不增加依赖或修改 CLI/codec。

## 先区分四个事实

| 阶段 | 已知事实 | 不能由此推导 |
| --- | --- | --- |
| 本地 pending handler/原 call 已登记 | 原 request id、方法及本地 owner 已确定 | 请求已经到达远端，或 remote writer 已启动 |
| 原请求进入原 transport 的发送路径 | 可以将等待/错误绑定原发送调用 | 本地 write/send Promise 完成等于 remote start ACK |
| 原通道收到匹配 response | response 可交给那个原 pending callback | response body 必然是合法 model-start receipt |
| 原请求返回且 start receipt 验证通过 | 可采用该 receipt 给出的合法 thread/turn tuple | 之前坏帧字段也有同等权威，或原 writer 已终止 |

坏帧中的 threadId/turnId 只能作为归属核对的输入，不能凭它构造已启动的 remote writer。请求未返回或 receipt 非法时，writer identity 仍可能未知；这是独立边界，不能伪装成确认 ACK 或可恢复回合。

## 固定来源与许可证

本轮只研究以下两组代码。2026-10-06 只读核查 HEAD 与第 41 轮固定值相同，复用对应源码/实际 LICENSE 快照，避免重复 reader 全文。

| 来源 | 固定提交 | 许可与借鉴边界 |
| --- | --- | --- |
| [microsoft/vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node/tree/b4f995b69c55502f3c41b6501a1057247258e402) | `b4f995b69c55502f3c41b6501a1057247258e402`；2026-10-05T23:43:43Z；`Bump brace-expansion (#1880)` | [实际 License.txt](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/License.txt)：MIT；借鉴原 connection/request callback 的登记顺序 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk/tree/b022522089a0c8b632595c6e7b536453945ed5a9) | `b022522089a0c8b632595c6e7b536453945ed5a9`；2026-10-05T14:38:02Z；`fix(core): reject x-mcp-header on number-typed parameters (#2762)` | [实际 LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/LICENSE)：新 code/spec 与同意重许可贡献 Apache-2.0；未同意历史 MIT 贡献仍 MIT；非 spec 文档 CC-BY-4.0。不能笼统标为 MIT 或只有 Apache-2.0 |

MCP 是 Model Context Protocol 官方仓库，不是 Microsoft 仓库；核心包 manifest 为 2.0.4、license 字段 Apache-2.0，但根 LICENSE 的过渡范围仍适用。本文只总结接口原则，不复制其 driver、取消、重试、timeout 或缓冲实现。

## 当前 API 文档核查

Context7 已执行 `resolve-library-id("MCP TypeScript SDK")` → `/websites/ts_sdk_modelcontextprotocol_io_v2` → 精确查询 Transport.send、request result 与 progress 归属。

当前 v2 文档将 `Transport.send(message, options): Promise<void>` 描述为发送 JSON-RPC request/response；它与返回验证结果的 `request` 是不同接口。官方 loopback 示例也允许先排入 microtask，再返回发送 Promise。文档没有给出“send 完成即远端模型开始”的保证。

固定源码 [`transport.ts:173–188`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/transport.ts#L173-L188) 还要求 transport.start 之前安装 callbacks，以免丢消息。这个顺序原则适用于本地接收能力准备，不是 App Server turn/start receipt 的替代证明。

## VS Code JSON-RPC：原 response callback 先于 write

[`connection.ts:1422–1473`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1422-L1473) 在原 connection 内分配 request id，构造局部 responsePromise 与 cleanup callbacks，然后先 `responsePromises.set(id, responsePromise)`，再 await `messageWriter.write(requestMessage)`。早到的 response 因此已有原请求接收者，不必等 writer Promise 完成才登记。

[`connection.ts:922–939`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L922-L939) 按 response id 取得并移除该原 callback，随后 resolve/reject。写入失败则走原 responsePromise 的拒绝与取消监听清理。

借鉴范围是“原 call 接收状态提前就绪”。源码没有把另一个 notification 的 turn 字段登记为此 request 的权威 receipt；也不能仅因 Promise 单次 settle，就声称所有资源 cleanup 或远端 cancellation 已完成。框架 request id 在 connection 中递增的前提，不替代本项目的 original process/thread owner 校验。

## MCP：预登记请求与显式 progress token

- [`protocol.ts:1438–1454`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1438-L1454)：原请求先分配 messageId；onprogress handler 预登记在该 id，并由发送方写入 `_meta.progressToken`。这是明确的请求相关 token，不能把无等价契约的 App Server frame.turnId 当成这种 token。
- [`protocol.ts:1509–1592`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1509-L1592)：response handler 在 transport.send 之前安装；callback 捕获原 request、codec 与 result Schema，response 到达后仍须 decode/validate，非法结果拒绝该原请求。
- 同一 callback 的 `responseReceived = true` 在 result decode/Schema 成功之前设置。因此这个内部 flag 只说明收到匹配响应，不能直接当作合法 model-start receipt 或已终止 writer 的证明。
- [`protocol.ts:1178–1231`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1178-L1231)：progress/response 只交给已存在的对应 handler；unknown token/id 报告错误，不补造一个原 request。
- [`protocol.ts:1593–1604`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1593-L1604)：完成/失败的 finally 清理那个 request 的 abort listener、response handler 与 timeout。其多回合 result driver 和 timeout 重置策略不属于本轮借鉴范围。
- [`util/inMemory.ts:37–42,62–71`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/util/inMemory.ts#L37-L71)：每个 transport 实例持有自己的 pre-start messageQueue；send 可能同步调用 peer.onmessage。源码明确它用于测试/开发，不能把该内存队列当作真实 OS child/ACK 验收。

## 官方测试的实际性质

外部测试只读取，未执行；以下测试不被汇报为本仓库 GREEN。

| 测试 | 所读断言 | 限制 |
| --- | --- | --- |
| [VS Code single request `236–253`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L236-L253) | response 返回原请求内容 | TestDuplex 内存 stream，非实际 model-start 前坏帧 |
| [VS Code write failure `256–322`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L256-L322) | MessageWriteError、pending 清空、取消 cleanup；strict unhandled rejection 子进程自然退出 | 确有实际 Node worker，但通信使用已销毁的 PassThrough；不是远端 App Server 启动/清理 ACK |
| [MCP progress before result `406–444`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocol.test.ts#L406-L444) | 原请求仍 pending 时 progressToken=0 的通知进原 callback，之后 response 才完成请求 | MockTransport、fake timers、直接 onmessage；不证明真实 pipe 时序或 turn id 权威 |
| [MCP local cancellation `950–993`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocol.test.ts#L950-L993) | initialize abort/timeout 只本地拒绝，其他请求按策略发 cancellation | 证明本地 rejection、发 cancellation、remote ACK 是不同事实；不能替代原 writer 终止确认 |
| [MCP transport A/B handling](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocolTransportHandling.test.ts) | 未完成的 A 请求响应仍发往捕获的 A transport | MockTransport+延迟；原请求接收目标原则，不是本项目 child 生命周期或 owner 校验证明 |

## 主执行方提供、研究员只读核对的本地 RED

证据文件为 TEMP `dsh-fortysecond-before-receipt-feedback.results.json`，11719 bytes，SHA-256 `D8ECB7D255DCCDBF38723259D1B500D4A1AB80E928FF1D984375DDA818761A15`。本轮 1 healthy control、1 bad candidate、harness errors 为 0；旧 SDK 源 SHA-256 `A957FA866EEAB8AE39FFC26BED51D0C783C48C0982AB4D9441890F56C8B6E65B`。

| 2026-10-06 UTC 时间 | bad candidate 的实际事件 |
| --- | --- |
| `14:58:09.090Z` | 原 backend PID 45480 的 writer 开始 |
| `14:58:09.119Z` | 实际 pipe 写出缺 itemId 的 Schema 坏帧 |
| `14:58:09.121Z` | SDK 收到坏帧；rawPending=1、onStarted=0、turnWaiters=0，原调用仍 pending |
| `14:58:09.212Z` / `09.213Z` | 原 RPC 权威 start receipt 发出 / public onStarted 收到 |
| `14:58:09.275Z` / `09.276Z` | 同一原 tuple 的 valid completed / public usable success |

坏帧为 260 bytes，SHA-256 `0ee2c8b11bf82ecc79e0787f027f7c255fa6296cf03bee3e28eb0860d1dfb117`。只出现一次 turn/start、没有 interrupt；本次错误被吞后返回成功。healthy delayed-receipt control 正常保留原成功回合。所有诊断 PID 已退休。

这是成功 JSON.parse 后、尚无 registered turn waiter 的真实 pipe 缺口，区别于第 41 轮宿主 fatal。它不是 emit 假事件，不证明自然上游必然生成坏帧，也不意味着坏帧自身已提供权威 turn/start ACK。本研究没有真实 provider 调用或正式 DSH UI 验收。

## 本轮落地目标与独立未知边界

主执行方的实现目标是：在原 native 请求写入前登记私有 pending receipt/call 上下文，保存原 process/thread owner 与原请求身份；按 thread/turn 提示组合保存各自最早的错误，真实 receipt 返回后选择最早匹配的一条，不声称固定条目数上限。合法原 start receipt 返回后，再用该 receipt 做权威 tuple reconciliation，进入原契约失败/cleanup-only 路径。不能让后来合法 completed 覆盖该原 call 已发生的 Schema 错误，也不能把 fault 交给新的 request、metadata RPC 或同文字地址的新 owner。

以下验证仍须由实现/探针结果证明，本文不提前称为已完成：

- early fault 只归属于原 owner 和实际已发送的原 native call；普通未知消息、metadata RPC、foreign/ambiguous 原呼叫不被借用。
- caller 回调/参数等待窗口跨越 receipt 时仍保原最早匹配的 fault，登记/清理结算一次，不追加模型 continuation 或新 thread。
- failed interrupt ACK 保留同一原 tuple、child 和 cleanup-only waiting；成功 ACK/原实例退出才按既有标准清理。
- abort/stop/owner 更换期间旧 call 的晚 receipt/fault 不影响新 call；本地 Promise rejection 不伪装成远端停止。

**没有返回 RPC receipt 或无法验证 writer tuple 的情形，不属于本轮已验证的恢复实现。**其远端 writer 身份必须保持 unknown，不能从 frame 字段猜 turnId，也不能把没有句柄写成已确认取消/结束或可继续模型。本轮 RED 和实现目标覆盖的是合法权威 receipt 随后实际返回的场景；无回复边界的后续方案与验收应独立记录。
