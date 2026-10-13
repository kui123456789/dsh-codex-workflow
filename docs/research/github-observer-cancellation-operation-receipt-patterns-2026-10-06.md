# Observer cancellation 与原操作 receipt：固定来源研究

观察日期：2026-10-06 UTC，整理跨本地 2026-10-07。范围：iteration 43，两组固定源码及主执行方的真实反馈。研究员只读核查，不改 source/lib、正式 DSH PID 75196、provider 或凭据，不运行模型或 Temporal 服务，不提交或发布；本文不声称生产修复完成。

## 需要分开的生命周期

本地 caller 的 abort/deadline 可以结束一次等待，不能单独证明已发送的 remote operation 未开始、已经取消或已经结束。原非幂等 start 已提交而 receipt 未返回时，重新 start 可能产生第二个操作；没有合法原 receipt 的 writer 仍属于 unknown。

要继续取得原操作的权威信息，需要保留原 request/owner 的 reconciliation 能力，或依赖协议本来支持的 durable operation identity。二者均不能靠坏帧/notification 中的 turnId 补造句柄，也不能把本地 send/cancel Promise 当作真实 remote ACK。

## 固定来源与实际许可

| 来源 | 固定提交 | 许可证与范围 |
| --- | --- | --- |
| [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk/tree/b022522089a0c8b632595c6e7b536453945ed5a9) | `b022522089a0c8b632595c6e7b536453945ed5a9`；2026-10-05T14:38:02Z；`fix(core): reject x-mcp-header on number-typed parameters (#2762)` | [实际 LICENSE](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/LICENSE)：新 code/spec 与同意重许可贡献 Apache-2.0；未同意的历史 MIT 贡献仍 MIT；非 spec 文档 CC-BY-4.0。核心包 manifest 2.0.4 的 Apache 字段不抹去过渡边界 |
| [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript/tree/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29) | `c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29`；2026-10-06T15:50:18Z；`chore: upgrade to ts 5.9 (#2490)` | [实际 LICENSE](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/LICENSE)：MIT；所读 client 包 manifest 1.24.0 |

源码、实际 LICENSE 与官方测试保存在 TEMP；外部测试只读取、未执行。本文不复制 SDK、server、取消框架或依赖，不以成熟库的存在代替本项目的真实行为验证。

## MCP 的真实限制：timeout 后删除 response handler

- [`protocol.ts:1463–1506`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1463-L1506)：timeout/abort 进入 cancel，按 transport/era 发送 cancellation 或 abort stream，并在本地 reject。legacy initialize 甚至只本地拒绝，不发 cancellation。
- [`1582–1604`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1582-L1604)：timeout 调用该 cancel；Promise finally 移除 abort listener、**删除 `_responseHandlers` 中原 id**并清理 timeout。
- [`1213–1230`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1213-L1230)：晚 response 找不到 handler 时报告 unknown message ID，不重建原请求或采用其结果。

因此该固定实现不是“本地 observer 取消后仍保留 late receipt reconciliation”的已解决模式。它展示了清理 caller 请求登记的策略与限制：本地 promise rejection、cancellation 已发送、remote operation 已结束是三个事实，不能合并。

MCP 的 result continuation、HTTP stream cancellation 与超时策略有协议前提；不能复制到没有同等 cancellation/idempotency 契约的 App Server 原 start 调用。

## Temporal：本地 RPC 与 durable workflow 操作分离

Context7 已执行 `resolve-library-id("Temporal TypeScript SDK")` → `/temporalio/sdk-typescript` → 精确 query。首个复合查询未命中，随后按 Connection.withDeadline 与 getHandle 具体方法查询并以固定源码核对；没有假称未匹配结果已验证 withAbortSignal。

[`connection.ts:529–592`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/connection.ts#L529-L592) 将 deadline 传给 gRPC call；withDeadline 的超时在本地成为 DEADLINE_EXCEEDED。withAbortSignal 使该 call.cancel，局部成为 CANCELLED。这些动作本身没有调用 workflow cancellation/termination API。

[`workflow-client.ts:921–998`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/workflow-client.ts#L921-L998) 的 result 等待 GetWorkflowExecutionHistory close event；[`1702–1716`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/workflow-client.ts#L1702-L1716) 的 cancel 则明确调用 RequestCancelWorkflowExecution。停止结果观察与向 durable workflow 发取消请求是不同路径，workflow 对取消也可以先做 cleanup 再结束。

可借鉴的是生命周期与操作身份分离，**不是 Temporal 自动保留被取消 gRPC call 的 late response**。它能够重新查询/观察已有 workflow，依赖服务端 durable state 和协议约定的 identity；本轮未审计 Temporal server 的实际去重实现，也未运行服务。

## Durable handle 与幂等性前提不能省略

- [`workflow-options.ts:22–31`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/workflow-options.ts#L22-L31)：workflowId 是启动时由客户端提供的业务 ID，文档明确其可用于幂等并受 reuse/conflict policy 约束。
- [`workflow-client.ts:1624–1630`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/workflow-client.ts#L1624-L1630)：请求同时携带 requestId 与 workflowId。不能据此宣称任意重复调用都安全，或 JSON-RPC id 自带同等业务去重协议。
- [`1958–1989`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/client/src/workflow-client.ts#L1958-L1989)：getHandle 不验证执行存在；仅给 workflowId 时选择最新 execution，给 runId 才针对特定 execution，firstExecutionRunId 限制链。result 默认还可 followRuns。

构造 handle 不等于确认远端存在；查询最新 run 不等于确认原 run。App Server 尚无合法 start receipt 的 server-assigned turnId，不能通过 invent ID、重启线程、读取最新同文字地址或重复 start 获得这种 durable 身份。

## 官方测试真实性

| 测试 | 所读断言 | 限制 |
| --- | --- | --- |
| [MCP protocol `950–993`](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/test/shared/protocol.test.ts#L950-L993) | initialize abort/timeout 只本地拒绝；其他方法按策略发 cancellation | 内存 transport，不证明 remote writer 停止或 late receipt 可恢复 |
| [Temporal client connection `104–141`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/test/src/test-client-connection.ts#L104-L141) | 本地 gRPC server 的 hanging RPC 在 AbortSignal 后返回 cancelled error | 真 gRPC 通信、模拟 service；无 durable workflow，也非本项目 App Server |
| [Temporal workflow cancellation `20–75`](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/test/src/test-workflow-cancellation.ts#L20-L75) | cancel 后 workflow 可立即或 cleanup 后 complete/cancel/fail，caller 另 await result | 集成 harness/Worker，需要 Temporal 服务；本研究只读未运行，不是 observer-abort 后本项目保 writer 的证据 |
| [Temporal workflow start conflict policy](https://github.com/temporalio/sdk-typescript/blob/c13d56f7cc0d76d5cdca0fba3d31ff6ea058ac29/packages/test/src/test-integration-workflow-start.ts#L50-L119) | 相同 workflowId 按 FAIL/USE_EXISTING/TERMINATE_EXISTING policy 处理 | server-supported 业务 identity 的集成测试，不证明重发 App Server start 幂等 |

## 主执行方真实反馈，研究员只读核查

TEMP 目录 `dsh-fortythird-feedback-cf18d46c-49ab-4d93-8e8c-4537f14adc2f` 包含 healthy 与 abort 两个受控 case；主执行方报告约 4 秒的 abort probe。healthy result 为 passed；abort result 为业务 RED，不是已经修复后的验收。

abort/result.json 为 700 bytes，SHA-256 `70AAADAB945ED76068C4352C04F30AD37A6EE510058642F1AE051DBE57FCA52D`；healthy/result.json 为 78 bytes，SHA-256 `93D585D612780A1D03CE7ACA19D3A1E9B5174DD92530930A2004CCACAB4F9203`。源版本仍是 SDK `95844BBC0F723D02E1CC44252F920872E46D2C834AC65D63595BD8571EE44D97`。

| 2026-10-06 UTC | 实际事件 |
| --- | --- |
| `15:55:24.152Z` | backend PID 73672 已接受 start RPC id 4，原 turn 已开始，reply 受控保持 |
| `15:55:24.163Z` | caller abort 返回；manager planning/waiting、continuation.available=true，rawPending=0、pendingReceipts=0、adoptionCount=0 |
| `15:55:24.186Z` | 公开 resume 已发送第二次 start id 6，原 originalActive=true；被冲突拒绝 |
| `15:55:24.214Z` | 真正原 id 4 late receipt 到达；SDK adoptionCount=0 |

两次 start 针对同一原进程与 thread；不能将“服务端拒绝第二次 start”写成 client 没有重复发送，也不声称本 case 已实际运行第二个模型。该结果证明 caller abort 结束了本地等待后，旧实现仍错误允许重复原 start，并丢失了合法原 late receipt。研究员没有复演探针、操作正式进程或调用真实模型/provider。

## 本项目可借鉴的最小契约

1. 将 observer 的 timeout/abort settlement 与已发送原 native call 的 operation/reconciliation 生命周期分开，保留实际原 request、process/thread owner 与发送身份。
2. 原 receipt 未合法返回时，公开状态保持 writer unknown；不自动追加 start/新 thread，不用 parent 计划替代原工作，不用帧字段猜 turnId。
3. 晚 receipt 只由原请求归属与合法返回字段完成 reconciliation，保首个对应契约错误；旧 observer 已结束时，不使已结束的 Promise 再次成功或借新 owner/新业务 scope 采用模型产物。
4. 如原业务 scope 已改变，late tuple 可用于原资源清理，不能用于新模型工作。清理须按该 API 的真实确认/原实例退出标准，不能把本地 cancel sent 当作已结束。
5. 记录 reconciliation 资源的保留与释放边界，不声称无限保留安全、存在固定容量上限或协议具备未声明的 idempotency。

以上是来源与本地 RED 支持的设计要求；实现、late receipt 采用、unknown writer status/resume、stop 与完整门禁尚须主执行方验证。本文不把 MCP handler 删除限制或 Temporal durable getHandle 包装成可直接接入 App Server 的恢复组件。
