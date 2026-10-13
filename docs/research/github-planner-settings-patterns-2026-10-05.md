# Planner 设置保留与默认值边界核验

核验日期：2026-10-05。通过已读 Agent Reach 的 GitHub / `gh` 后端读取两个项目的固定源码及 LICENSE；本次只归纳设置传递机制，没有复制代码、引入依赖或执行上游测试。研究关注模型和 reasoning effort 在失败恢复中是否保留，既有线程身份和用量研究不重复展开。

本轮实际采用客户端 `onModel` 回调给出的已解析 wire 模型，以及规划开始前保存的 requested effort。现有 SDK port 不报告服务器实际 effort，本轮没有扩展该接口。旧记录缺快照字段仍使用既有 config fallback；它不能证明恢复了未知的历史选择。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 核验对象 |
|---|---|---|---|
| openai/codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | TS SDK Thread/CodexExec、公开 App Server 参数与返回类型 |
| OpenHands/software-agent-sdk | `54daf056bd863bb46f922a2fe9324dd736b37ff6` | [MIT](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/LICENSE) | 保存的 Agent/LLM 设置与显式重新配置 |

许可由对应固定提交文件核验。以下源码链接不依赖移动分支，第三方默认模型或 effort 不作为本仓库默认值。

## Codex：同一 Thread 复用选项，恢复入口仍需提供选项

**证据。** [Thread L53-L62](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/thread.ts#L53-L62) 将创建时的 ThreadOptions 保存到实例；[L74-L91](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/thread.ts#L74-L91) 每轮从这个对象取 model、modelReasoningEffort，再传给 CodexExec。它保存的是对象引用，并没有做不可变拷贝。

[Codex L25-L37](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/codex.ts#L25-L37) 的 startThread 和 resumeThread 都接收 ThreadOptions；resumeThread 的 options 默认为空对象，这段 SDK 代码没有从历史读取模型设置。CodexExec 分别将 [model 写入命令参数](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/exec.ts#L116-L118)及将 [effort 写入 config override](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/exec.ts#L150-L152)，随后根据 thread ID [添加 resume](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/sdk/typescript/src/exec.ts#L173-L175)。

公开协议 [TurnStartParams L35-L49](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts#L35-L49) 说明 model/effort 覆盖本回合和后续回合。因此保持 thread ID 并不阻止新配置覆盖原选择。[ThreadStartResponse L12-L25](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartResponse.ts#L12-L25) 公开定义 model 和可空 reasoningEffort。

**本轮采用。** Planner 保存客户端已解析的 wire 模型；requested effort 在首次规划执行前保存，失败或 abort 时仍保留。自动 continuation 和 manual resume 使用该运行的保存值，避免等待期间 config 改动重新选择模型或 effort。当前恢复生命周期仍提供自己的停止控制器，不复用旧的 aborted signal。

**接口边界。** 公开 ThreadStartResponse 含 reasoningEffort，不代表本项目现有 SDK port 已提供它。本轮没有新增实际 effort 捕获，也没有读取未公开模型 API。所保存的 effort 是请求值，不能称为服务器实际执行值。SDK 类型枚举也不是某个 provider/model 的实时支持清单。

## OpenHands：沿用保存设置与显式更新分别处理

**证据。** [ConversationState L526-L560](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/conversation/state.py#L526-L560) 恢复时先反序列化保存状态；未传新 Agent 就保留原 Agent，显式提供 Agent 才校验兼容性并覆盖。[LocalConversation L402-L406](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L402-L406) 将保存的 Agent 用作活动运行对象。

LLM 设置含 [model 字段](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/llm/llm.py#L272-L276)和 [reasoning_effort 字段](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/llm/llm.py#L566-L576)。显式 switch 在 [L1673-L1680](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L1673-L1680) 同时更新活动 Agent 和保存状态。[持久化写入 L430-L451](https://github.com/OpenHands/software-agent-sdk/blob/54daf056bd863bb46f922a2fe9324dd736b37ff6/openhands-sdk/openhands/sdk/conversation/state.py#L430-L451) 使用完整状态模型序列化，而不只保存 conversation ID。

**本轮采用。** 恢复原业务运行时使用原设置快照；创建明确的新业务运行时才按新运行的配置进行选择。全局配置改变不是原 Planner 重新配置的指令。

**边界。** 本项目没有增加 OpenHands Agent 持久化、LLM registry 或 switch API，不采用其模型和 `high` 默认值。快照字段不能重建已退出 App Server 的 ephemeral 上下文，也不能作为实际模型计费或实际 effort 的观测证明。

## 本项目的设置来源与兼容选择

| 来源 | 本轮处理 | 不能声称的能力 |
|---|---|---|
| 客户端已解析 wire 模型 | `onModel` 保存原运行的解析值，continuation/resume 保留 | 仅凭请求模型推断 provider 最终执行模型 |
| requested effort | 启动前保存，失败/abort 保留，自动和手动继续沿用 | 已捕获 server actual effort |
| legacy 缺快照字段 | 保留既有 config fallback | 恢复了未知的旧 model/effort 选择 |
| 私有转换回合 | 继续使用固定 `low`，不把它回写为 Planner 的业务 effort | 将转换设置等同于规划设置 |

研究时提出的“旧记录省略 override”没有采用：在本项目当前 PlanMode 中，省略设置会重新选择 preset，不能作为可靠继承未知历史设置的方式。本轮选择兼容原 config fallback，并明确其历史不可知边界。新的带快照运行优先使用本次保存的选择。

实际红绿和最终门禁见[第九轮记录](../iterations/2026-10-05-ninth-planner-settings.md)。本轮不扩大模型能力声明，不新增依赖，不推算 Token 或费用。研究结束时 Agent Reach 更新检查为 `v1.5.0` 最新；写入本文档时没有再次联网或调用正式模型。
