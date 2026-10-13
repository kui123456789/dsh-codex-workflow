# JSON-RPC dispatch 错误隔离：固定来源研究

日期：2026-10-06。范围：iteration 41，两组固定代码来源及主执行方提供的真实回合 RED。外部官方测试只读取、未执行，本文不声称生产修复已完成。研究与补丁边界为成功 JSON.parse 后的已接受 handler 错误隔离；不扩展 CLI、UTF-8、provider 或 JSON 噪声兼容策略。本研究员不修改 production/lib 或正式 DSH PID 85376。

## 接口原则与本项目边界

读取帧、识别消息类别/方法、验证已接受方法的运行时输入、执行 handler、确认原 writer 终止是不同步骤。未知且未订阅的正常 notification，不等于已接受方法传来非法 params；静态 TypeScript 泛型，也不等于运行时 Schema 验证。

同步帧回调应在原 owner 的局部异常边界内执行。错误既不能逃出 readline 回调导致宿主崩溃，也不能被改写成可自动继续的普通模型失败。本项目已确定：typed input/Schema/display 契约失败终止模型工作，原 active writer、thread/turn 和 child 清理句柄保留到真实 ACK 或原实例退出确认；一次 catch、onerror 通知或 handler 结束不能证明 writer 已结束。

这些来源用于解释本地受控 RED，并提供后续对照验证的接口原则；不要求采用两个框架的依赖、完整解析器、队列、版本协商或 Schema 集合。未知方法与已有 stdout 噪声兼容行为应单独核对，不能因一个已知方法的错帧就扩大到全面重写输入规则。

## 固定来源与实际许可

| 来源 | 固定提交 | 实际许可证范围 |
| --- | --- | --- |
| [microsoft/vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node/tree/b4f995b69c55502f3c41b6501a1057247258e402) | `b4f995b69c55502f3c41b6501a1057247258e402`；2026-10-05T23:43:43Z；`Bump brace-expansion (#1880)` | [License.txt](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/License.txt)：MIT，实际原文已取得 |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk/tree/b022522089a0c8b632595c6e7b536453945ed5a9) | `b022522089a0c8b632595c6e7b536453945ed5a9`；2026-10-05T14:38:02Z；`fix(core): reject x-mcp-header on number-typed parameters (#2762)` | [LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/LICENSE)：新 code/spec 与已获重许可同意的贡献 Apache-2.0；未获同意的历史 MIT 贡献仍 MIT；非 spec 文档 CC-BY-4.0。不能笼统标成 MIT 或只 Apache-2.0 |

MCP 这一来源属于 Model Context Protocol 官方仓库，不能写成 Microsoft 所有的仓库。所读核心包 manifest 版本为 2.0.4、license 字段为 Apache-2.0；本说明仍保留根 LICENSE 的贡献许可过渡边界。本文总结原则，不复制框架代码或作逐段许可重判。

## Node 事件契约：同步 throw 与 Promise rejection

Context7 已执行 `resolve-library-id("Node.js")` → `/websites/nodejs_latest-v24_x_api` → 针对 EventEmitter 的精确 `query-docs`。

官方 [`EventEmitter.emit`](https://nodejs.org/docs/latest-v24.x/api/events.html#emitteremiteventname-args) 同步按注册顺序调用 listeners；[`captureRejections`](https://nodejs.org/docs/latest-v24.x/api/events.html#capture-rejections-of-promises) 对 handler 返回的 Promise 安装 `.then(undefined, handler)`，异步转发 rejection。它不替代同步帧处理路径的 try/catch。增加一个普通 `error` listener 也不自动把任意同步 throw 变成该 error 事件。

这是 Node v24 当前文档的 API 依据，未增加第三个代码研究仓库，也未把它当作本地坏帧探针结果。

## VS Code JSON-RPC：reader 与 dispatch 异常边界

- [`messageReader.ts:214–260`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/messageReader.ts#L214-L260)：外层捕获 append/header/body 异常；顺序解码及 DataCallback 在 semaphore 的 async callback 内，rejection 进入 `fireError`。这不是只在 `JSON.parse` 附近捕获 syntax error。
- [`messageReader.ts:78–84`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/messageReader.ts#L78-L84) 使用框架自身的 error emitter；[`events.ts:71–87`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/events.ts#L71-L87) 对每个 subscriber 的同步异常作捕获并日志报告。不能误称为 Node EventEmitter 默认具备这种隔离。
- [`connection.ts:725–775`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L725-L775)：队列调度对同步失败作 catch；Promise 失败后 finally 仍释放 inFlight 并推进队列，避免一个失败永远占用并发 slot。随后按 request/notification/response/invalid 分派。
- [`messages.ts:509–527`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/messages.ts#L509-L527)：这些 guard 主要检查 method/id/result/error 类别，不是方法 body 的深层 Schema。
- [`connection.ts:946–1011`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L946-L1011)：notification handler 的同步/异步错误被 catch 后记录；未处理 notification 走 unhandled event。参数 arity/结构错误有些只日志提示后继续调用 handler，所以 NotificationType 不能作为“深层非法输入已拒绝”的依据。
- [`connection.ts:1014–1027`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1014-L1027)：invalid response 若能对应待办 id，拒绝那个原 request，而不是借无关待办补出一个结果。

可借鉴的是边界捕获、原请求关联和 slot 释放，不能照搬“日志后继续业务”的策略来处理本项目的模型/display 契约终止。

## MCP SDK：外层 Schema、已知方法验证与未知消息

- [`shared/stdio.ts:26–57`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/stdio.ts#L26-L57)：逐行消费后使用 `JSONRPCMessageSchema.parse(JSON.parse(line))`。此固定版本刻意跳过 SyntaxError 噪声，合法 JSON 但 Schema 不合法仍 throw。不能把这种版本特定兼容策略写成“所有错帧应忽略”。
- [`client/stdio.ts:166–172,210–222`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L166-L222)：data append 有外层 catch；逐帧读取和 onmessage 有内层 catch→onerror，消耗坏帧后可继续后续帧。onerror 本身是调用者回调，不能宣称该实现保护所有会抛错的 subscriber。
- [`protocol.ts:924–935`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L924-L935)：未订阅且无 fallback 的 notification 直接忽略；已选择 handler 则置于 `Promise.resolve().then(...)`，同步 throw 与异步 rejection 都进入 onerror。
- [`protocol.ts:1858–1888`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1858-L1888)：spec handler 在 dispatch 时经过 codec 的 notification 验证；自定义方法须给 params Schema，验证失败在业务 handler 前抛 InvalidParams。
- [`protocol.ts:1022–1041`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1022-L1041)：未知 request 答 MethodNotFound（−32601）；服务中的方法才进入相应 params/envelope 检查，可答 InvalidParams（−32602）。这不等于一个已知方法错 body 属于未知方法。
- [`protocol.ts:961–970`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L961-L970) 捕获 request 到达时的 transport，错误响应仍发往原 transport，不能因新 connect 改写目标。

MCP notification catch 用 `new Error("Uncaught..." + error)` 作 out-of-band 报告，并未在该包装处保留原 cause/code，也不代表业务 workflow 终态。对本项目不能照抄这种泛化消息、把 Schema 错误变成 transient model failure；应保留原 cause、原 owner 与既有终止/cleanup-only 语义。

## 官方测试实际测了什么

| 测试 | 所读证据 | 实际性质与限制 |
| --- | --- | --- |
| [VS Code connection `353–367`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L353-L367) | 未处理 request 返回 MethodNotFound | `TestDuplex` 内存 stream，用 setImmediate emit data；不是实际 App Server 进程 |
| [VS Code `472–485`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L472-L485) | 未处理正常 notification 进入 unhandled event | 同一内存 stream，非 typed malformed body/原 writer 清理测试 |
| [VS Code `759–774`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L759-L774) | 缺第二参数仍调用 handler，第二参数为 null | 证明该泛型接口不承担完整 runtime Schema 拒绝，不应美化成严格验证 |
| [MCP stdio `85–113`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/stdio.test.ts#L85-L113) | malformed JSON 被跳过；valid JSON 非 JSON-RPC 仍 throw | 直接给 ReadBuffer append Buffer 的单元测试，无真实 OS child/pipe |
| [MCP schema boundary `55–82`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/types/schemaBoundaryPins.test.ts#L55-L82) | JSON-RPC 外层未知 sibling 被 strict Schema 拒绝 | 纯 safeParse；外层 sibling 与未知 method 是不同条件 |
| [MCP protocol `1144–1153`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocol.test.ts#L1144-L1153) | decoder 同步 throw 拒绝原 request，不逃出 response callback | `vi.spyOn(...decodeResult)` 注入错误；不是实际 wire 自发损坏 |
| [MCP protocol `1166–1207`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocol.test.ts#L1166-L1207) | unknown method 与 served method 分别 −32601/−32602 | InMemoryTransport，mock envelope check，10ms flush；非真实 provider/runtime 验收 |
| [MCP transport handling](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocolTransportHandling.test.ts) | A request 未完成时 connect B，A/B 响应回各自原 transport | MockTransport+延迟；直接调用 onmessage，不证明本项目 OS child owner 或 cleanup ACK |

全部只读，不运行、不汇报为本仓库 GREEN，也不复制这些 mock/timer 作为真实坏帧复现证据。

## 主执行方提供的真实回合 RED

以下记录由主执行方提供，本研究员没有运行或复演该探针。帧已成功解析为 JSON，错误发生在 SDK 已接受的方法 handler 内；不是 JSON syntax error，也不是未知方法兼容测试。

| 受控输入 | 重复次数 | 默认 SDK 宿主结果 |
| --- | --- | --- |
| 已注册模型回合中的消息缺 `itemId` | 2 | fatal，退出码 1 |
| 已注册模型回合中的消息缺 `threadId` | 1 | fatal，退出码 1 |

解析异常时原 backend 仍活着，SDK 还有 pending RPC 1、turn waiter 1，尚无 interrupt。宿主退出后 backend 随后也退休；这段证据不能写成“backend 持续残留”。它证明默认同步 dispatch 异常破坏宿主与原调用的可观察结算路径，不证明自然模型服务必然发送此错帧、真实 provider 有缺陷或生产修复已经部署。

后续验证需覆盖：原 turn 已注册但仍在 await `onStarted` 的期间发生 protocol fault，应锁存该原 owner 的契约错误并在回调返回后检查；不得因 waiter 尚未完全就绪而漏报、成功返回或继续模型。若同一原 owner 的 interrupt ACK 失败，应保持终止模型工作的 cleanup-only waiting 及原 tuple/句柄，不能在父会话补计划或新建 thread。真实 ACK 或原实例退出后才能按既有终态清理。这些是回归目标，不是本段 RED 已证明全部行为正确。

## 本地验证目标与范围

| 场景 | 必须区分的观察 |
| --- | --- |
| 普通未知 notification/已有 stdout 噪声 | 保持已有兼容处理；不执行被认成已知方法的 handler，不无故终止业务 |
| 已接受方法的非法 body/typed-input/display 契约 | handler 之前验证或局部捕获；报告原方法与原 cause，不做 automatic continuation，不创建替代模型请求 |
| 真实 pipe 把该帧送到 line 回调并触发同步异常 | 宿主保持可用，原调用有可观察失败；不能仅用 emit 假事件证明 OS pipe 行为 |
| 失败前原 writer 已经 started，interrupt 尚无 ACK | 原 active child/thread/turn owner 及清理句柄保留；不能把捕获错误当结束，不释放新执行或提前准入替代轮 |
| 真实 ACK 或完整原实例退出随后到达 | 只结算那个原 writer 一次，之后按既有终态清理；后续合法控制帧仍有可读取路径 |
| 异步错误到达时 current transport/owner 已换 | 只能影响原 pending/原 writer，不借新 map 中同字符串地址的执行作清理；无可验证原句柄时保持未确认 |
| error 报告 observer 自身抛错 | 明确 reporter 的异常边界，不用宿主级 uncaughtException 或全局吞错掩盖失败，不篡改主要 Schema/contract 原因 |

## 最小落地选择

针对成功 JSON.parse 后的真实本地 RED，可选最小 dispatch 边界：捕获实际原 child/connection，按已知接受方法验证或捕获其同步处理失败，将错误交给原操作的既有契约失败与 cleanup-only 路径。未知方法兼容策略、CLI、UTF-8 codec、provider、模型 continuation 预算与现有 ACK/退出标准无需因为本研究而改变。

隔离宿主异常与保存原 writer 的终止能力必须共同验证；不能仅看到 host 没崩就声称原会话清理完整。完整本地回归、补丁及生产验收结果由主执行方另行记录。
