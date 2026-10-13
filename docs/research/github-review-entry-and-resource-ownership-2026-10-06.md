# 审查入口的共同任务身份与辅助资源归属核验

核验日期：2026-10-06。通过已读 Agent Reach 的 GitHub / `gh` 后端读取 BullMQ 新案例，并重新确认 VSCode 固定提交及许可。只借鉴具体机制，没有复制源码、引入依赖、运行上游服务/测试或调用模型。本轮关注跨 API 入口的共同任务身份和临时辅助资源的释放，与取消 ACK、纯 generation 机制分别记录。

## 固定来源与许可

| 项目 | 固定提交 | 许可 | 本轮核验机制 |
|---|---|---|---|
| taskforcesh/bullmq | `71c9ca72f32108e21f8d339b95ff750606806f60` | [MIT](https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/LICENSE) | 同 queue/key namespace 的 jobId 重复入队返回原任务身份 |
| microsoft/vscode | `182f2f5bf96b741fd0212115400a32a2c5298c26` | [MIT](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/LICENSE.txt) | DisposableStore 的 scope 清理，以及显式脱离/转移归属 |

许可按固定文件核验。选取依据是可见的去重条件与资源处理分支，没有用项目知名度推断质量。

## BullMQ：多入口必须落到同一个任务 key

**证据。** [Queue.addJob L370-L391](https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/classes/queue.ts#L370-L391) 接收并保留指定 jobId。[标准入队脚本 L86-L107](https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/addStandardJob-9.lua#L86-L107) 用 prefix + jobId 检查已有 job key；发现重复时先处理既有任务并返回，不继续执行 storeJob/入队。

[handleDuplicatedJob L8-L25](https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/includes/handleDuplicatedJob.lua#L8-L25) 对 parent 关联进行约束，记录 duplicated 事件并返回已有 jobId。另一种去重键的 [NX 分支 L45-L70](https://github.com/taskforcesh/bullmq/blob/71c9ca72f32108e21f8d339b95ff750606806f60/src/commands/includes/deduplicateJobWithoutReplace.lua#L45-L70) 使用同一 deduplication key 关联已存在任务。

**本项目建议。** 一个业务审查无论来自 foreground review 还是 Bridge submit，应先按 workflow 的 origin/mode 路由到合法入口，再进入共同的 workflow 审查接纳域。不同入口前缀的 lease 不会互斥；在入口各自创建 Reviewer/submissionId 之前应校验同一业务任务是否已有 owner。

**边界。** BullMQ 去重是同 queue/key namespace 的存储条件，不保证不同 queue 的相同字符串 ID 去重。它也没有替本项目比较 payload、授权调用者或共享 JavaScript Promise；本项目仍需已有的归属检查、规范化输入 signature 和业务相位判断。完成后保留的旧 job 或被删除后再次使用的 ID，也不能直接定义本项目的新审查轮次。明确新轮次与失败恢复必须分别决定身份。

## VSCode：scope 释放与资源转移是不同操作

**证据。** [DisposableStore.dispose L432-L439](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L432-L439) 幂等地关闭容器并 clear；[L452-L460](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L452-L460) 在 finally 清空资源集合。[delete L491-L499](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L491-L499) 移除资源并 dispose；[deleteAndLeak L502-L510](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L502-L510) 则只解除父归属，不执行 dispose。

[MutableDisposable L592-L608](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L592-L608) 替换 value 时释放旧 value，clear 也走该路径。这给资源归属的替换和正常退出提供了明确语义。

**本项目建议。** 创建临时 auxiliary thread 的 scope 负责 await 它的 unsubscribe/dispose；仅清除 active-turn 映射不算释放。若某个资源确需保留给恢复，必须把同一原 handle 和 release closure 显式转移给恢复 owner，不能让异常路径默默跳过 finally。

**边界。** VSCode 这里是同步 IDisposable，不证明远端 unsubscribe/中断已经完成；JavaScript 异步资源需要自己的 awaited finally 与原句柄确认规则。本例也不声称 disposed 容器会自动释放后来添加的资源：尽管一段注释这样描述，其 [实际 add 分支 L475-L481](https://github.com/microsoft/vscode/blob/182f2f5bf96b741fd0212115400a32a2c5298c26/src/vs/base/common/lifecycle.ts#L475-L481) 会警告 leak，未调用新对象的 dispose。采用范围以实际分支为准，不迁移其框架或依赖。

## 本仓库的只读候选

本地观察基于 `HEAD abb6174d283ced56590bee90b3511948e494b3f0` 加研究时共享工作区。CodeGraph 已先查询但索引不可用，随后只读相关入口。root 与其他 agent 正在分别验证真实 admission/resource flow；下表不是本轮实现完成证明。

| 入口 | 研究时源码事实 | 最小核验/修复方向 |
|---|---|---|
| [workflow.ts](../../src/workflow.ts) 的 admitReview | reviewFlights 按 workflow 合并同输入；跨 manager lease 使用 review:workflowId，进入后再核相位/owner | 保留既有前台单飞和写入 fence；还需明确 codex_bridge origin 的前台入口能否独立开始业务审查 |
| 同文件 submitInternal | 初始拒绝非 codex_bridge；使用 submit:workflowId 和 submission:workflowId:submissionId；取证包含 await | 前台 review 与 submit 的不同 lease key 不能互斥。共同接纳/路由及提交 mutation 应重核 origin、合法相位和当前审查 owner |
| 同文件 alignReview | 创建 ephemeral alignment seed thread，随后 normalizeInFork(sourceEphemeral:true)；finally 主要清 activeTurns | 给创建的 seed 一个明确 scope，成功、异常、取消、解析失败都走本 scope 的真实 unsubscribe |
| 同文件私有 reconciliation 分支 | 创建独立 seed，随后可见 rewrite 和结构化转换；active map 的 finally 不等于 seed 释放 | 相同 lexical scope 覆盖从创建到转换/重查的退出路径；只释放自己创建的辅助线程 |
| [app-server.ts](../../src/app-server.ts) 的 normalizeInFork | sourceEphemeral:true 直接 normalizeInThread；实际 fork 分支才在 finally unsubscribe fork | in-place 模式不创建新 fork，也不会替调用者释放 seed。创建它的上层 owner 仍须收尾 |

公共 review 返回最终业务结果，submit 返回排队/提交状态；这两种 API 不应仅因去重就盲目共享同一个返回 Promise。可以按 origin 路由到原提交生命周期，或明确拒绝不属于该 origin 的入口，同时保持各自公开返回契约。请求不同、调用者无权或工作区证据变化时，也不能静默加入别人的结果。

## 最小采用与验收路径

1. 把共享任务身份放在 API 分派之前：先授权，再按 origin/mode 选择合法流程，创建动作之前共同接纳。不要用不同前缀的两把锁证明跨入口互斥。
2. 同输入可以加入已有合法操作；不同输入明确冲突。真正新业务轮次由共同接纳点分配新身份，原失败恢复继续沿用原任务及句柄。
3. auxiliary helper 创建 seed 后立即建立自己负责的 awaited finally，包含模型调用、转换、解析和回查异常；原 Planner/Reviewer 和借用线程不能被这个 helper 释放。
4. 保留资源时显式转移归属到 process-local 恢复 owner，清理比较本次 handle；unsubscribe 的完成与原 server turn 终态仍按既有中断屏障分别判断。

建议本仓库回归覆盖真实 foreground review 与 Bridge submit 的并发入口、跨 manager 冲突及相位变化；auxiliary alignment 的 success/failure/cancel、创建之后 onStarted 持久化失败、CLI fallback 和 original Reviewer 保留。资源断言计 raw unsubscribe/dispose 次数与 pin/ref，不能用幂等计数包装掩盖重复调用，也不使用 fake hash 或新依赖代替真实 scope。

这些是机制借鉴与候选验收，本研究子任务只新增此文档，没有修改源码/测试或操作服务。SQL lease/CAS 约束记录和 owner，不能锁 live FS，也不保证模型全过程输入不可变。Agent Reach 更新检查时 v1.5.0 为最新版本；不推算 Token/费用或声明第三方框架已经移植。

## 补充核验：Codex 退订不确认回合终止

补充核验日期：2026-10-06。官方 `openai/codex` 固定提交为 `823ea830c0fd418b09ff02d36cad9a1fff66465b`，许可为 [Apache-2.0](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/LICENSE)。以下结论来自读取固定源码和上游测试；没有在本地执行这些上游测试。

**契约边界。** `thread/unsubscribe` 成功只确认当前连接已解除订阅，不确认原模型回合终止、运行态卸载或 writer 释放。它不能代替原 thread/turn 的中断确认。

| 固定源码证据 | 可核实行为 |
|---|---|
| [thread_processor.rs L1020-L1045](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/thread_processor.rs#L1020-L1045)；[thread_state.rs L528-L559](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/thread_state.rs#L528-L559) | handler 移除连接订阅后直接返回 `Unsubscribed`/`NotSubscribed`；此成功路径没有等待 active turn 中断或 shutdown |
| [thread_lifecycle.rs L56-L61](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L56-L61)；[L374-L404](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L374-L404) | unload 要求无订阅者且不 active；L381-L383 明确跳过 `Running` thread |
| 同文件 [L419-L423](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L419-L423)、[L445-L476](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L445-L476) | 后续异步任务才调用 `shutdown_and_wait()`，超时为 10 秒；shutdown 成功才移除运行态并随后通知 `thread/closed`，超时仍保留 loaded thread |
| [thread_manager.rs L1367-L1380](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/thread_manager.rs#L1367-L1380)；[L1341-L1342](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/core/src/thread_manager.rs#L1341-L1342) | `remove_thread_if_matches` 在写锁内用 `Arc::ptr_eq` 防止旧清理删除替代运行态；普通 `remove_thread` 只移除注册项并返回 Arc，不调用 shutdown |

上游测试 [thread_unsubscribe_during_turn_keeps_turn_running L197-L200](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L197-L200) 覆盖 0 秒及 1 秒 unload delay。[L319-L334](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L319-L334) 验证退订返回 `Unsubscribed` 后，工具仍阻塞时在 1200 ms 内没有 `thread/closed`；[L336-L364](https://github.com/openai/codex/blob/823ea830c0fd418b09ff02d36cad9a1fff66465b/codex-rs/app-server/tests/suite/v2/thread_unsubscribe.rs#L336-L364) 回答 pending dynamic tool 后回合完成，随后 thread 才关闭。

### 对前述建议的限定与采用规则

前文“本仓库的只读候选”保留为研究时源码观察，不代表共享工作区的最新实现或完整验收。BullMQ 的共同任务 key 解决接纳身份；VSCode 的 lexical scope 提供本地归属纪律。二者均不证明远端 writer 已退出，SQL lease/CAS 也不锁 live FS。

本轮采用由创建者持有的 process-local pending auxiliary 表：

1. 正常完成的 auxiliary scope 可以 await unsubscribe，补齐 seed 订阅释放。
2. typed auxiliary 中断确认 `ACK=false` 时，创建者保留原 auxiliary `threadId/turnId`、自身 pin 和 cleanup owner；未知运行状态不能用 unsubscribe 当作终止证明。
3. auxiliary 的恢复记录属于创建它的 helper，不借用原可见 Reviewer 的恢复 marker，也不把辅助 pair 挂到 Reviewer marker 上。
4. 原 pair 的中断确认或经核实的终态允许创建者释放一次；cancel/stop 继续重试同一 owned pair，不能先丢弃记录或替换 thread。

这些规则限定异常退出时 awaited finally 的动作：先保留未确认终止的原资源归属，确认后再释放；原 Planner/Reviewer 与借用线程的资源仍由其自身 owner 管理。本节记录已采用的归属决策和固定来源证据，不声称完整测试门禁、真实模型或 DSH UI 已通过。
