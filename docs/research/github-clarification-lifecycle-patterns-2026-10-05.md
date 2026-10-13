# 澄清输入的原回合回复与后续回合核验

核验日期：2026-10-05。通过已读 Agent Reach 的 GitHub / `gh` 后端读取 Codex 和 LangGraph 固定源码及 LICENSE。研究区分原生 pending 问题和已完成回合中的普通问题，不重复模型设置或用量研究。没有复制代码、增加依赖或执行上游测试。

本项目 SDK port 的 `turn.respond` 是本地适配器名称；固定版本的官方 wire 没有公开 `turn/respond` 方法。两种澄清路径都应复用原 DSH child 和 Codex thread。原 ephemeral 句柄失效时不能通过持久 SDK reconstruction 创建替代上下文。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 核验重点 |
|---|---|---|---|
| openai/codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | request_user_input 的 request/reply 生命周期及 completed turn 的 followup |
| langchain-ai/langgraph | `9a0394d88b2211f299dcd69df92db3480c69ee61` | [MIT](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/LICENSE) | 答案关联具体 interrupt、持久恢复的适用边界 |

许可按固定提交文件核验；以下 permalink 不依赖移动分支。

## Codex：回复待回答请求，或在完成之后追加回合

**原生等待证据。** [工具 handler L86-L102](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/tools/handlers/request_user_input.rs#L86-L102) 等待用户答案，再把回答作为工具结果交回模型。[App Server L849-L869](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L849-L869) 将问题关联 threadId、turnId、itemId，登记 pending requestId 和 callback；参数同时标明是否 blocking。收到问题事件本身不表示回合已经完成。

客户端回复该 requestId 的 JSON-RPC response。服务端在 [L1704-L1709](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/bespoke_event_handling.rs#L1704-L1709) 将答案提交给原 event_turn_id。[往返测试 L131-L172](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/request_user_input.rs#L131-L172) 检查原 thread/turn/item、按原 requestId 回答，并断言 serverRequest/resolved 先于 turn/completed。这里核验的是测试源码，没有本机执行结果。

**普通 followup 证据。** [v2 测试 L2451-L2478](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/turn_start.rs#L2451-L2478) 先观察第一回合 Completed，再对同一个 threadId 发 turn/start，并检查新的 turnId。它证明普通后续输入可以使用原 thread，不需要 thread/start；该测试不专门实现本项目的 normalized needs_input 业务协议。

**wire 命名。** [ServerRequest L19](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts#L19) 定义 item/tool/requestUserInput。[ClientRequest L108](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server-protocol/schema/typescript/ClientRequest.ts#L108) 的 turn 操作为 start/steer/interrupt，没有公开 turn/respond。项目文档应将本地 turn.respond 与实际 JSON-RPC response 区分。

**本项目适用路径。** 原生 pending 存在时回答原请求，原回合继续；已完成回合被业务解析为 needs_input、没有 pending 且原 thread 可用时，发送短 answers followup 的 turn/start。保持原 child/thread，只有后一条路径产生新 Codex turn。不能仅凭 pending 不存在就推断回合已完成，也不能凭问题文本伪造 requestId。

## LangGraph：答案关联中断，但恢复会重执行节点

**证据。** [Command L833-L846](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/types.py#L833-L846) 将 resume 值用于 interrupt，并允许按 interrupt ID 提供答案。[interrupt L902-L915](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/types.py#L902-L915) 明确要求 checkpointer，恢复会从节点起点重执行逻辑。[L1008-L1025](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/types.py#L1008-L1025) 将回答值匹配当前任务的中断次序。

**可借鉴。** 保存问题、答案与所属原运行的关联；答复入口先检查对应等待状态和授权，避免迟到或并发答案驱动不同运行。恢复的语义来自真实中断身份，不能把普通问题字符串当作 pending handle。

**不能照搬。** 本项目没有移植 LangGraph 的 checkpoint、节点重执行或跨进程重建。其 durable graph 恢复和 Codex SDK 本地持久会话 reconstruction，都不能用于伪造已丢失 ephemeral thread 的原上下文；也不应以从节点起点重跑作为重发完整初始任务的理由。

## 本轮实施边界与验收

| 业务状态 | 驱动方式 | 需要保留的身份 |
|---|---|---|
| 有效原生 pending 问题 | 本地适配器发送原 requestId 的 JSON-RPC response | 原 child、thread、turn |
| 已完成回合的 normalized needs_input | 原 thread 上 turn/start，只发送短答案 followup | 原 child/thread，新的 turn |
| 原句柄失效或回合状态不明 | 明确报告不可恢复或状态不明 | 不创建替代 child/thread |

本轮使用 input admission 和 pinLifecycle 管理澄清输入及原 Planner 生命周期。正常 completed 的等待路径调用 child.pauseForInput，保留子会话而不 settle；回答续跑失败时保存 answersPrompt，仅在当前进程内供后续恢复使用。none/zstd 冷读回归与原 child 多回合行为由本仓库测试验证，第三方源码不能证明 DSH 侧栏正确。

红绿基线、三个新增冷读场景和最终门禁见[第十轮记录](../iterations/2026-10-05-tenth-planner-clarification.md)。本轮不重发原任务、不新增依赖，不扩大模型恢复承诺。研究结束时 Agent Reach 更新检查为 v1.5.0 最新；写本文档时未再次联网或调用正式 DSH/模型。
