# 2026-10-05：会话恢复与生命周期迭代

本轮从当前 D 盘仓库的既有工作区继续。目标是让失败后“继续”落到原 Codex 线程和原 DSH 子会话，并控制重复模型调用。源代码与隔离测试已改进；真实 DSH 界面及模型计费验收需要单独实测，不以静态宿主检查代替。

## 来源与采用决策

完整来源、固定 SHA、许可证和源码行号见 [GitHub 机制核验](../research/github-workflow-patterns-2026-10-05.md)。

| 来源机制 | 本项目采用 | 实施边界 |
|---|---|---|
| OpenCode 按 key 合并恢复请求 | 按 workflow 登记一次执行 Promise，归属校验先于加入请求 | 同指令共享结果；不同指令明确拒绝；无需引入 Effect |
| Codex 区分 Thread 与 Turn | 原 child/thread 上追加短指令和新回合 | ephemeral 进程丢失时不伪造恢复 |
| LangGraph 区分失败、取消和检查点 | 工具调用 abort 保留等待句柄，显式取消和 teardown 停止恢复 | SQLite 等待状态不保证线程仍存活 |
| Goose 取消传播与派生任务等待 | 恢复 owner 持有 AbortController，进入 foreground，stop 等待清理 | 子会话由 manager 生命周期持有，避免被单次工具 signal 提前销毁 |

采用设计机制后在现有 TypeScript 模块中实现，未复制上游源码，未新增依赖。

## 证据 → 缺陷 → 改动

| 改动前复现 | 缺陷 | 改动及回归证据 |
|---|---|---|
| 两次 Planner resume 产生两个 turn、两次 commit/dispose，并把恢复与无关业务的两个 pin 都减完 | 恢复无去重、资源所有权重复 | central resume 登记执行；活跃恢复接管等待句柄；cancel 取消 owner，由执行者最终释放 |
| 外会话 resume 进入 Reviewer observation 的写入入口 | 会话归属缺失 | 先执行 owned 校验；包括已存在 flight 时的外会话拒绝 |
| 恢复等待时 foreground.size 为 0 | stop 未等待恢复任务 | admitted resume 登记 foreground；stop 取消并等待它结束 |
| abort 被写成 failed，默认 status 找不到 workflow | 句柄返回前中止丢失恢复入口 | 非显式取消/teardown 的工具中止进入 waiting；无 ID 的 status/resume 找到当前会话记录 |
| Planner manual resume 未打开新的 child turn；Reviewer 忽略 instruction 并重发完整上下文 | 侧边栏继续缺失与重复输入 | beginContinuation 追加原子会话；Reviewer 继续走原 thread 的 turn/start，只发短指令 |
| cancel 赢 waiting CAS 仍保留 pin；child dispose 抛错可阻止 endRound | 清理分支泄漏 | 仅成功等待提交转移句柄；pin 和 subscription 释放放在 finally |

Reviewer 恢复前重新比较工作区证据；变化时释放旧句柄并要求新审查。成功后清除 retryState 和旧 error，等待中的失败回合不再误报 reviewerActive。

## 验证与复现

在仓库根目录运行：

```powershell
pnpm exec tsx --test test/workflow-resume.test.ts test/codex-child-session.test.ts
pnpm verify
pnpm release:check
pnpm host:check
```

新增公开接口回归使用真实 WorkflowManager、SQLite WorkflowStore、CodexChildSessionFactory 和受控传输，覆盖同线程恢复、跨会话拒绝、同指令去重、不同指令拒绝、abort、取消、stop、证据变化和清理异常。测试不调用真实模型。

本轮实测基线：`pnpm verify` 为 441/441；新增恢复 suite 为 22/22，原失败场景定向回归为 3/3。

| 最终门禁 | 2026-10-05 本次结果 |
|---|---|
| `pnpm verify` | 类型检查、构建通过；463 tests / 463 pass / 0 fail，用时 50.45 秒 |
| `pnpm release:check` | 连续两次 `RELEASE_CHECK_OK`；离线 Doctor 通过（5 项明确 SKIPPED）、打包审计通过、临时 tarball 清理 |
| `pnpm host:check` | DSH 0.1.7-rc.2；9 个工具注册及卸载通过；peerCompatible 与 nativeSubagentSidebarContract 为 true，使用隔离临时 storage |
| `git diff --check` | 通过；仓库现有 CRLF 提示不属于空白错误 |

当前 Web profile 的插件 Junction 指向 D 盘本仓库。上述检查只证明源码、构建、发布包及宿主加载契约；没有重启正式 DSH、运行真实模型或验证界面恢复。

## 真实 DSH 验收

1. 确认宿主实际加载本轮构建，在隔离演示目录触发 Planner 或 Reviewer。
2. 回合出现可恢复运行故障后，在同一 DSH 父会话发送“继续”；检查 resume 调用，原 child id 与 thread id 保持一致，原子会话追加继续消息。
3. 同一指令重复请求只启动一个回合；取消和停止后无迟到计划/审查回写。
4. 记录实际输入 token 与缓存命中数据，再评估节省量；当前只证明没有重复发送完整初始提示词。

## 后续迭代入口

- 恢复能力可观测性：status 明确区分 durable waiting 与失效的进程内句柄；覆盖 App Server 重建及插件重启。
- 后台审查统一：把 callback/submission 的持久重试纳入同一 owner 生命周期，避免反复创建 Reviewer、pin 泄漏和重新发送完整初始任务。
- 模型运行预算：区分 continuation 次数、上游退避与内部转换成本，并记录实际使用数据。
- 模块边界收紧：替换 ReviewExecution/SubmissionExecution 中的 AnyFn 端口，以类型约束恢复和释放关系；仍使用现有测试与存储契约。

这些事项尚待实现和验证；持续优化目标保持进行中。
