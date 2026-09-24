# Reviewer 线程写入者锁事故与 1.1.0 结构性修复（2026-09-24）

本记录把一次真实阻塞（约 1 小时 48 分）的现场证据、可复用的诊断手法、被证伪的假设，
以及随后 1.1.0 的结构性修复固化下来，避免下次再从零排查。

- 事故时间：2026-09-23 22:22:18 → 2026-09-24 00:10（本机时区，UTC+8）
- 受影响线程：`01a0ce97-fb91-7a30-a959-4b74b2d7db96`
- 受影响工作流：`49eb2c0d-2970-4573-bc8a-2edae4178c7b`（`origin: dsh`，cwd `…\projict\代充协议`）
- 修复版本：**dsh-codex-workflow 1.1.0**（Reviewer 永远使用专用线程）

---

## 1. 现象

插件审查（1.0.14 起走后端 `codex exec` CLI，且必须 resume 同一个工作流任务线程）反复失败：

```
thread-store conflict: thread 01a0ce97-fb91-7a30-a959-4b74b2d7db96 already has an active writer
Error: thread/resume: thread/resume failed: … already has an active writer (code -32600)
```

插件的 CLI 审计把 `active writer` 当**可重试**冲突（`src/codex-cli-audit.ts` 最多重试 9 次），
重试耗尽后把原文抛给工作流：记录停在 `phase: executing` + 该错误，工作流再也不会自动前进。
重试次数用尽前，最后的形态是 `Error: codex CLI audit aborted`。

## 2. 现场证据

### 2.1 锁持有者（Restart Manager 确证，非推测）

`~/.codex/thread-writer-locks/` 下三个锁文件**全部**由同一个进程持有：

```
PID 52484 | app=codex.exe | type=RmConsole | start=2026/9/23 19:29:10
```

`52484` 是 **Codex 桌面端自己的 app-server**（父进程 `ChatGPT.exe` PID 46148；
命令行 `codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled …`）。
它当时是**活的**：同一时刻仍在为其它线程服务（23:56 还成功 resume 了 `01a0cefb`），
并且正通过 `127.0.0.1:10808` 代理跑模型请求。

> ⚠️ 因此「锁没释放 ⇒ 进程死了」是错的：健康的 app-server 本来就会为**每条它已加载的线程**
> 一直持有写入者句柄。锁文件的 mtime 只等于"该线程被加载的时刻"，**不是活跃度指标**。

### 2.2 卡在哪一步（`~/.codex/logs_2.sqlite`）

22:22:18 前后整整 2 分钟的窗口里**只有一行**日志，且它的 span 精确指向目标线程：

```
app_server.request{otel.name="thread/resume" rpc.method="thread/resume" rpc.transport="stdio"
  app_server.client_name="Codex Desktop" app_server.client_version="26.917.51856"}
:resume_thread_with_history:thread_spawn:session_init:environments.resolve:shell_snapshot
{thread_id=01a0ce97-…}: Failed to create shell snapshot for powershell
process_uuid = pid:52484:…
```

时间线完全吻合，构成三角证据：

| 事实 | 值 |
|---|---|
| 启动这次 resume 的客户端 | **Codex Desktop 自己**（不是插件） |
| 锁文件创建时间 | 22:22:18 |
| 该线程 11 个 MCP 子进程创建时间 | 22:22:18（`tavern-tanuki` / `cua_node` / `qmd` / `codegraph` / `chrome-devtools` …） |
| 该线程 rollout 最后一次写入 | 22:22:18，之后**全库再未被提起** |

即：桌面端发起的一次 `thread/resume` 卡死在 `session_init`（`shell_snapshot` 之后、MCP 初始化期间），
这个任务永不结束，线程的写入者锁便一直被它握着。

## 3. 被证伪的处置假设

| 假设 | 结论 |
|---|---|
| 删锁文件 | ❌ 无效。持有者活着，句柄不解除；下次写入还会新建锁文件，变成两个锁，状态更乱 |
| 杀掉卡死线程的 MCP 子进程 | ❌ 无效（已实测）。18 个进程全部终止，app-server 也确实记录到了（同一条 resume span 下 `session_init.mcp_manager_init` → 各 server `input stream terminated` / `quit_reason=Closed`），但 resume 仍未结束、锁仍未释放 |
| 杀掉"残留的"另一个 app-server | ❌ 无效。`PID 28428`（`app-server --listen stdio://`，父进程 `node_repl.exe`）**不持有任何锁** |
| 重启 Codex 桌面端 | ✅ 唯一有效。它同时持有"活跃会话"的锁，代价是打断正在运行的其它会话（本次操作前已确认另一会话处于 `task_complete` 空闲态，代价最小） |

## 4. 处置步骤（本次实际执行）

```powershell
# 1) 优雅退出：CloseMainWindow 25s 未生效（Electron 未响应）→ 强制结束主进程与其 app-server
(Get-Process -Id 46148).CloseMainWindow()
# 未退出则：
Stop-Process -Id 46148,52484 -Force
# 2) 验证三个锁全部释放（独占打开成功即无持有者）
# 3) 重新拉起桌面端
Start-Process explorer.exe -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App'
```

释放后的端到端确证（用插件**生产方法** `CodexAppServerClient.resumeThread` 复跑）：

```
thread/resume: SUCCESS in 1760ms      ← 之前 100% 报 active writer
thread/read: name="DSH Plan: …智利（CL）出口 worker（充值节点）…" status={"type":"idle"}
```

探针进程退出后锁文件消失（干净释放）。线程数据完好，无需重建。

## 5. 可复用诊断手法

### 5.1 定位"谁持有这个文件锁"（Restart Manager，无需管理员）

```powershell
# rstrtmgr.dll: RmStartSession / RmRegisterResources / RmGetList
# 完整可运行脚本已归档：docs/find-lock-holder.ps1
pwsh -File docs/find-lock-holder.ps1 -Path "$env:USERPROFILE\.codex\thread-writer-locks\<threadId>.lock"
# 同时用独占句柄做真伪校验：能独占打开 = 没有 OS 级持有者
try { $fs=[IO.File]::Open($path,'Open','ReadWrite','None'); $fs.Close(); 'FREE' }
catch { 'HELD: ' + $_.Exception.Message }
```

### 5.2 归因 app-server 行为（只读查日志库）

```js
// node:sqlite 只读打开；logs 表字段含 ts / level / target / feedback_log_body / process_uuid
const db = new DatabaseSync('C:\\Users\\Z1803\\.codex\\logs_2.sqlite', { readOnly: true });
db.prepare(`SELECT ts, level, target, feedback_log_body FROM logs
            WHERE feedback_log_body LIKE '%<threadId>%' ORDER BY id DESC LIMIT 5`).all();
// span 里的 rpc.method / app_server.client_name / thread_id 足以判定
// 「是谁发起的请求、卡在哪一步、之后是否再被提起」
```

### 5.3 三角验证时间线

锁文件创建时间 ↔ MCP 子进程创建时间 ↔ rollout 最后写入时间。三者同秒即基本锁定是哪一次
`thread/resume` 抢走了写入者锁；再用 5.2 的 span 确认发起方是桌面端还是插件。

## 6. 结构性修复（1.1.0）

**不变量：审查永远跑在 workflow 自己的专用 Reviewer 线程上 —— 绝不 resume Planner 线程，
也绝不 resume bridge 的起源任务。** 这样"别的进程占住某条线程"在结构上不再能阻塞审查。

| 位置 | 改动 |
|---|---|
| `src/workflow.ts` `reviewOnceViaCli`（生产路径） | 删除 `reviewerThreadId \|\| plannerThreadId` 回退；未绑定时 `audit.createReview` 新建专用 CLI Reviewer，经 `onThread` 持久化 |
| `src/workflow.ts` App Server 审查路径 | 删除 `mode==="planned" && plannerThreadId ⇒ 别名` 分支，始终 `startReviewerThread` |
| `src/workflow.ts` `runSubmissionCallback` | writer 释放与 `reviewerThreadId` 参数只用**已绑定的专用** Reviewer |
| `src/codex-cli-audit.ts` `send()` | 未绑定时走 `createReview`，不再 `codex exec resume <起源任务>` |
| `src/app-server-callback.ts` | 未绑定时创建专用 Reviewer 并 resume 它；起源任务不再被 read/resume/settings/rename/turn 触碰 |
| 惰性迁移 | 新增 `isSharedReviewerAlias()`：`reviewerThreadId` 等于 `plannerThreadId` 或 `codexThreadId` 即按"未绑定"处理，下一轮换成专用 Reviewer；身份守卫只对该别名放行，"已绑定的专用 Reviewer 被换成另一个 id" 仍 fail-closed |

有意保留：align/reconcile/display-rewrite 的 `reviewerThreadId ?? codexThreadId` 三处回退
（都在审查已绑定专用 Reviewer 之后执行，对新流程等价于"只用专用 Reviewer"；对升级前中途
中断的旧记录保持 1.0.x 行为）；`continue` 使用 Planner 线程（那是 Planner 回合，不是审查）。

验证：`pnpm typecheck` 通过；`pnpm test` **390/390**（原 388 + 2 条新回归：起源任务 busy 不阻塞审查、
旧别名惰性迁移）；`pnpm release:check` = `RELEASE_CHECK_OK`；独立 Codex 审查 `pass`。

### 6.1 事后现实检验（2026-09-24 00:45）

桌面端重启后自行恢复了此前打开的线程，**同一把锁 `01a0ce97…lock` 于 00:45:20 被重新创建**，
`docs/find-lock-holder.ps1` 确认持有者仍是桌面端 app-server（这次是重启后的 PID 31136）。
换言之：这条线程在现实里就是反复被外部进程占用的。

- 1.0.x：工作流 `49eb2c0d` 的审查会**再次**被同一把锁挡住。
- 1.1.0：该记录的 `reviewerThreadId` 仍等于 `plannerThreadId`，因此它的**下一次审查会自动迁移**到
  新建的专用 Reviewer，不再触碰被占住的线程 —— 这正是本次修复要保住的场景。

## 7. 运维须知

1. **升级前的老记录**：其 `reviewerThreadId` 仍可能等于 Planner/起源任务。1.1.0 下**不需要**为此特意
   关掉桌面端的线程 —— 下一次审查会自动迁移到专用 Reviewer（机制见 §6，实测见 §6.1）。真正需要避开的
   只有 Planner 回合（见第 7 条）。
2. **诊断顺序**：先按 §5.1 确证持有者 PID，再按 §5.2 判定发起方与卡点，最后才决定是否重启桌面端。
   PID 归属不要凭启动时间猜。
3. **重启代价**：桌面端同时服务其它会话（本次另一个会话正在跑）。重启前先确认它们处于空闲
   （rollout 最后一条为 `task_complete`），否则会打断在跑的回合。
4. **插件无热重载**：插件在 DSH 宿主进程内 import，改完 `lib/` 必须重启宿主
   （`dsh --profile web --port 3080`）才生效。
5. 本次排查还顺带确认：桌面端重启前遗留的 `codex.exe app-server --listen stdio://`（父进程
   `node_repl.exe`）不持有任何 thread-writer 锁，不必为它单独处置。
6. **桌面端会反复重新持锁**：重启后它会恢复此前打开的线程并重新创建锁文件（实测 00:45 再次占住
   `01a0ce97`）。这是它的正常工作方式，不是故障；不需要（也不应该）为此反复重启桌面端。
7. **1.1.0 的边界**：该版本保证的是**审查**路径不依赖 Planner/起源线程。`codex_workflow_continue`
   等 **Planner 回合**仍需 resume Planner 线程，因此若桌面端正打开那条线程，Planner 继续仍可能撞
   `already has an active writer`（这是既有行为，本次未改动）。遇到时关掉桌面端里那条线程即可。
8. 锁文件残留 ≠ 仍被占用：已被释放的线程可能留下空锁文件（本次释放后 `01a0ce97…lock` 文件消失，
   而重启后其它线程又出现新锁文件）。判断真伪一律用 `docs/find-lock-holder.ps1` 的独占打开探针，
   不要看文件是否存在。
