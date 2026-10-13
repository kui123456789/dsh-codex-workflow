# Planner 成功步骤复用与自动继续额度归属核验

核验日期：2026-10-06。通过 Agent Reach 的 GitHub／`gh` 路线读取固定源码和官方测试，同时以 Context7 resolve-library-id → query-docs 核对 LangGraph 与 Temporal TypeScript SDK 的现行文档。原始公开证据保存在 C TEMP，本报告整理进 `docs/research/`；研究阶段未修改仓库源码/测试、添加依赖、执行上游测试/服务或操作正式 DSH。本地采用与实际验证见对应迭代记录。

## 结论与采用方向

将“模型可读规划已成功”和“下游转换仍待完成”保存为原 Planner 运行的两个阶段，恢复只执行失败阶段；同一业务运行的自动 continuation 额度必须独立保存，人工 resume 不重置。成功结果、可继续的原 thread/child 和自动预算是三个不同事实，不能由一个进度标记推导另外两个。

LangGraph 提供成功步骤恢复正例，但它的 retry policy 在人工恢复时重新提供局部尝试额度，因此**不能照搬其预算语义**。Temporal 将普通 resume 与显式 reset 分成两条入口，是预算隔离的合适参考；本项目仍维持整个规划业务最多一次自动继续的自己的契约。

## 方法、既有证据与新增证据

- 已先尝试 CodeGraph；实际返回无可用索引，未初始化。随后只读本地 `AGENTS.md` 与已有研究文档。
- `agent-reach doctor --json` 的 GitHub 后端列出 gh，但 active_backend=null，原因是 doctor 不进行会写 device-id 的认证验证。实际 gh commit/content API 成功获得非空公开源码，才确认本次读取可用；没有执行 `gh auth status`。
- 复用 `docs/research/github-foreground-stage-checkpoint-patterns-2026-10-06.md` 的 LangGraph 固定提交与 pending-writes 研究，复用 `github-run-settings-and-progress-fencing-2026-10-06.md` 的 Temporal 固定提交与普通 retry 接缝。本轮重新抓取并阅读具体源文件与许可证，避免把旧笔记当新测试结果。
- 新独立证据：LangGraph `test_no_redundant_put_writes_for_cached_task`、retry 局部计数；Temporal `UnpauseActivityWithResume`/`WithReset` 源码、对应 acceptance tests、`nextBackoffInterval` 上限与测试。
- Context7 已 resolve LangGraph → `/websites/langchain_oss_python_langgraph`，query 成功；Temporal TypeScript SDK → `/temporalio/sdk-typescript`，query 成功。现行文档用于发现/解释，精确结论以固定源码为准。SDK 文档不等同于下面的 server 实现验证。
- Agent Reach v1.5.0 的 check-update 返回已是最新版。没有自动更新。

## 固定来源与许可

| 来源 / 范围 | 固定提交 | 固定许可 |
|---|---|---|
| langchain-ai/langgraph | `2d942085e214ef6b99b6f54ed4d544a7c7c5ac56` | [MIT][l-license]，本轮读取固定 LICENSE |
| temporalio/temporal server | `4db93cd73eb12f4aa12e244f6419b506cbd35dc0` | [MIT][t-license]，本轮读取固定 LICENSE |

两者官方公开仓库的实时元数据分别返回 42,755 / 23,486 stars；这只作来源筛选辅助，不证明实现正确。本轮不复制代码或引入任何服务。

## LangGraph：成功输出归原步骤，失败步骤继续

**Evidence。** [`_reapplies_pending_writes` 与 `_reapply_writes_to_succeeded_nodes`][l-restore]把 checkpoint 中完成 task 的 output 放回原 task；失败或中断 task 的 writes 仍为空，供 runner 重执行。它明确区分普通恢复和主动 replay。

**Test。** 官方 [test_pending_writes_resume][l-resume-test] 首次 `one.calls=1`、`two.calls=2`；同一 `thread1` 人工 `invoke(None)` 再失败后，仍 `one.calls=1`，而 `two.calls=4`。失败步骤修复后合并成功 one 的原 pending output。本轮实际重新阅读测试，未执行。该例是并行节点，不直接证明本项目“可读规划→结构化转换”的完整串行路径。

新增官方 [test_no_redundant_put_writes_for_cached_task][l-cached-test] 在串行 setup→ask 路径人工恢复后，spy 断言仅 ask 与 entrypoint 两个 task 发生 put_writes，cached setup 不被重复提交。该例覆盖中断恢复的保存接缝，不是下游模型错误的端到端证明。

**Budget 边界。** [`run_with_retry`][l-retry-init] 每次函数调用初始化 `attempts=0`；[失败后累加、达到 max_attempts 则退出][l-retry-check]。前述 resume 测试中 two 的 2→4 已直接证实：人工恢复仍得到新的一组局部尝试。本项目只能借成功结果检查点，不能借该局部 retry counter 表示整个业务最多一次 auto continuation。

Context7 的 [Functional API][l-functional]说明：恢复从 entrypoint 起点重放，已完成 task/subgraph 取保存输出，非确定性工作和副作用须封装为 task。step/task 顺序或输入改变不能靠同名称盲复用；本项目仍自行验证 scope、settings、contract、task 和原 thread/child 身份。

## Temporal：普通继续和重置额度是不同操作

**Evidence。** [RetryActivity][t-retry] 从原 ActivityInfo 读取 `Attempt` 和 `RetryMaximumAttempts` 计算是否可重试，获准后只把该 activity 的 attempt 加一。[nextBackoffInterval][t-limit]明确 maximumAttempts 包含首次调用，`currentAttempt >= maxAttempts` 返回 MAXIMUM_ATTEMPTS_REACHED。这不是每个 observer/request 新初始化的计数。

[UnpauseActivityWithResume][t-resume]只解除 paused 状态并按需要重新调度，不给 Attempt 赋初值；[UnpauseActivityWithReset][t-reset]则显式 `Attempt=1`。旧兼容入口 [UnpauseActivity][t-legacy-unpause]同样只在 `resetAttempts` 参数为 true 时清零。人工继续与重置意图在源码入口处分开，适合本项目普通 resume 不刷新 auto budget 的契约。

**Tests。** 官方 [retry upper-limit test][t-limit-test]传入 currentAttempt=10/maxAttempts=10，断言 NoBackoff 与 MAXIMUM_ATTEMPTS_REACHED；[MutableState retry test][t-attempt-test]确认原 activity retried 后 Attempt=2；[resume acceptance][t-resume-test]确认普通 resume 保持 attempt 并恢复计时；[reset acceptance][t-reset-test]确认 reset 的单独入口及 heartbeat 重置。均只读未执行。

**证明范围。** acceptance fixtures 的原 Attempt=1，因此测试断言本身不能区分“保持 1”和“错误清为 1”；耗尽后人工恢复不清零的方向来自固定源码分支及 upper-limit helper test，不能声称上游存在完整的“耗尽→manual resume→仍耗尽”端到端实测。reset 本来允许主动重置，本项目不采用该入口隐含给普通 resume 新额度。

Temporal 支持独立 Activity 的策略预算；本项目约束是整个 Planner 业务的一次自动 continuation，范围更大。不能为 readable、conversion 各配置一轮并宣称全业务仍一次。也不能把 server 持久状态等同于 DSH ephemeral App Server thread 跨进程恢复。

## 本项目实施与验收契约

| 边界 | 应采用/验证的行为 |
|---|---|
| readable 真正完成并通过显示契约 | 保存其权威文本、原身份与 nextStep，conversion 失败不再次调用 readable |
| conversion 成功而最终提交暂时失败 | 保存已验证结果，普通 resume 只重试 finalizing，不补发新模型调用 |
| 整业务第一次可恢复错误 | 消费原运行的一次 auto allowance，继续原 thread/child 的失败阶段 |
| 自动继续再失败，随后 manual resume | 保留 allowance 已消费状态；每次人工只推进原失败阶段，不自动再加一回合 |
| 不可恢复权限/Schema/显示契约或身份改变 | 保持终态/冲突语义，不靠 checkpoint 隐藏新规划或在父会话代写 |
| cancel/stop/未确认 interruption ACK | 不提交旧输出；保留真实 writer barrier，计时超时不是已终止证明 |
| 当前进程失去原 thread/child/checkpoint | 准确报告 unavailable，禁止缓存进度补造成功文本或替代 Planner |
| 新业务与原恢复 | 只有明确的新业务身份建立自己的预算；普通 resume 不能成为 reset |

应以公开入口的真实模型请求、thread/start、subagents.start、child events 与 final CAS 计数验证：readable 成功→转换模型失败→同线程成功；auto 用尽→多次 manual 失败→最后成功且没有额外 auto；readable 失败使用了 auto 后 conversion 又失败不得再给一次；成功后 finalizing 失败恢复时 0 模型；cancel/stop 与 scope/settings drift 拒绝晚结果。上游研究没有执行或证明这些本地回归，结论由本轮迭代记录另行归档。

[l-license]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/LICENSE
[t-license]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/LICENSE
[l-restore]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_loop.py#L767-L783
[l-resume-test]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/tests/test_pregel.py#L891-L987
[l-cached-test]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/tests/test_pregel.py#L5909-L5949
[l-retry-init]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_retry.py#L574-L590
[l-retry-check]: https://github.com/langchain-ai/langgraph/blob/2d942085e214ef6b99b6f54ed4d544a7c7c5ac56/libs/langgraph/langgraph/pregel/_retry.py#L654-L661
[l-functional]: https://docs.langchain.com/oss/python/langgraph/functional-api
[t-retry]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl.go#L6946-L6972
[t-limit]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/retry.go#L69-L97
[t-resume]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity.go#L430-L452
[t-reset]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity.go#L455-L467
[t-legacy-unpause]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity.go#L391-L404
[t-limit-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/retry_test.go#L137-L149
[t-attempt-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/mutable_state_impl_test.go#L3316-L3327
[t-resume-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity_test.go#L497-L524
[t-reset-test]: https://github.com/temporalio/temporal/blob/4db93cd73eb12f4aa12e244f6419b506cbd35dc0/service/history/workflow/activity_test.go#L550-L577
