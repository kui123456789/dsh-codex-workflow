# GitHub Token 计数、归属与预算机制核验

核验日期：2026-10-05。通过 Agent Reach 的 GitHub / `gh` 后端检索，再使用 GitHub contents API 按固定 SHA 读取源码和 LICENSE。候选按本项目的用量观测问题选取；本报告未复制上游实现，也未运行上游测试。

## 来源快照

| 项目 | 固定提交 | 许可 | 核验重点 |
|---|---|---|---|
| openai/codex | `823ea830c0fd418b09ff02d36cad9a1fff66465b` | [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE) | 用量层级、实际模型归属、预算去重 |
| anomalyco/opencode | `907b3bc518fa48e90e8ec24dd327d13eee71c36c` | [MIT](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/LICENSE) | 完成步骤计数、幂等投影、缓存与推理口径 |
| aaif-goose/goose | `fb7d185b0581e8a64d2ea3404dcfdd32a0aea782` | [Apache-2.0](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/LICENSE) | 独立持久账本、历史保留、费用来源 |

以上提交均经 commit API 核验存在，许可证由元数据和固定提交 LICENSE 双重核验。Codex 分支在检索期间继续更新，报告仅描述表中固定提交，不把搜索索引显示的其他 SHA 混入证据。

## Codex：区分响应、回合、线程和预算口径

- [SessionState L210-L245](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/state/session.rs#L210-L245) 在记录用量时同时保存 `thread_id`、`turn_id`、`session_id`、`root_turn_id`、`response_id`，并区分本响应的 usage、回合累计和线程累计。回合累计只继承同一 turn 的历史值。
- [TurnTokenUsage L15-L44](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/state/turn_token_usage.rs#L15-L44) 按实际产生响应的 model 分组，再发出 total/input/cached input/cache write/output/reasoning output 指标；同模型在一个回合内的多次响应合并为一个指标样本。
- [GoalAccounting L232-L240](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/ext/goal/src/accounting.rs#L232-L240) 要求在读取进度快照、持久写入和标记已计数整个窗口持有同一 permit，避免并发完成钩子重复收费；[L426-L442](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/ext/goal/src/accounting.rs#L426-L442) 在写入成功后推进已计数基线。
- [L508-L531](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/ext/goal/src/accounting.rs#L508-L531) 从累计值计算尚未计入的差值，goal 预算口径为 input 减 cached input，再加 output。它不是直接累加 `total_tokens`，也不是美元账单。

采用：为本项目的用量记录保留明确的 scope/source；先确定事件是绝对累计还是本次增量。持久化和推进基线必须原子完成，模型归属使用服务器报告的实际 model；缺少模型信息时保持未知。

边界：当前插件 App Server 通知不提供上述全部响应级关联字段，不能凭一个 `turnId` 声称已记录每次模型响应。上游预算公式属于其 goal 产品规则，不应默认为本项目的用户费用计算。这里核验的是 permit 和标记基线机制；未把注释当作本机持久故障验收。

## OpenCode：完成步骤计数可以更新而不重复累计

- [SessionProcessor L452-L470](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L452-L470) 在完成一个步骤时把用量写入 `step-finish` part，关联 `messageID` 和 `sessionID`，随后更新 assistant message。
- [SessionProjector L310-L326](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/projector.ts#L310-L326) 先查询同一个 part ID 的旧数据，upsert 新 part，再将旧 usage 从 session 汇总减掉、加入新 usage。[L89-L106](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/projector.ts#L89-L106) 给出实际 SQL 汇总更新；这是覆盖式去重的源码证据。
- [Session SQL L43-L48](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/sql.ts#L43-L48) 持久保存 cost、input、output、reasoning、cache read/write。
- [getUsage L338-L376](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/session.ts#L338-L376) 将 input 中的缓存部分和 output 中的 reasoning 部分拆开，以便分别计价；[L389-L401](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/session.ts#L389-L401) 使用模型价格或特定 provider 单位计算费用。

采用：本项目每个被观测的原线程保存一份最新绝对值；重复通知覆盖同一来源，不把每个累计通知再次相加。需要更新汇总时使用“新值减旧值”，写入同一个 workflow 的原子更新，终态清理也不能删除已完成的观测结果。

边界：OpenCode 拆分后的 `tokens.input` 和 `tokens.output` 与本项目的服务器原始口径不同，不能直接合并字段。也不应照搬其缺数据默认 0 或模型价格表作为用户实际账单。其删除 part/message 路径会撤销相关汇总，若本项目需要保留完整消耗史，账本必须独立于展示消息。

## Goose：独立账本保留被压缩掉的调用消耗

- [state_machine usage L50-L65](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/agents/state_machine/usage.rs#L50-L65) 将 usage、实际 model 和是否替换对话传给 SessionManager。
- [usage_ledger 表 L1084-L1097](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/session/session_manager.rs#L1084-L1097) 独立保存每笔会话消耗及 model、缓存拆分、cost/cost_source 和 compaction 标记。
- [record_usage_metrics L2354-L2363](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/session/session_manager.rs#L2354-L2363) 开启 `BEGIN IMMEDIATE`；[L2402-L2440](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/session/session_manager.rs#L2402-L2440) 在同一事务更新当前/累计用量并插入账本，随后提交。
- [test_usage_ledger_survives_conversation_replace L4990-L5008](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/session/session_manager.rs#L4990-L5008) 将对话替换为空后，断言历史用量仍是 1260，历史 cost 为 1.05。本次只核验测试源码，未执行该测试。
- [ProviderUsage L6-L30](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose-provider-types/src/conversation/token_usage.rs#L6-L30) 区分 provider 报价与 estimated；[Usage L88-L100](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose-provider-types/src/conversation/token_usage.rs#L88-L100) 明确 cache read/write 是 input 子集，计数缺失可保持 `None`。

采用：将长期消费记录和可丢弃的运行缓存分开；历史用量不依赖当前子会话、聊天压缩或原线程是否已经释放。缺失统计保持未知，价格估算单独标识来源。

边界：Goose 的账本 INSERT 在此路径没有依据 provider response ID 的唯一约束，不能把其实现当作重复通知安全的直接证明；本项目处理累计通知时仍需要自己的来源键与覆盖式更新。也无需迁移整套会话数据库、价格解析器或 Rust runtime。

## 本项目最小迭代建议

改动前现场核验：`ThreadTokenUsageLedger` 只保存每线程当前快照，默认容量 128；unsubscribe、进程退出、空闲关闭和停止会忘记快照。`WorkflowStatus.tokenUsage` 仅在当前原 Planner/Reviewer 线程可用时返回，明确是 `current_original_thread`。当前没有已完成调用的持久用量记录；这不是完整 workflow 消耗。

1. **先持久保存已观测原线程用量。** 在 `WorkflowRecord` 的可选 usage 字段保存 Planner/Reviewer 每个来源的最后绝对快照和汇总，原子写入已有 record JSON；旧记录没有该字段时显示未知。继续保留 128 条内存缓存用于实时查询，不以扩大缓存替代持久记录。
2. **为每个业务原线程绑定一个不包含原始 ephemeral ID 的来源键。** 绑定时关联 workflow 和 stage，通知覆盖同一来源的绝对计数；清理前等待用量写入完成。新来源从自身基线计算，重复通知不增长，累计值倒退应标记异常/未知，不能产生负消费。服务器进程更换必须使用新来源。
3. **把统计范围写进返回值。** 第一版可定义 `observed_original_threads`，覆盖已记录的原 Planner 与原 Reviewer，以及在这些同一线程执行的 continuation、转换或审查重写；其他线程和 CLI 调用不在范围内，不冒充全 workflow 总量。成功、失败、取消后仍能读到已观测值；未收到统计的调用记录缺失状态，不补 0。
4. **预算检查采用独立且公开的口径。** 可先展示已观测消耗，若以后启用 Token 上限，默认关闭，在接纳下一模型回合前检查，失败重试和 continuation 也检查；不得用字符数估算、未知 usage 或上下文窗口值伪造精确消费，也不能承诺模型生成途中不会超过上限。美元费用仅在有可靠价格来源与明确估算标识时增加。

当前原线程通知只给 total 与 last，`last` 是最近模型响应，未必覆盖整个 turn。第一版应诚实保留“来源累计快照”，不要人为切出精确的逐响应账单或把多个 total 通知相加。若以后要求全 workflow 归属，再扩大观测绑定到转换/对齐等内部回合，并新增独立调用账本；不要改变第一版 scope 的含义。

## 最小验收场景

- 同一来源通知 `100 → 150 → 150`：最终汇总 150；另一来源 30：总观测量 180。
- input 100、cached input 60、output 20、reasoning output 5：保存服务器口径，不把缓存和 reasoning 再加到 120 总量；不据此声称实际费用。
- Planner 完成后释放原线程、超过 128 条缓存淘汰、插件重启：持久统计仍能读取，调用没有统计时保持缺失。
- 两条并发通知、通知写入失败后重放、终态清理与通知并发：用量不会重复增长或被清理丢失。
- 原线程无统计、内部转换有统计：第一版原线程 scope 仍为空/未知，不将内部调用嫁接为原线程消费。
- 可选预算启用后，超过上限的下一次调用被拒绝；缺失统计和已生成中的超额行为按公开口径报告，不暗示硬计费保证。

以上是待实现建议，不构成本项目预算控制或真实 Token 节省的验收。研究源码保存在系统临时目录，仓库中只新增此报告。Agent Reach 更新检查：本机 `v1.5.0`，检查时为最新版本。
