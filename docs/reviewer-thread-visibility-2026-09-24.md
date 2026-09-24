# Reviewer 线程在 Codex 桌面端「不渲染」的取证与 1.1.2 修复（2026-09-24）

本记录固化一次可复现的界面级缺陷的实测证据、被证伪的假设，以及 1.1.2 的结构性修复，
避免下次再靠猜。

- 现象：Codex 桌面端侧栏出现一行「无标题 / 不渲染」的线程（截图中的 `01a0cf65…`）
- 受影响工作流：`e3912554-5919-439b-b071-3123bdbd96a5`（`mode: review_only`，`origin: dsh`，
  cwd `…\projict\代充协议`）
- 涉及线程：`01a0cf65-3580-73a1-8565-f89d451b0527`（插件 Reviewer）
- 修复版本：**dsh-codex-workflow 1.1.2**（可见审查回合回到 App Server；CLI 只做内部转换）

---

## 1. 侧栏数据源：`thread/list` 只返回 `source='vscode'`

桌面端侧栏不是直接读 `~/.codex/state_5.sqlite`，而是走 App Server 的 `thread/list`。
把该接口的**全量返回**（分页拉完，63 条）与 `threads` 表（464 行）做交叉统计：

| `source` 取值 | 表内行数 | `thread/list` 列出 |
|---|---|---|
| `vscode` | 162 | **63** |
| `exec` | 15 | **0** |
| `{"subagent":"review"}` | 73 | 0 |
| `{"subagent":{"other":"guardian"}}` | 7 | 0 |
| `{"subagent":{"thread_spawn":…}}` | 190 | 0 |

`vscode` 的 162 行里有 99 行没被列出，**这 99 行全部 `archived=1`**（逐行核对）。
也就是说过滤条件只有两条：`source='vscode'` **且** 未归档；**名字为空不是过滤条件**
（被列出的集合里存在 `name=''` 且 `preview` 为空的线程）。

结论：`codex exec` 创建的线程**永远**不会出现在侧栏，这就是「不渲染」的真因，
同时也是「无标题」的来源（15 条 `exec` 线程里 14 条 `name=NULL`）。

一次针对性的复验（同一个 App Server 进程、同一次 `thread/list`）：

```
[plugin app-server planner] 01a0d2ce-a3b9-79e0-b94a-b6caa3b031ac
  listed in thread/list: YES
  name="DSH Plan: 项目：C:\\Users\\Z1803\\Downloads\\projict\\dsh-cc\\dsh-codex-workflo…"
[codex exec reviewer] 01a0cf65-3580-73a1-8565-f89d451b0527
  listed in thread/list: NO
[thread/read on the exec reviewer] error=none name=null
```

即：**插件自己的 App Server 线程（Planner）可见，CLI 创建的 Reviewer 不可见**，
而两者是同一个插件、同一台机器、同一次会话。

## 2. 被证伪的三条“显然的修法”

| 假设 | 实测结果 |
|---|---|
| 「名字为空所以不渲染」 | **否**。列表里存在空名字的行；给 `exec` 线程设名字后依旧不进列表 |
| 「`thread/name/set` 修不好？」 | 能改库（无需 resume 即成功），但 **`source` 不变 → 依然不被列出**，只能改善旧线程的可读性 |
| 「`codex exec --thread-source vscode` 就能造可见线程」 | **否**。只写 `thread_source='vscode'`，`source` 仍是 `exec` → 依然不被列出。**CLI 无法创建可渲染线程** |

## 3. 为什么当初会用 CLI 创建（1.0.14 的约束）

`src/app-server.ts` 的 `thread/start` 创建的线程**没有 rollout 文件**（rollout 只在跑过回合后出现），
此时 `codex exec … resume <id>` 报 `-32600 no rollout found for thread id`。
1.0.14 因此把「首个可见审查回合」交给 CLI——于是 Reviewer 变成了 `exec` 线程。

1.1.2 的做法是把**创建与首个可见回合都放回 App Server**（`thread/start` → `settings/update`
→ `name/set` → `review/start`）：回合一旦跑过，rollout 就存在，后续轮次照常恢复同一个线程，
而 `source='vscode'` 从创建那一刻就固定下来。

## 4. 1.1.2 修复要点

- `src/workflow.ts`：`reviewOnce` 删除 `audit` 分支（原 `reviewOnceViaCli`，已移除 —— 它是最后一个
  创建持久 CLI Reviewer 的路径）。可见回合统一 `startReviewerThread` + `review/start`；
  `normalize` 仍走 CLI（`--ephemeral`，不产生持久线程）。
- `src/app-server-callback.ts`：新增 1.1.1 等价语义 —— 可见回合内的**瞬时**上游失败返回
  `retryable_busy`（沿用 `transientReason`），不再作为终态 `CodexCallbackProcessError`。
- `src/index.ts`：回调重新接回 `AppServerCodexCallbackDispatcher`（CLI 仍作为 audit 网关注入）。
- `src/types.ts` + 惰性迁移：新增内部字段 `reviewerThreadOrigin: "app-server"`（不进入 `show --json`）。
  缺标记或仍与 Planner/起源任务同号的旧记录，下次审查时**新建**可见 Reviewer、原子替换 id；
  旧 `exec` 线程保留不删，仅 best-effort 改名为
  `DSH Reviewer (legacy, not renderable in Desktop): <workflowId>`。
- `src/app-server.ts`：新增 `nameThread`（`thread/name/set`，**不 resume**，因此不会去抢写者锁）。

## 5. 复验方式（离线）

```
pnpm typecheck && pnpm test          # 416 tests
pnpm release:check                   # RELEASE_CHECK_OK
```

新增断言：Reviewer 创建 RPC 顺序与名字、改名不触发 `thread/resume`、
`thread/name/set` 失败仍释放已创建线程、空 App Server 任务在首回合前不可 resume（rollout 约束）
且首回合跑在创建出的同一线程、带 CLI audit 的审查不产生持久 CLI 任务
（但 `normalize` 仍走 CLI）、旧 CLI Reviewer 的迁移（旧线程改名 + 新线程绑定 + origin 落库）、
共享别名迁移**不**改名、未绑定新建 Reviewer 在取消/写入失败时释放、
可见审查回合的瞬时重试（终态不重试）、回调路径瞬时失败的 retryable 语义。

在线侧证据（本次修复所依据的 `thread/list` 交叉统计与线程比对）由 `%TEMP%` 下的一次性探针脚本
产出：`list-dump-probe.mjs`（导出 `thread/list` 全量）与 `reviews-visibility-probe.mjs`
（比对指定线程是否被列出）。探针只读，不写 `~/.codex`。

## 6. 1.1.2 上线后的正向运行时证据（宿主重启后实测）

| 线程 | 创建方 | `source` | `originator` | `name` | 出现在 `thread/list` |
|---|---|---|---|---|---|
| `01a0cf65-3580-73a1-8565-f89d451b0527` | 1.1.1 `codex exec` | `exec` | `codex_exec` | `NULL` | **否**（修复前对照） |
| `01a0d2c8-967e-7603-aee9-776d8de1cb45` | 探针 `codex exec` + 改名 | `exec` | `codex_exec` | `DSH Reviewer: resume-then-name-probe` | **否**（改名救不活旧线程） |
| `01a0d324-49ad-7bf0-a567-232e9a42de4b` | 1.1.2 `review_only` | `vscode` | `dsh-codex-workflow` | `DSH Reviewer: 165b5412-c10b-437a-aa22-f8f04af725ce` | **是** |
| `01a0d377-d8c0-7653-afa8-c5f17eaef312` | 1.1.2 冒烟 `review_only` | `vscode` | `dsh-codex-workflow` | `DSH Reviewer: b5d6ea87-eb6b-4c8c-b714-556975525fd3` | **是** |

`thread/list` 实时快照（同一次调用，只列 `DSH` 前缀）：

```
01a0d377-d8c0 "DSH Reviewer: b5d6ea87-eb6b-4c8c-b714-556975525fd3"
01a0d324-49ad "DSH Reviewer: 165b5412-c10b-437a-aa22-f8f04af725ce"
01a0d2ce-a3b9 "DSH Plan: 项目：…"
01a0d2b0-ec84 "DSH Plan: ## 任务 …"
```

桌面深链：`codex://threads/<threadId>`（`src/desktop-thread-opener.ts` 的 `codexThreadUri`）。

**已知副作用（可见性的代价）**：线程一旦可渲染，用户在桌面端打开它就会让 Desktop 持有该线程的
写者锁（1.1.0 记录的那套 `thread-writer-locks/<id>.lock`）。后续审查轮次对同一 Reviewer 线程的
`thread/resume` 因此可能报 `already has an active writer`；插件把它按瞬时故障重试（有界退避），
但用户长期开着该线程会让每一轮都先冲突一次。旧布局（`exec` 线程）不存在这个问题，因为它根本不可见。
