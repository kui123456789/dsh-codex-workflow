# 2026-10-05 第十轮：Planner 澄清沿用原子会话

本轮修复正常澄清 continue 创建新 child，以及 normalized needs_input 没有 pending 时通过 resumeWithNewTurn 重新 thread/start、重发原 task 的路径。原生待回答请求与已完成回合的后续输入分别驱动，原 DSH child 和 Codex thread 持续复用。固定源码与许可见[澄清生命周期研究](../research/github-clarification-lifecycle-patterns-2026-10-05.md)。

## 两种澄清驱动

| 已确认状态 | 本轮驱动 | 回合身份 |
|---|---|---|
| 原回合有有效 request_user_input pending | 本地适配器发送原 requestId 的 JSON-RPC response，将答案回复原回合 | 原 Codex turn 继续 |
| 原回合已正常 completed，结果解析为 needs_input，无原生 pending | 原 thread 上 turn/start，发送短 answers followup | 原 thread、一个新 Codex turn |
| 原句柄失效或回合状态不明 | 明确拒绝或报告状态；不重建替代上下文 | 不补建 child/thread |

本项目适配器方法名为 `continueTurn`，它回复 JSON-RPC request；官方协议没有 wire `turn/respond` 方法。`waiting_input` 是 workflow 业务状态，不能代替 pending request/原 turn 生命周期证据。两条合法澄清路径都不重新 `subagents.start`，不重新 `thread/start`，也不重发完整初始任务。

## 原 child 的暂停与继续

正常 completed 后需要用户输入时，通过 child.pauseForInput 暂停原子会话，不把它 settle 为终态。下一条短答案 followup 在原 child 中追加回合，继续遵循原生 turn、message、step 和工具生命周期；原侧栏会话身份保留。

本轮新增三个显示／冷读回归用例，覆盖普通显示和 none/zstd 格式下暂停、继续及同一 child 的事件回放。两套指定 suite 共 **6/6 通过**；澄清回合标记为 completed、不会 settle/dispose，重复暂停不会 double-end，最终输出来自回答后的计划。实际 ClientAssistantStream/BlockAssembler 与 V4 持久关系检查通过，pending tools 为 0。这些使用隔离测试数据，不代替真实 DSH UI 验收。

## 输入 admission、pin 与失败保存

澄清输入先经过 input admission，按原 workflow 的授权、等待状态和当前驱动资格接纳，避免并发答复分别启动续跑。pinLifecycle 管理原 Planner 的保留和终态收尾；等待澄清不是释放原运行并创建替代子会话的条件。

回答续跑发生模型失败或 abort 时，保存本次 answersPrompt，使后续原线程恢复仍能取得未完成的澄清答案。这份提示词只保存在当前进程运行态，不构成持久 workflow 答案存储，也不提供进程重启后的原 ephemeral 恢复保证。

模型失败后的 continuation、用户回答澄清后的 continue 和正常 completed-question followup 保持各自语义。取消、停止和终态清理仍需释放原 child/subscription/pin 一次；并发、迟到结果和缺句柄不能通过新建 Planner 掩盖。

## 已知红绿基线

以下计数由主任务提供，文档子任务没有重复运行测试：

| 阶段 | 已知结果 | 范围 |
|---|---|---|
| 补丁前定向澄清红例 | **15/15 红例** | 原 child/thread 被替换及澄清输入生命周期缺口 |
| 主任务补丁后新组合 | **60/60 通过** | 本轮已运行的组合回归基线 |
| 补充澄清回归 | **25/25 通过** | 两种问题来源、多次澄清、并发回答、所有权、停止、失效句柄及预先中止入口 |
| 取消与原生输入提交竞争 | 原 start 路径临时复现先红，新增 start/resume 两入口 **2/2 绿** | 旧红案例发现取消先赢时 pending 条目阻止 unsubscribe；未声称亲测旧 resume 红 |
| 既有集成组合 | **150/150 通过** | child 冷读、澄清与原有 workflow 流程；最后针对性组合 **61/61** |

终态清理不再根据 `pending.has()` 跳过释放：`retained` 明确区分仍由澄清 owner 持有的资源与本次执行需要收尾的资源。新 commit-race 回归记录原始 dispose、unsubscribe、pin 各一次，重复 cancel/stop 不增加计数。

原完整测试中的“新 Manager 在重启后续跑澄清”断言要求新建 ephemeral Planner，违反原线程约束。该测试已更新为：原设置仍可读取，但 continue 明确拒绝，线程、模型和转换调用均为 0。最初完整门禁 **680 项中 1 项失败** 正是旧契约；最终完整验证记录如下。

## 新增回归与最终门禁

| 检查 | 预期覆盖 | 当前状态 |
|---|---|---|
| 原生 pending reply | 原 requestId、原 turn；答案投递一次；不新建 child/thread | **通过**；真实 Manager/SQLite 经本地 transport seam 使用同一个 pending 对象 |
| completed-question followup | 短答案 turn/start；原 child/thread；新 turn；不重发原 task | **通过**；任务 sentinel 不出现在答案／继续 prompt 中 |
| 重复或连续澄清 | input admission 生效；第二次问题继续原会话；重复答案不重复驱动 | **通过**；多次提问同一 thread/child、相同答案不同 key 顺序共享一次执行、不同答案明确拒绝、foreign owner 先拒绝 |
| answersPrompt 失败保存 | 回答后的失败/abort 可在当前进程继续；提示词不丢失、不假装跨进程恢复 | **通过**；回答后 generic failure 一次继续再等待，abort 后可原线程 resume，短答案仍在 prompt 中 |
| none/zstd 冷读三个新增场景 | pauseForInput 不 settle；原子会话多回合回放与格式关系有效 | **通过**；三个新增用例，指定两套 suite 共 6/6 |
| cancel/stop/句柄失效 | 清理一次；无迟到新子会话；不调用 SDK reconstruction 替代原 ephemeral | **通过**；等待与回答执行中 cancel/stop、无线程／无 pending、重启和 legacy 无 input handle 都覆盖；预先中止调用不消耗原问题 |
| `pnpm typecheck` | 类型检查 | **通过** |
| `pnpm test` / `pnpm verify` | 完整通过/失败/跳过计数与日志 | 最新 **692/692 通过**，失败 0、跳过 0，约 47.6 秒 |
| `pnpm release:check` | 发布、离线 doctor 与包审计 | 夹具修复后 **连续两次通过**，均 692/692、失败 0、跳过 0；残留异步／unhandled／关闭存储诊断均为 0，离线 doctor 与包审计通过，临时 tarball 已清理 |
| `pnpm host:check` / `pnpm host:recovery:check` | 实际安装宿主的隔离兼容与恢复检查 | **均通过**；DSH `0.1.7-rc.2`、九个工具、卸载及 peer/sidebar 契约；四项既有恢复／清理场景均一个 child、一次可见 thread 创建，pending tools 为 0。该宿主脚本未新增澄清场景，不把其四项结果替代本轮 25 项澄清源码回归 |
| 正式 DSH UI / 实际模型 | 原子会话内回答澄清、追加 followup 及失败继续的实际证据 | **本轮未重载正式 DSH、未新增真实模型调用**；PID 45264 仍为第六轮实测版本，本轮最新 `lib/` 已构建 |

验收分别记录原生 JSON-RPC reply 与普通 followup 的 request/turn/child/thread 身份关系。此前门禁、上游测试源码、安装宿主隔离检查和正式 UI 验收各自保留证据；不推算 Token 或费用。正式 DSH 配置和生产日志未修改。

系统临时目录日志：`dsh-tenth-targeted-tests.log`、`dsh-tenth-integration-tests.log`、`dsh-tenth-final-targeted-tests.log`、`dsh-tenth-input-commit-race-green.log` 和 `dsh-tenth-final-verify.log`。修复后最终门禁在 `dsh-tenth-final-gates-fixed-9a459b48-ca6a-41db-9db0-d968c8439b0b/`，summary 明确区分源码澄清回归与宿主四项既有场景。

## 发布门禁发现的旧测试竞态

首次发布检查 **691/692 通过**，失败于 Bridge claim-owner 租约隔离测试；原失败日志保留在系统临时目录 `dsh-tenth-final-gates-907f7ec3-4da1-4116-8547-0c9f81f196f7/release-check-1.log`，不能计入连续成功。

测试把 lease 设置为 300ms、首续约观察为 100ms，随后固定等待 250ms，导致 takeover owner B 的租约也可能过期，仍在轮询的 A 可以重新抢占。断言失败后，finally 未停止 A 就关闭数据库，进而出现 `coordination store is closed` 和测试结束后的 unhandled rejection。单例独立复跑为绿，未证明全量稳定。

夹具现在保持 A 原短租约，使用真实 epoch/owner renewal 保持 B 的 takeover 有效；不启动 A 的轮询 timer，直接等待一次实际 pump 完成。所有“无 apply/relay/receipt”和 B-owner 断言都在 A.stop 前，验证 lease fencing，不以停止运行掩盖副作用。最后无论断言是否成功都停止 A，再关闭 SQLite。生产代码未变。

修后 Bridge suite **48/48 通过**，无 after-test activity。一次临时负控将 lease-renewal failure 改为 success，测试确实因旧 owner 写入 applied identity 变红；负控已立即还原，不保留在源码中。随后连续两次完整发布检查均 **692/692 通过**，此前失败证据仍保留。
