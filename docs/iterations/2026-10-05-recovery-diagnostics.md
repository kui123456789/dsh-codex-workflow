# 2026-10-05 原会话恢复能力诊断

本轮在 `codex_workflow_status` 响应中新增只存在于进程内的 `continuation`，帮助 DSH 判断是否能在原子会话继续。诊断不会创建线程、读取模型线程、发送模型请求或持久化该字段；已有的审查心跳过期处理保留。

## 状态契约

| `continuation` | 含义 |
|---|---|
| `{ "available": true }` | 工作流正在等待继续，原运行句柄存在，当前 App Server 进程仍持有线程 |
| `{ "available": false, "reason": "running" }` | 恢复已被接纳或原回合正在运行，避免再提交恢复 |
| `{ "available": false, "reason": "thread_unavailable" }` | 句柄仍在，但所属 App Server 进程已丢失原线程 |
| `{ "available": false, "reason": "handle_unavailable" }` | 记录等待继续，但当前插件进程没有原句柄，例如插件重启后 |
| `{ "available": false, "reason": "cancelled" }` | 工作流已明确取消 |
| `{ "available": false, "reason": "stopped" }` | 插件生命周期已停止 |
| `{ "available": false, "reason": "not_waiting" }` | 当前阶段不等待手动继续，包括后台回调提交等待 |

查询先校验 DSH 会话归属，再检查进程内能力；响应不包含 ephemeral thread ID。`running` 需要当前恢复执行、active turn 或 callback 的运行标记，持久化的运行状态本身不能证明原回合还活着。旧测试/集成 gateway 未实现可选可用性探针时，保留相信内存句柄的兼容行为。返回值是查询时的快照，实际恢复入口仍须重新校验。

## 采用依据

与 [GitHub 机制核验](../research/github-workflow-patterns-2026-10-05.md) 中的 Codex 线程身份和 LangGraph 检查点身份分离一致：持久记录证明之前运行过，当前进程句柄才证明能继续。不会用历史编号创建替代 ephemeral 线程，也不会把后台持久回调的重试能力混同为用户手动 resume 能力。

## 验证记录

新增 `test/recovery-status.test.ts`，使用系统临时目录中的独立 SQLite 存储和本地假 gateway，不访问用户数据库、不消耗模型 Token。覆盖可恢复等待、旧 gateway、线程丢失、重启后无句柄、恢复启动窗口、Reviewer 运行、取消/停止、普通等待提交、缺失记录和另一 DSH 会话。断言新诊断不改变记录、没有模型请求且不泄露线程身份。

- `pnpm exec tsx --test test/recovery-status.test.ts test/app-server-availability.test.ts`：14/14 通过，其中诊断 11 项、真实测试子进程 3 项，失败 0。
- `pnpm exec tsx --test test/app-server-availability.test.ts`：3/3 通过，失败 0。使用真实测试子进程 PID 与线程 RPC 标记，证明冷探针不启动进程，解除订阅、意外退出和空闲退出后原线程失效；显式健康检查启动新进程也不继承旧线程。未调用真实模型服务。
- `pnpm typecheck`：通过。
- 合并后的 `pnpm verify`：503/503 通过；`pnpm release:check` 连续两次通过；`pnpm host:check` 通过，DSH 0.1.7-rc.2 与 9 个工具注册/卸载契约通过。完整背景见 [后台恢复迭代](2026-10-05-background-recovery.md)。正式 DSH 界面和模型使用量仍待现场验收。
