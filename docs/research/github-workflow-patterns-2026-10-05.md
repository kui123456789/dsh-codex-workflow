# GitHub 工作流机制核验与迭代建议

核验日期：2026-10-05。检索入口：Agent Reach 的 GitHub / `gh` 后端；源码通过 GitHub contents API 按固定提交读取。选型依据是与本项目的线程恢复、并发、取消和清理问题的关联程度；未将 star 数作为质量结论。这里只归纳机制，未复制第三方实现或引入其运行框架。

## 来源与许可

| 项目 | 本次固定提交 | 许可 | 对应能力 |
|---|---|---|---|
| [openai/codex](https://github.com/openai/codex) | `7f892275e31002f0422477c6219189284560e689` | [Apache-2.0](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/LICENSE) | 同线程多回合、线程恢复锁、监听器清理 |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | `907b3bc518fa48e90e8ec24dd327d13eee71c36c` | [MIT](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/LICENSE) | 按会话合并并发恢复、取消与资源释放 |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | `9a0394d88b2211f299dcd69df92db3480c69ee61` | [MIT](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/LICENSE) | 稳定检查点身份、重试策略、取消来源区分 |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) | `fb7d185b0581e8a64d2ea3404dcfdd32a0aea782` | [Apache-2.0](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/LICENSE) | 流式等待的取消、令牌下传、派生任务收尾 |

`block/goose` 在本次 GitHub API 查询中指向 `aaif-goose/goose`。许可名称由仓库元数据与固定提交的 LICENSE 双重核验。将来若直接移植源码，应保留对应许可与版权声明；本轮采用的是重新实现的设计机制。

## 已核验的源码机制

### Codex：线程身份与回合身份分开

- [Thread L40-L49](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/sdk/typescript/src/thread.ts#L40-L49) 定义一个 Thread 承载连续回合；[L77-L107](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/sdk/typescript/src/thread.ts#L77-L107) 向执行器传递已保存的 thread ID，并从 `thread.started` 更新句柄。
- [L125-L139](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/sdk/typescript/src/thread.ts#L125-L139) 对 `turn.failed` 抛出回合错误，不在此清空线程 ID。
- App Server [ThreadState L100-L154](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/codex-rs/app-server/src/thread_state.rs#L100-L154) 集中持有取消发送器、监听器代次与回合历史；[L364-L377](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/codex-rs/app-server/src/thread_state.rs#L364-L377) 将 goal edit / cold resume 锁限制在单个 thread。

采用建议：失败回合只更换 turn 身份；continuation 保留 workflow、Codex thread 与 DSH child 身份。借鉴按身份加锁，避免恢复工具与后台审查同时驱动原线程。

边界：SDK 的 [resumeThread L29-L37](https://github.com/openai/codex/blob/7f892275e31002f0422477c6219189284560e689/sdk/typescript/src/codex.ts#L29-L37) 面向已持久化会话；不能据此承诺本插件 ephemeral thread 在进程重启后可恢复。也无需把当前 App Server 传输改成 SDK CLI 执行方式。

### OpenCode：同一个 key 的恢复共享执行结果

- [SessionRunCoordinator L5-L22](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/run-coordinator.ts#L5-L22) 定义 `run`、`wake`、`interrupt`，每个 key 对应一个完成信号和 owner。
- [L67-L79](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/run-coordinator.ts#L67-L79) 在启动前登记 key；重复 `run(key)` 等待现有完成信号，没有再次调用 drain。
- [L94-L100](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/run-coordinator.ts#L94-L100) 取消时先标记 stopping、清除待唤醒标记，再 interrupt owner。
- 对应 [测试 L9-L28](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/test/session-run-coordinator.test.ts#L9-L28) 同时发起两次恢复，断言实际 runs 为 1。这里核验了测试源码，没有在本机运行上游测试。
- [SessionRunState L35-L48](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/run-state.ts#L35-L48) 在所属作用域结束时取消所有 runner 并清空集合。

采用建议：在本项目用按 workflow 的 Promise 表合并同一条 continuation；校验调用者归属后才允许加入已有执行。第一条指令拥有执行权，重复调用不能另发模型请求；不同指令应明确拒绝或由独立的新回合机制处理，不能静默丢弃。失败、成功、取消后都释放登记项。

边界：本项目已有原生 Promise / AbortController 和 SQLite 状态机，迁移上述机制无需引入 Effect、Bun 或另一个 session 数据层。OpenCode 的 wake 队列适用于持续积累输入，本轮恢复不需要自动追加第二个模型回合。

### LangGraph：重试、取消和持久恢复分别处理

- [BaseCheckpointSaver L183-L200](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/checkpoint/langgraph/checkpoint/base/__init__.py#L183-L200) 把稳定 thread ID 作为检查点存取键，区分独立运行与同一对话的反复调用。
- [同步重试 L613-L660](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_retry.py#L613-L660) 每次重试清理上一尝试的待写入项，并仅对匹配策略且未超过次数的错误重试。
- [异步取消 L773-L794](https://github.com/langchain-ai/langgraph/blob/9a0394d88b2211f299dcd69df92db3480c69ee61/libs/langgraph/langgraph/pregel/_retry.py#L773-L794) 区分框架取消和节点自行抛出的取消异常，避免失败节点被误判为成功收尾。

采用建议：用户明确取消和插件停止属于生命周期结束；模型或工具调用中止在原线程仍存活时可进入等待继续。用可验证的 signal / 生命周期状态判定原因，不能只靠 `operation aborted` 字符串。持久 workflow 状态与进程内可用句柄分开呈现；无句柄时明确不可恢复。

边界：检查点存在不意味着原模型上下文仍存在；本项目不能根据 SQLite record 的 thread ID 伪造 ephemeral 上下文。也无需改写为 Python 图执行引擎或清除已确认的历史审查证据。

### Goose：取消传播到正在等待的数据流

- [Agent L1839-L1849](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/agents/agent.rs#L1839-L1849) 同一个取消令牌进入会话流和回合流。
- [L2765-L2773](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/agents/agent.rs#L2765-L2773) 流读取同时等待取消信号，取消可以打断无新数据的等待。
- [L2937-L2951](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/agents/agent.rs#L2937-L2951) 取消令牌下传到工具和审批处理；[L3473-L3481](https://github.com/aaif-goose/goose/blob/fb7d185b0581e8a64d2ea3404dcfdd32a0aea782/crates/goose/src/agents/agent.rs#L3473-L3481) 中止后取消派生摘要任务并等待结束。

采用建议：每个 continuation owner 持有取消控制器；把调用者取消与插件生命周期取消传到请求、等待及退避。停止流程等待模型执行与清理完成，再关闭 App Server 和 store。

边界：可以借鉴取消传播顺序，无需引入 Rust runtime、Goose 会话数据库或其 extension 系统。模型调用被中止后的等待继续与显式取消必须保持不同终态。

## 对本仓库的迭代顺序

本地观察基于 `HEAD abb6174d283ced56590bee90b3511948e494b3f0` 加本次迭代开始时的既有工作区改动。它们是改动前的证据，后续代码变更后应以当前测试结果核验，不继续把旧行号当作现状。

| 优先级 | 改动前证据 → 发现 | 实施路径与验收 |
|---|---|---|
| 1 | `WorkflowManager.resume()` 直接 dispatch；runtime 只有 recoverableRuns，没有恢复执行表 → 两次恢复可以争用原线程 | 引入按 workflow 的 continuation owner；同指令只发送一个模型回合、不同调用者先校验归属、不同 workflow 可并行；取消和 stop 等待 owner 清理，结束后可再恢复 |
| 2 | `ReviewExecution.resume()` 未使用 instruction；existing 和自动 continuation 把完整 baseReviewTarget 再拼入请求 → 重复输入任务、用户继续指令丢失 | 复用原 thread / child，实际传递短 continuation 和用户 instruction；保留证据一致性检查，工作区变化应报告需要新审查；断言恢复请求不重复完整初始任务 |
| 3 | 恢复句柄存于进程内、等待状态存于 SQLite → 重启后状态与可操作性可能不一致 | status 区分等待继续与原句柄已失效；禁止以新 thread 静默替代；用重启与缺句柄测试证明 |
| 4 | 取消同时涉及 activeTurns、recoverableRuns、child 与 round pin → 多条失败路径容易重复或过早释放 | 集中 owner 释放与取消顺序；测试取消发生于 turn/start 前、流等待中、失败后及 stop 并发，断言只清理一次且无迟到状态回写 |

这些是具体迭代候选，完成状态由实现与验证记录证明。静态对比没有证明已节省多少 Token，也没有完成 DSH 真机验收。

## 核验方法

使用以下只读查询即可重新取得本次来源；源码路径与完整 SHA 已列于各 permalink：

```powershell
gh api repos/anomalyco/opencode/commits/907b3bc518fa48e90e8ec24dd327d13eee71c36c --jq .sha
gh api 'repos/anomalyco/opencode/contents/packages/core/src/session/run-coordinator.ts?ref=907b3bc518fa48e90e8ec24dd327d13eee71c36c' --jq .content
gh api 'repos/anomalyco/opencode/contents/LICENSE?ref=907b3bc518fa48e90e8ec24dd327d13eee71c36c' --jq .content
```

`contents` 输出的 content 为 Base64；本次读取后在系统临时目录解码核验，未将上游源码写入仓库。Agent Reach 更新检查结果：本机 `v1.5.0`，检查时为最新版本。
