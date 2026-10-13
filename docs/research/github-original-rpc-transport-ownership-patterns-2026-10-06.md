# 远端 RPC 的取消与清理必须使用原连接 owner

核验日期：2026-10-06。资料采集通过 Agent Reach GitHub／gh 路线取得公开固定源码、License 和官方测试；Context7 resolve-library-id → query-docs 核对对应 API。采集阶段只写独立 TEMP，随后整理到本研究文档。未执行上游测试／服务、添加依赖、调用模型或操作正式 DSH。GitHub warn 未被当成访问成功证明，固定源码与提交元数据由实际 gh API 返回确认。

## 本轮解决的边界

第三十四轮把成功 receipt 绑定到原 execution。本轮进一步要求：用于取得 ACK 的 interrupt、unsubscribe，以及响应／超时回调，必须操作创建原执行的连接 owner。把旧 receipt 隔离后，如果迟到的原 cleanup 仍查“当前连接”发 RPC，它可能取消 B，再把 B 的 ACK 记给 A。

两个成熟客户端采用的共同最小机制是捕获原连接／原 call 对象，并让其取消、pending 响应和退避计时器留在同一个生命周期里。公开 request/thread/turn ID 是该连接里的地址，不能单独选择另一连接。PID、TTL、当前 active map 或客户端实例还活着都不能代替这个 owner。

## 固定来源

| 官方仓库 | SHA／提交时间 UTC | License | 本轮可采用机制 |
|---|---|---|---|
| microsoft/vscode-languageserver-node | b4f995b69c55502f3c41b6501a1057247258e402／2026-10-05 23:43:43 | [MIT][v-license] | connection 闭包捕获 reader/writer、pending map 与取消目标；dispose 清原 token 订阅 |
| grpc/grpc-node | e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92／2026-10-01 20:59:05 | [Apache-2.0][g-license] | call 捕获原 HTTP/2 stream/transport；取消阻断原 call 的后续退避尝试 |

## vscode-jsonrpc：每个 connection 都有自己的请求序号和取消目标

[createMessageConnection][v-owner]将 MessageReader 与 MessageWriter 保存在本次闭包，sequenceNumber 从0起，responsePromises/requestTokens 也新建在该闭包。因此不同连接的数字 ID 可以相同，收到的 response 仍按原连接的 map 解析。

[请求取消回调][v-cancel]捕获 connection 和 id，调用 sendCancellation(connection, id)。默认 [CancellationSenderStrategy][v-sender]通过传入 conn.sendNotification 发 $/cancelRequest，不从外部服务的“当前 connection”重新查目标。请求 resolve/reject 都清自己的 cancellation state 并 dispose 当次 token listener。迟到 listener 与旧 pending entry 的回收也在原 closure 中完成。

[dispose][v-dispose]将原 connection 置为 Disposed，拒绝该 connection 的全部 pending response，替换其本地 map，并 dispose 原 writer/reader。它是本地生命周期终止，不是远端工作完成 ACK；本项目仍须保留独立远端确认条件。

已读取但未执行的官方测试：

- [Dispose connection][v-dispose-test]在 server handler 中 dispose client，原 sendRequest 必须 reject，不能等待后续成功 response。
- [Disposed connection throws][v-closed-test]dispose 后 sendNotification 必须 throw，不能透过旧对象改用别的连接。
- [Regular Cancellation][v-cancel-test]原 token.cancel() 通过这对 duplex connection 到达 server 对应请求的 token。它证明 cancellation 信号的原请求路由；该测试没有创建同 ID 的 replacement connection。

本研究的“不同连接可用相同数字 ID且不共用 map”来自固定创建源码；上游测试提供取消／dispose 控制，不冒称它们已完成本项目新旧进程 ID复用的完整负例。

## gRPC：取消 call 时结束它捕获的 stream，停止它自己的退避

[ClientUnaryCallImpl.cancel][g-public-cancel]调用该 call 对象保存的 call.cancelWithStatus；不是向全局 channel 查一个相同 callId 重新定位。[Http2SubchannelCall 构造][g-call-owner]保存 readonly http2Stream 与 transport。[Transport.createCall][g-create-stream]在自己的 session 上 request，随后把那个 stream 和 this transport 传给 [新 call][g-create-call]；旧 call 的事件和 cleanup 因此留在原 stream。

[cancelWithStatus][g-stream-cancel]进入 [endCall][g-stream-end]，最终 [destroyHttp2Stream][g-stream-close]关闭 this.http2Stream。它不会因为 channel 又建立连接而选择一个新 stream。调用内重试可能合法采用新 transport；该能力仍属于同一逻辑 call，不能成为清理另一个 execution 的权限。

[RetryingCall.cancelWithStatus][g-retry-cancel]先将自己的状态改为 NO_RETRY，清 retryTimer/hedgingTimer，报告 status，然后只 cancel 自己保存的 underlyingCalls。[退避回调][g-retry-callback]在真正发起新 attempt 前再次核 this.state == RETRY，覆盖 timer 已排队而 clearTimeout 不足以单独证明停止的窗口。

该固定 SHA 的提交正是合入取消退避修复，新增的官方测试贴合这个时序：

- [取消后不能启动新 attempt][g-retry-test]第一次请求失败并进入退避，取消原 call，等待超过重试间隔后 server 计数仍为1。
- [取消不能泄漏 stream][g-stream-test]server 仅允许3个并发 stream，先取消3个退避中的 unary calls，随后新的 echo 必须成功且返回预期值。旧退避若偷偷启动不可完成的新 stream，新 echo 就会被挡住。

这两例包含真实上游 server/client 的测试代码，但本研究只读取。它们证明原 call 的取消阻断和资源隔离控制，未证明本项目 child process 已退出、JSON-RPC ACK已经确认或一次复用 ID 的真实 DSH 恢复已经通过。

## 本项目的最小采用 seam

1. **捕获。** 在原 thread/turn/control RPC 被接纳时捕获该进程连接的 opaque owner（实际 transport/child/reader-writer 所属代次），让 waiter、native request和保留 cleanup handle携带同一 owner。它是进程内能力，不持久化原连接。
2. **发送。** 清理 RPC 接受／捕获 expectedOwner，经原 transport 发送。原 owner 已退出或不再可寻址时显式返回 unavailable／原进程终止诊断；不能调用通用 ensureStarted 去新进程补发。发前与异步返回后均核原 owner 自身的连接状态和注册关系，旧 callback不能消费新 response；仍存活且可寻址的原连接不因另一个 current 指针更新就自动改绑目标。
3. **收尾。** pending response、active-turn注册、超时 listener、unsubscribe 和 endRound只清自己的注册；同文本 key有新 owner时不删后继项。现有原 ACK、全捕获 PID tree退出、原 child/thread continuation、SQL token/epoch保护仍分别校验。

不添加上游依赖，不改 provider，不重置自动 continuation预算，不改变合法新业务 round入口，也不把整个客户端 stop 当作每个 RPC cancel 的实现。

## 必须由本地真实入口证明的测试映射

| 实际时序 | 本地应观察的证据 |
|---|---|
| A waiter被中止／超时，A cleanup挂起；随后 A真正退出，B进程启动并复用 thread/turn/request文本 | A迟到 cleanup对 B的 interrupt/unsubscribe 请求计数均为0；B原 active writer、child、pin仍保留 |
| 同一 SDK对象经历 transport代次变化，A旧response／exit／timeout callback迟到 | B pending Promise、active登记和原socket不被完成、拒绝、删除或关闭；A只能收自己的诊断 |
| A仍在原连接，正常失败ACK→重复／并发确认→成功ACK | 原 pair＋owner保持，实际一次共享确认；不发新模型，不让隔离检查误拒合法原owner |
| 原取消／已停止控制 RPC的 backoff timer已排队，新B合法运行 | 旧call不会再次启动RPC／process；B可完成，新执行请求和结果可追踪 |
| 原进程已退出且旧 pair不可恢复，用户省ID resume | 显式不可用／cleanup状态；不创建新 child/thread、不父会话代写产物 |

上游资料没有直接覆盖本项目 JSON-RPC旧父会话与侧边栏身份，应由真实 App Server fixture、native DSH child、SQLite当前源码以及实际wire/process计数验证。第34轮 receipt generation tests是既有控制，本轮须新增“RPC真的发往谁”的证据，不能只测 WeakMap 或字符串 key。

## 本地采用与验收边界

当前实现由 SDK 在实际 ChildProcess 接纳线程时生成仅进程内有效的注册 owner。`captureThreadOwner`、`expectedOwner` 与错误上的 `originalThreadOwner` 将模型、原生回答、取消和订阅清理绑定到该 owner；同进程再次注册同一文本也产生新 owner。模型预备阶段的异步控制请求保留原连接，回调和回复后再次核验。工作流、私有种子、后台 Reviewer 与计量 observer 分别保存各自 owner，历史 SQL token/epoch 确认继续独立校验。

本地 SDK 六例及既有清理控制已通过；冻结旧实现的真实进程退出／同地址复用探针已复现错误 RPC 和错误计量。完整门禁、实际 DSH 重载及发布检查仍需由[本轮记录](../iterations/2026-10-06-thirtyfifth-original-thread-transport-owner.md)的最终验收确认，不能由上游阅读或局部测试代替。

## 文档与采证

Context7 首次 vscode-jsonrpc resolve 返回无关 Ruby/JSON库，未采用；改用 microsoft vscode-languageserver-node精确名称，解析到 /microsoft/vscode-languageserver-node后 query 命中 createMessageConnection、Disposed/Closed和pending rejection文档。/grpc/grpc-node resolve→query命中 call对象 cancel、CANCELLED与server取消事件；其内部 Call类不是稳定公共API。永久源码引用均为下列固定 SHA，未把动态 docs 当成当前源码测试证明。

公开解码文件位于 C:\Users\Z1803\AppData\Local\Temp\dsh-thirtyfifth-rpc-owner-research；License和commit日期实际读取。未clone仓库、未执行上游tests、未触及正式DSH／凭据／模型服务。

[v-license]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/License.txt
[v-owner]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L608-L628
[v-sender]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L425-L452
[v-cancel]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1422-L1471
[v-dispose]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1544-L1564
[v-dispose-test]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L488-L507
[v-closed-test]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L509-L522
[v-cancel-test]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L777-L803
[g-license]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/LICENSE
[g-public-cancel]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/call.ts#L89-L100
[g-call-owner]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/subchannel-call.ts#L147-L153
[g-create-stream]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/transport.ts#L563-L591
[g-create-call]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/transport.ts#L657-L665
[g-stream-cancel]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/subchannel-call.ts#L585-L592
[g-stream-end]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/subchannel-call.ts#L423-L430
[g-stream-close]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/subchannel-call.ts#L547-L592
[g-retry-cancel]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/retrying-call.ts#L319-L340
[g-retry-callback]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/src/retrying-call.ts#L503-L512
[g-retry-test]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/test/test-retry.ts#L695-L735
[g-stream-test]: https://github.com/grpc/grpc-node/blob/e742b11bd8039f3dbea4cd29afdf5d95a8ba6b92/packages/grpc-js/test/test-retry.ts#L737-L765

