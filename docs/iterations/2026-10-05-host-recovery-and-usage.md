# 2026-10-05：宿主恢复验证与实际用量记录

接续[后台恢复](2026-10-05-background-recovery.md)和[恢复能力诊断](2026-10-05-recovery-diagnostics.md)。本轮验证实际安装的 DSH 服务，并补齐 App Server 用量通知入口。

## 现场解释与代码证据

| 现场解释 | 当前可验证的行为 |
|---|---|
| start 未返回 ID，便无法调用 resume | `workflowId` 可省略；在原父会话查找属于它的 active workflow |
| start 失败消耗唯一配额 | 文案用于避免重复启动；没有永久失败配额，恢复应调用 status/resume |
| Codex 托管会话不是原生子会话 | 当前调用真正的 `SubagentRuntime.start()`；宿主目录与投影保持 child 身份 |
| ephemeral 中止后都不可恢复 | 已知原线程仍在同一进程时可继续；进程丢失后明确拒绝恢复 |
| status 没有 active workflow，证明记录不存在 | terminal 记录被默认过滤；thread/start 返回 ID 前的中止仍有持久 failed 记录 |

所有 workflow 工具的恢复提示直接写在工具描述里，因此 `autoTriggerMode: off` 下显式调用也有规则：无返回 ID 时先 `status {}`，仅在 `continuation.available=true` 时 `resume`；运行中等待，不可用时报告实际原因。父会话不补写替代计划或审查，也不自动建立替代 workflow。

启动还未返回 thread ID 时，没有已知原线程可继续。新增边界回归确认失败记录存在、资源释放一次、恢复不产生模型调用，不把这类启动失败伪装成成功恢复。

## 真实宿主服务烟测

新增 `pnpm host:recovery:check`。通过实际安装的 DSH `0.1.7-rc.2` 加载 Cordis、ToolRuntime、AgentRegistry、SessionProjectionRegistry 和 SubagentRuntime。工具走真实 `ToolRuntime.execute()`；AgentFactory 使用隔离内存会话，模型网关使用本地脚本结果，SQLite 存储位于系统临时目录。

四个场景为 Planner 恢复、Reviewer 恢复、等待时取消、等待时停止。每个场景断言：

- 仅一个原生 child 和一个可见 Codex thread；恢复发送短 continuation，追加第三个原生回合。
- subagentCatalog 身份和 sidebar resource 地址保持一致；真实 Session 事件重放与消息派生一致。
- 未完成工具调用为零；每个 child 的原始 `dispose()` 调用次数为一次，round pin 归零。
- 成功审查只计一个 review cycle；取消、停止不会生成替代结果。

该测试没有启动正式 DSH、调用真实模型或读取用户会话库。当前会话没有可用的 Computer Use `node_repl` 驱动；浏览器视觉和真实模型故障验收仍未完成，烟测结果显式输出 `browserUIVerified: false`。

## 实际 Token 用量入口

以前 `onNotification()` 忽略了 `thread/tokenUsage/updated`。新增 `usage-accounting.ts`，保留服务端累计 `total` 和最后一次模型响应 `last`；记录输入、缓存输入、可选缓存写入、输出和推理输出。通知结构参考[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，并用本机 CLI 生成的协议类型核验。

使用权威累计快照替换旧值，重复通知不重复累加；最多保留 128 个线程。未知线程与非法计数不进入客户端记录，副本避免监听器修改内部数据。解除订阅、停止、空闲退出和进程故障清除旧计数；缺失通知或可选字段保持未知。

`status.tokenUsage` 只读、先校验会话归属、没有 RPC、不暴露线程 ID、不写入工作流记录。它描述当前原线程的服务端累计计数，包含在该线程执行的 continuation 或 conversion；其他线程、CLI 操作、前几轮审查和父 DSH 模型不在范围内。内部转换期间不把私有活动标成原线程显示回合。它不是整个工作流的账单；`last` 也不保证覆盖整个 turn。

真实测试子进程输出的两轮样本累计为 215 tokens，缓存输入为 130、缓存写入为 9、推理输出为 11。这些是协议测试数据，不是实际用户模型消耗或节省量。

## 交叉审查发现的终态残留

Planner 在 `onStarted` 后遇到权限类终止错误时，旧 active-turn 映射未删除；失败记录仍被诊断为 `running`。新增真实 Manager/SQLite 回归先失败，再修正 start/resume 的终态清理。原生澄清等待和可恢复句柄保持原有取消语义。Reviewer 已有对应清理。

状态入口也先排除终态，避免旧映射让 failed/passed/blocked 暴露活动用量或运行中的恢复能力。

## 验证入口

```powershell
pnpm exec tsx --test test/usage-accounting.test.ts test/recovery-status.test.ts
pnpm exec tsx --test test/workflow-resume.test.ts test/start-boundary.test.ts
pnpm verify
pnpm release:check
pnpm release:check
pnpm host:check
pnpm host:recovery:check
git diff --check
```

## 最终门禁结果

| 检查 | 本轮实测 |
|---|---|
| `pnpm verify` | 类型检查、构建通过；523/523 tests，失败 0，用时 44.00 秒 |
| `pnpm release:check` | 连续两次 `RELEASE_CHECK_OK`；各自全套测试通过；离线 Doctor 正常且 5 项明确 SKIPPED；打包审计通过、临时包清理 |
| `pnpm host:check` | DSH 0.1.7-rc.2；9 个工具注册/卸载通过，peer 与原生 sidebar 契约通过 |
| `pnpm host:recovery:check` | 四个场景通过；原线程与 child 计数均为 1，消息重放有效、未完成工具为 0 |
| `git diff --check` | 通过 |

日志保存在系统 Temp：`dsh-third-final-verify-20261005.log`、`dsh-third-release-20261005-1.log`、`dsh-third-release-20261005-2.log`、`dsh-third-host-20261005.log`、`dsh-third-host-recovery-20261005.log`。没有提交、推送、发布或重启正式 DSH；既有未提交改动保留。

正式 DSH 界面、真实模型 Token 和外部故障验收作为后续工作，持续优化目标保持进行中。
