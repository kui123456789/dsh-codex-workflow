# 同会话恢复资格、精确寻址与重复启动机制核验

核验日期：2026-10-05。来源通过 Agent Reach 的 GitHub / `gh` 后端按固定提交读取，许可由仓库元数据和对应 LICENSE 双重核验。本轮选取三个源码案例，没有复制实现、引入框架或执行上游测试。先对照了既有[工作流研究](github-workflow-patterns-2026-10-05.md)、[用量研究](github-usage-budget-patterns-2026-10-05.md)和[工具展示研究](github-tool-result-patterns-2026-10-05.md)。

本仓库第七轮实施范围只有两项：Reviewer 等待时在 status 中只读取证并提前报告工作区变化；Planner continue 的可恢复失败兼容分支统一委托 Manager.resume。其余机制是设计参考或既有行为的验证依据，不能据此宣称新增了持久 checkpoint 恢复、启动幂等框架或 Token 优化。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 核验重点 |
|---|---|---|---|
| LangGraph | `9a0394d88b2211f299dcd69df92db3480c69ee61` | [MIT](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/LICENSE) | 已有状态与恢复意图分别校验 |
| Temporal TypeScript SDK | `7510506c9d81207420b049c7eea936cdf9bf5ecb` | [MIT](https://github.com/temporalio/sdk-typescript/blob/7510506c9d81207420b049c7eea936cdf9bf5ecb/LICENSE) | 句柄引用、具体执行和启动冲突分开 |
| OpenHands server/SDK | `091d451f5fdd1952994f7da4fcf201a1d21bb615` | [MIT](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/LICENSE) | 持久记录与活动 runtime 分层、锁内重新校验 |

OpenHands 案例选自 `OpenHands/software-agent-sdk` 的实际 agent-server，避免把前端保存的会话引用当作服务端运行证明。以下 permalink 的完整 SHA 固定了本次证据范围。

## LangGraph：明确恢复意图，并确认已有状态

**证据。** [`_first` L855-L879](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_loop.py#L855-L879) 同时检查已有 checkpoint 的 channel versions 和 continuation 输入。仅有稳定 thread ID 不足以证明正在恢复。[L1685-L1692](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_loop.py#L1685-L1692) 单独记录是否存在持久父状态，然后处理首次运行的空 checkpoint。另见 [L767-L778](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_loop.py#L767-L778)：成功任务复用输出，未完成任务仍待执行。

**与本轮的关系。** Planner continue 的失败兼容入口应进入统一 resume 校验；Reviewer 等待状态还需确认原证据仍适用。已有记录、明确继续意图、可用原句柄和当前业务资格分别判断。

**边界。** 本项目没有移植 LangGraph 的任务 checkpoint、成功节点缓存或跨进程图恢复。SQLite workflow 记录不能重建已退出 App Server 的 ephemeral 模型上下文；resume 也不能借缺状态进入首次初始化路径。

## Temporal：引用存在不等于执行可用

**证据。** [`getHandle` L1957-L1989](https://github.com/temporalio/sdk-typescript/blob/7510506c9d81207420b049c7eea936cdf9bf5ecb/packages/client/src/workflow-client.ts#L1957-L1989) 区分 workflow ID、具体 run ID 和执行链起点。仅按 workflow ID 获取的 handle 可以指向最新执行；创建 handle 本身不验证执行存在，后续方法才可能报 `WorkflowNotFoundError`。[启动冲突策略 L90-L110](https://github.com/temporalio/sdk-typescript/blob/7510506c9d81207420b049c7eea936cdf9bf5ecb/packages/common/src/workflow-options.ts#L90-L110) 分别定义拒绝、使用已有运行、终止并替换；[客户端 L1587-L1604](https://github.com/temporalio/sdk-typescript/blob/7510506c9d81207420b049c7eea936cdf9bf5ecb/packages/client/src/workflow-client.ts#L1587-L1604) 将服务端 `ALREADY_EXISTS` 转为带 workflow 身份的专门错误。

**与本轮的关系。** status 报告当前资格，不能仅依据持久 waiting/running 字段或一个 ID。取证 await 后原 handle 可能已经释放、替换或正在被驱动，必须重新检查。Planner 兼容入口通过 Manager.resume 共享原线程可用性判断，防止旁路直接调用旧运行对象。

**边界。** 本轮没有新增 Temporal 服务、执行链或启动策略。客户端源码不证明本项目具备服务端幂等保证；其请求 ID 默认新生成，也不能直接视作重复 API 调用的稳定幂等键。精确寻址原则不能用来承诺 ephemeral 线程在进程重启后仍可恢复。

## OpenHands：分层诊断，并在异步准备后重新校验

**证据。** [ConversationService L492-L527](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L492-L527) 分开保存持久 catalog 和活动 EventService。[L1020-L1074](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L1020-L1074) 分别处理服务关闭、记录不存在、现有运行可用、运行绑定缺失和其他 owner 的 lease。生命周期锁的作用域见 [L982-L1017](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L982-L1017)。

[创建路径 L1645-L1668](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/openhands-agent-server/openhands/agent_server/conversation_service.py#L1645-L1668) 在异步准备之后、生命周期锁之内再次检查 identity。另一个请求已经创建时复用已有 conversation，避免重跑初始消息。[并发加载测试 L909-L934](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/tests/agent_server/test_conversation_service.py#L909-L934) 断言五个请求只加载一次并返回同一个对象；[旧 owner 测试 L419-L468](https://github.com/OpenHands/software-agent-sdk/blob/091d451f5fdd1952994f7da4fcf201a1d21bb615/tests/agent_server/test_conversation_service.py#L419-L468) 检查租约更换后拒绝迟到写入。本次只读了这些测试源码。

**与本轮的关系。** Reviewer status 的证据扫描是异步准备：扫描返回后重核归属、running、cancel、stop 和原 handle 身份，再返回资格。扫描发现工作区变化时保留原句柄，由状态说明当前不能继续。Planner 两个入口共享同一个恢复 owner 和停止控制器，避免入口之间分别驱动原线程。

**边界。** OpenHands 能从自己的持久状态加载 runtime，本项目不采用该重建路径。本轮也没有新增 OpenHands 的 catalog、lease 或重复启动模块；既有 single-flight 和清理机制的完成状态仍以本仓库回归为准。

## 本轮最小实施与验收路径

| 发现 | 本轮实施路径 | 验收依据 |
|---|---|---|
| Reviewer 等待与证据仍适用是两个条件；取证 await 中生命周期可能变化 | status 只读取证，提前给出 `workspace_changed`；保留原 child/thread；扫描后重核 owner/running/cancel/stop/handle | 工作区变化及扫描竞态回归，原句柄身份与清理计数 |
| Planner 可恢复失败兼容入口可能绕过公共 resume 的驱动约束 | continue 委托 Manager.resume，共享默认 instruction、single-flight、线程可用性和 stop controller | 两入口并发、缺线程、取消和停止回归，模型请求与身份计数 |

红绿结果、最终门禁和实际 DSH 验收见[第七轮记录](../iterations/2026-10-05-seventh-recovery-eligibility.md)。启动响应丢失后的稳定寻址、重复启动幂等性及 checkpoint 输出复用属于研究参考，本轮不能作为这些功能的新实现证明。未测量真实模型 Token 或费用；Agent Reach 更新检查时 `v1.5.0` 为最新版本。
