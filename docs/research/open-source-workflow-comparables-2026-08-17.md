# dsh-codex-workflow 同类开源项目调研报告

> 调研主题：截至 **2026-08-17**，社区中是否存在与 `dsh-codex-workflow` 相似的开源项目——「一个宿主 Agent/IDE/CLI 把规划或审查交给 Codex（或另一个独立 Agent），宿主负责执行，并维持会话绑定、工作区绑定、状态持久化、恢复、取消、独立审查与自动修复闭环」的协作项目。
>
> 基线：`dsh-codex-workflow`（本仓库）；已知基线名 `dsh-codex-collab`（见 §1.4 说明）。
> 核验日期：本报告所有「核验日期」统一按 **2026-08-17**；GitHub 数据字段（`pushed_at`、release 日期等）保留其原始 UTC 时间戳。
> 调研方式：实时 web 检索 → GitHub REST API（`/repos`，核验许可证/语言/星数/最近提交/归档状态/默认分支）→ `raw.githubusercontent.com` 拉取 README/SKILL 原文细读 → `releases.atom` 取最新 release 日期。共核验 **32+ 个仓库**，其中通过 GitHub API 成功核验 32 个。

---

## 0. 摘要（TL;DR）

1. **直接同类项目确实存在且生态活跃**。截至核验日，至少可以列出 **13 个真实可运行的「宿主委托 Codex/独立 Agent 规划或审查」开源项目**（§3），远远超过「至少 8 个」的验收下限。绝大多数集中在 Claude Code 生态（skill / plugin / MCP server 形态，宿主=Claude Code，被委托方=Codex CLI），少数在 DSH 生态（宿主=DSH，被委托方=其他 Harness Agent）。
2. **没有找到与 `dsh-codex-workflow` 完全同构的第二个实现**（DSH 宿主内 Cordis 插件 + `codex app-server --stdio` JSON-RPC + 会话绑定 + 工作区绑定 + JSON 持久化 + thread/resume 恢复 + 独立 Reviewer 自动修复闭环）。机制上最接近的是 [`Kevin7Qi/codex-collab`](https://github.com/Kevin7Qi/codex-collab)（同样走 Codex app-server JSON-RPC over stdio，具备线程管理/审批策略/恢复/审查），但它没有 Planner/Executor/Reviewer 的强制角色分离，也没有「宿主会话＝唯一执行器」的约束。
3. **我们独有、别人通常缺少的能力**（详细见 §6.1）：
   - 宿主会话即唯一可写执行器，Codex 双角色被硬性锁定为只读（`sandbox: read-only` + `approvalPolicy: never` + 网络关闭）；
   - workflow 与 DSH 会话强绑定（`dshSessionId` 所有权校验、单会话单活工作流），跨会话状态机隔离；
   - `cwd` + `runtimeWorkspaceRoots` + `serviceName` + `sessionStartSource: startup` + `thread/name/set` 组合，把 Codex Desktop 线程归组到用户项目（多数方案完全不处理此类可见性细节）；
   - Planner/Reviewer 双 JSON-Schema 强约束结构化输出；JSON 记录原子写 + `thread/resume` 线程级恢复 + 对「跨进程重启后 pendingInput 语义」的显式设计（README 明示）。
4. **别人有、建议我们加入的能力**（展开见 §6.2 / §6.4）：审查结果携带 diff 证据、非阻塞改进的「用户裁决门」（MEDIUM/LOW 分流）、审查停滞/徒劳检测、token/成本观测与预算、review-only 纯审查模式、git worktree 并行多任务、TDD 门与 E2E 证据门、审查角色定制模板、bounded auto-resume、事件溯源状态存储等。
5. **不建议照搬的设计**（§6.3）：ralphex 的「每任务全新会话」（牺牲会话连续性）、optim-plans v0.3「砍掉执行引擎」的产品取舍、codex-gemini 的「文件系统即状态」（无锁竞争）、codex-forge 的「巨型工作流模板提交进仓库」（跨版本 merge 冲突已被其 changelog 反复自证）、同一模型互审（ralphex 明确论证 codex-review-codex 弱信号）、依赖 Claude `-p` 计费池 / Plandex 云托管等外部绑定。
6. **维护状态警示**：Roo Code 已于 2026-05-15 前后归档停运（社区 fork Zoo-Code 接续）；smol-ai/developer 自 2024-04 停更；Sweep 已转型 JetBrains 插件；plandex 云服务 2025-10-03 停止接受新用户、最后一次 release 在 2025-07；microsoft/autogen 明显放缓（AG2 分叉）。选择借鉴对象时要注意这些信号。

---

## 1. 调研方法与口径

### 1.1 数据来源与核验手段

| 手段 | 用途 | 备注 |
|---|---|---|
| `api.github.com/repos/<owner>/<repo>` | 许可证、主语言、stars、forks、`pushed_at`（最近提交）、`archived`、默认分支、描述 | 未认证限额 60 次/小时，调研中触顶（403），部分仓库改用其他源 |
| `raw.githubusercontent.com` 抓取 README / SKILL.md | 逐条细读功能、流程、命令 | 不受 API 限额影响 |
| `github.com/<owner>/<repo>/releases.atom` | 最新 release 日期 | 标签文本解析失败时只取日期 |
| web 检索（搜索引擎） | 发现候选、修正仓库路径 | 交叉引用于 GitHub 页面 |

### 1.2 日期口径

- 报告内所有「核验日期」统一写作 **2026-08-17**（任务约定口径）。
- GitHub API 返回的时间戳（如 `pushed_at`）为原始 UTC 值，直接引用，不换算。

### 1.3 事实/推断标注规则

- **[事实]**：本会话在 2026-08-17 于 GitHub API / raw README / Atom 源直接核验的内容。
- **[推断]**：基于所读材料由本报告作者作出的分析、归纳或建议。
- **[未核验]**：未能定位仓库、API 限流未取到数据、或仅有二手转述的内容——一律不进入功能矩阵的「事实」单元格。

### 1.4 关于基线 `dsh-codex-collab` 的说明

- 用户给定「已知基线包括 dsh-codex-collab」。本会话通过 GitHub 搜索与 npm registry 检索（`dsh-codex-collab` 包 404，npm search 无命中）**未定位到同名公开仓库**，疑似内部/私有迭代版本。[未核验]
- 同名公开物 `codex-collab` 均属 Claude Code 技能生态：`Kevin7Qi/codex-collab`（★95，活跃）、`varunr89/codex-collab-plugins`（Claude Code 插件）、`Simpliq.codex-collab`（VS Code 扩展）。本报告以 `Kevin7Qi/codex-collab` 为直接同类收录（§3.1），它也是与本插件机制最接近的公开实现。

### 1.5 局限性声明

- GitHub 未认证 API 限流导致个别字段（如 goose 迁移后仓库、dsh-bridges、yicheng47/runner 的 stars/license）未能经 API 复核；已尽量用 README/Atom 补足并明确标注。
- 项目数量截至 2026-08-17 的检索快照，不保证无遗漏；小众项目（★<50）可能活跃但分发面窄。
- 「维护状态」判断基于 `pushed_at` / release 间隔 / README 声明三者的组合，属 [推断]，但给出原始数据供复核。

---

## 2. 分类总览

### 2.1 直接同类（宿主把规划/审查交给 Codex 或另一独立 Agent，宿主执行）

| # | 项目 | 宿主 | 被委托方 | 形态 |
|---|---|---|---|---|
| D1 | [Kevin7Qi/codex-collab](https://github.com/Kevin7Qi/codex-collab) | Claude Code | Codex（app-server JSON-RPC） | Skill + CLI (Bun/TS) |
| D2 | [ching-kuo/claude-codex](https://github.com/ching-kuo/claude-codex) | Claude Code | Codex（MCP） | 技能包（5 skills） |
| D3 | [anhnguyen0905/codex-mcp](https://github.com/anhnguyen0905/codex-mcp) | Claude Code | Codex（CLI 子进程） | 插件 + MCP server |
| D4 | [atompilot/claude-code-cross-review](https://github.com/atompilot/claude-code-cross-review) | Claude Code | Codex（MCP，CLI 回退） | Skill + 安装脚本 |
| D5 | [Z-M-Huang/claude-codex-gemini](https://github.com/Z-M-Huang/claude-codex-gemini) | Gemini CLI | Claude（执行）+ Codex（终审） | TypeScript 管线 |
| D6 | [waltstephen/ArgusBot](https://github.com/waltstephen/ArgusBot) | 独立 daemon | Codex CLI / Claude Code CLI | Python 监督循环 |
| D7 | [pablomarin/claude-codex-forge](https://github.com/pablomarin/claude-codex-forge) | Claude Code | Codex（review/council） | 工程 harness（shell+md） |
| D8 | [umputun/ralphex](https://github.com/umputun/ralphex) | 独立 CLI | Claude Code / Codex（可切换） | Go 单二进制 |
| D9 | [Averyy/codex-dobby-mcp](https://github.com/Averyy/codex-dobby-mcp) | Claude Code（任意 MCP 客户端） | Codex（CLI 子进程） | MCP server |
| D10 | [ZSeven-W/dsh-crew](https://github.com/ZSeven-W/dsh-crew) | Claude Code / Codex | DSH 宿主 agent（方向相反） | DSH 插件 + MCP |
| D11 | [yhlooo/dsh-bridges](https://github.com/yhlooo/dsh-bridges) | DSH | 桥接 Claude Code/Codex/OpenCode 等既有资产 | DSH 插件 |
| D12 | [Optim-Agent/optim-plans](https://github.com/Optim-Agent/optim-plans) | Claude Code / Codex 双平台 | 规划阶段委托 Codex 细化 | 技能 + Python 控制器 |
| D13 | [evgenygurin/codex-bridge](https://github.com/evgenygurin/codex-bridge) | Claude Code | Codex CLI（研究/文档） | 命令 |
| D14 | [goharanwar/claude-codex-review](https://github.com/goharanwar/claude-codex-review) | Claude Code | Codex（审查） | MCP server |

> 其中 D1/D2/D3/D4/D5/D6/D7/D9/D12 是「把规划或审查交给 Codex（或独立模型审查者）」的**完整闭环**实现；D8 是「宿主 CLI 执行计划 + 多级独立审查」的完整闭环；D10/D11 是 DSH 生态内的方向相反/资产桥接项目，机制上高度相关；D13/D14 为轻量示例。

### 2.2 相邻可借鉴（Planner/Executor 分离、审查闭环、状态持久化、并行等单项突出）

| # | 项目 | 借鉴点 |
|---|---|---|
| A1 | [plandex-ai/plandex](https://github.com/plandex-ai/plandex) | 累进 diff 审查沙箱、plan 版本控制/分支 |
| A2 | [sst/opencode](https://github.com/sst/opencode) | 内置对偶 agent：build（全权）/ plan（只读默认拒绝） |
| A3 | [charmbracelet/crush](https://github.com/charmbracelet/crush) | 多会话/多上下文 per project、skills 标准兼容 |
| A4 | [block/goose（现 aaif-goose/goose）](https://github.com/aaif-goose/goose) | 桌面+CLI+API 三形态、MCP 扩展生态 |
| A5 | [cline/cline](https://github.com/cline/cline) | Kanban 并行任务板（每卡独立 worktree + 自动提交 + 依赖链）、SDK |
| A6 | [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | Architect/Code/Ask/Debug/Custom 显式模式分离（已停运，警示） |
| A7 | [All-Hands-AI/OpenHands](https://github.com/All-Hands-AI/OpenHands) | 运行后端可插拔（本地/Docker/VM）、Planner agent、Docker 沙箱 |
| A8 | [geekan/MetaGPT](https://github.com/geekan/MetaGPT) | SOP × 角色 → 结构化工件（PM/架构/工程/QA） |
| A9 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | PlanningFlow、hierarchical process（manager/审查） |
| A10 | [microsoft/autogen](https://github.com/microsoft/autogen) | GroupChat 的 planner/executor/critic 轮转与 max_turns 终止 |
| A11 | [Aider-AI/aider](https://github.com/Aider-AI/aider) | repo map 上下文压缩、git 原生集成（自动提交/undo） |
| A12 | [Codium-ai/pr-agent](https://github.com/Codium-ai/pr-agent) | PR 审查命令族（describe/review/improve）与 CI 集成 |
| A13 | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 测试执行反馈闭环（agent-computer interface） |
| A14 | [yicheng47/runner](https://github.com/yicheng47/runner) | crew 编排（角色/单 lead）、事件日志即事实源、ask_human、自身即 MCP server |
| A15 | [sweepai/sweep](https://github.com/sweepai/sweep) | 反面教材：产品方向漂移（issue→PR 管线 → JetBrains 插件） |
| A16 | [smol-ai/developer](https://github.com/smol-ai/developer) | 反面教材：planner/executor 双 agent 但已停更 2 年+ |

### 2.3 未能核验 / 疑似下架的参考对象 [未核验]

- **Cognition「Runner」**：2025 年有公开报道的开源 CI 内 dev agent（check/apply 双模式）。本会话 2026-08-17 检索 GitHub，`runner-ai/runner`、`CognitionAI/runner`、`CognitionIA/runner` 均 404，未能在 GitHub 定位其当前仓库，**不收录进矩阵**，仅此备注。
- **Sourcegraph「Amp」**：`sourcegraph/amp`、`ampcode/amp` 均 404，疑似更名或下架；仍有第三方示例库（`ampcode/amp-examples-and-guides`）在维护。不收录矩阵。
- **coderabbitai/ai-pr-reviewer（GitHub Action）**：`coderabbitai/ai-pr-reviewer`、`coderabbitai/openai-pr-reviewer` 均 404，未能定位当前仓库；CodeRabbit 当前以 SaaS 为主。不收录矩阵。

---

## 3. 直接同类项目档案

> 每项格式：核心定位 / 功能细节（含可借鉴点）/ 维护与元数据。**加粗**为建议纳入对照的关键特性。

### D1. Kevin7Qi/codex-collab —「Claude 里协作 Codex」技能 + CLI

- 元数据：MIT；TypeScript/Bun；★95；最近提交 2026-08-15；最新 release 2026-08-05；活跃。[事实]
- 核心定位：Claude Code skill，用 **Codex app-server JSON-RPC over stdio** 直接驱动 Codex（与本插件同一协议层），管理线程、流式结构化事件、工具审批、断点续聊；提供 `run / review / threads / follow / output / kill / ask / answer / approve / decline / next` 等命令。[事实]
- 可借鉴点：
  1. **双向问询通道 fail-open**：Codex 中途 `ask` 提问、宿主 `answer` 回答、`next` 阻塞等待需要关注的信号；**超时后让 Codex 凭自身判断继续而非卡死**（`--timeout` 默认 600s）——我们目前遇到 planner `needs_input` 是进入 waiting_input 状态等宿主回答，无自动超时兜底。[事实]
  2. **`run --detach` + `follow --watch`**：长任务分离到后台 runner，宿主终端里实时跟读——对应我们的 turn 长任务可观测性。[事实]
  3. **审批策略四档**：auto-approve / interactive / deny / Codex Guardian（`--approval auto`）——我们固定 never。[事实]
  4. **内存隔离**：默认把本工具创建的线程从 Codex 记忆功能中排除，避免 agent 驱动的会话污染用户画像。[事实]
  5. **`review` 支持 PR / 未提交改动 / 指定 commit 三种目标，只读沙箱**。[事实]

### D2. ching-kuo/claude-codex — 五技能「规划→实现→审查」流程包

- 元数据：MIT；★23；最近提交 2026-04-01（约 4 个月未动，维护放缓）；语言字段为空（技能/markdown 为主）。[事实]
- 核心定位：Claude Code 技能包，5 个技能驱动闭环：[事实]
  - `plan-codex`：Claude Opus 用内置 Plan agent 产出结构化计划 → **Codex 审计计划**（正确性/完整性/安全）直到通过（≤3 轮），计划落盘 `.claude/plan/<feature>.md`；
  - `claude-codex`：Claude 实现 → **Codex 审未提交 diff（MCP），返回结构化 verdict APPROVED / WARNING / BLOCKED** → Claude 修 CRITICAL/HIGH（≤3 轮）→ **MEDIUM/LOW 交给用户裁决后再交付**；
  - `execute-codex`：**按变更规模智能路由**（≤2 文件 ≤30 行走 Claude，大改动走 Codex），feature-dev 的 `code-reviewer` agent 审 diff（≤3 轮）；
  - `tdd-claude-codex` / `tdd-execute-codex`：TDD 变体——Claude 先写测试、**Codex 审计测试**、Claude 实现、Codex 审实现。
- 可借鉴点：
  1. **verdict 三分级 + 处置分流**：阻塞项（CRITICAL/HIGH）自动进入修复循环，非阻塞项（MEDIUM/LOW）显式停在用户面前——我们目前是 pass/changes_requested 二分，非阻塞但没有裁决门。
  2. **按规模路由执行者**（小改不走 Codex，省钱省时）。
  3. **TDD 门**：先审测试再放行实现。
  4. **计划文件化复用**（`.claude/plan/`，可 gitignore）。

### D3. anhnguyen0905/codex-mcp —「Claude 规划+审查 / Codex 执行」六阶段流程

- 元数据：MIT；TypeScript；★3（小众但功能密度最高）；最近提交 2026-08-14；活跃。[事实]
- 核心定位：Claude Code 插件 + MCP server，`/codex-flow` 六阶段（Preflight → Interview → Plan → Backlog → Execute → Review）：Claude 访谈/规划/审查，Codex 经 `codex exec --json` 执行（解析 JSONL 事件流，返回 sessionId/agentMessage/fileChanges/commands/token usage/diff）；**每任务双审查**（Claude + 强制 `codex_review`），对比两方 finding 后回推修复，非阻塞改进待用户决策。[事实]
- 可借鉴点：
  1. **`.codex-flow/STATE.md` 是恢复权威**（10-key run state：相位、三个审批、runBaselineRef、脏基线、checkpoint 选择、resumeHead），**而不是靠文件存在性**——与 codex-gemini 的 FS-as-state 形成对照。[事实]
  2. **bounded auto-resume**：瞬间失败自动续跑（≤2 次，2s/8s 退避）、超时（≤1 次）、解析失败（≤1 次，no-completion-marker），可用 env 关闭。[事实]
  3. **diff 回传**：每次运行返回 `git status --porcelain` + `git diff HEAD`（64KB 上限、truncated 标记、非 git 仓库为 null），宿主不重读文件即可审。[事实]
  4. **并行 wave**：按依赖与文件不相交性把 TASKS 分波，每波在独立 git worktree 由 Claude subagent 驱动 Codex，最多 10 并发，逐波集成审查。[事实]
  5. **成本/进度观测**：`codex_metrics` 聚合 token/时长/失败率；`liveLog` + `notifications/progress` 实时进度；取消转发（SIGTERM→SIGKILL 5s）。[事实]
  6. **上下文切片**：按预算生成 per-task CONTEXT 文件（≤4000 token）与 RESUME 切片（≤8000 token），git-SHA Anchor + `[fresh]/[verify]` 标记；`REQUIREMENTS.md` 原子 R<n>.<m> 需求 ID + ADDED/MODIFIED/REMOVED Delta。[事实]
  7. **sandbox 三档**（read-only / workspace-write / danger-full-access）暴露给调用方；timeout 60min（cap 2h）。[事实]

### D4. atompilot/claude-code-cross-review —「写的不审，审的不写」

- 元数据：无许可证声明（license none）；Shell（安装脚本+skill）；★0；最近提交 2026-03-07；维护停滞。[事实]
- 核心定位：极简多模型审查流——Claude(Opus) 写代码 → **Codex(GPT) 审未提交改动** → Claude 逐项修复 → 循环至干净 → lint/build/test → git commit。[事实]
- 可借鉴点：**写入者≠审查者的角色隔离原则 + 循环收敛后自动提交**；集成方式 **MCP 优先、Codex CLI 自动回退** 的降级设计。[事实]

### D5. Z-M-Huang/claude-codex-gemini —「Gemini 编排 / Claude 执行 / Codex 终审」

- 元数据：GPL-3.0；TypeScript(Bun)；★18；最近提交 2026-02-06；维护放缓。[事实]
- 核心定位：三模型流水线，6 种 agent（requirements-gatherer / planner / plan-reviewer / implementer / code-reviewer / codex-reviewer）；**顺序审查链**：Plan Review: Sonnet→Opus→Codex，Code Review: Sonnet→Opus→Codex；每级 approved 才放行；review 状态含 approved / needs_changes / **needs_clarification**（暂停问用户）/ rejected（仅 Codex 终审可用，计划级终止）；**每 reviewer 最多 10 轮**，超限升级人工。[事实]
- 可借鉴点：
  1. **多级顺序审查门**（多模型逐级把关，越往后越权威）。
  2. **needs_clarification 暂停语义**（对应我们 planner 的 needs_input，但它延伸到 code review 阶段）。
  3. **Codex 会话按审查类型隔离复用**（`.codex-session-plan` / `.codex-session-code`，首次新会话、后续自动 resume、过期自动重开）。
- 不建议照搬：**文件系统即状态**（`.task/*.json` 存在性判相位，无锁、易竞争）；10 轮容忍度过宽。[推断]

### D6. waltstephen/ArgusBot — 24/7 监督循环（main/reviewer/planner 三角色）

- 元数据：MIT；Python；★314；最近提交 2026-04-26；活跃（中等）。[事实]
- 核心定位：对 Codex CLI 与 Claude Code CLI 的常驻监督层（wrapper）：**主 agent 循环 + reviewer 门控（结构化 JSON 输出 done/continue/blocked）+ planner 快照/TODO 板**；`/run /inject /btw /plan /review /status /stop` 渠道命令（Telegram / 飞书）；daemon 模式空闲启动、续跑上次 `session_id`；git checkpoint 后再自动跟进；**stall watchdog**（1h 无输出→软诊断，3h→强制重启）；operator 消息历史写入共享 markdown 喂给 reviewer；运行归档 JSONL；终稿 md/pptx 报告；`copilot-proxy` 路由省额度。[事实]
- 可借鉴点：
  1. **reviewer 结构化门控三元组 done/continue/blocked** 与「所有验收检查通过才停」。
  2. **停滞看门狗 + 硬重启安全窗**（我们目前只有 turn 超时，没有「长时间无进展」检测）。
  3. **续跑前自动 git checkpoint**。
  4. **外部渠道注入控制**（与 DSH 会话外的操作者通道结合）。
  5. **进程通信/状态文件（`.argusbot/bus`）** 的进程外观测。

### D7. pablomarin/claude-codex-forge — 双 Agent 工程化 harness

- 元数据：MIT；Shell（模板+hook 为主，README 100KB+，演进记录极详尽）；★5；最近提交 2026-07-28；活跃。[事实]
- 核心定位：Claude（设计/实现）+ Codex（独立复审）的「工程 harness」：7 命令 14 阶段（PRD→Research→Design→Review→Build→Verify→Ship）；`/codex review` 独立二审 + **`/council` 5 顾问工程委员会（Codex 主席，冲突时裁决）**；`/goal` 自主模式（PRD 门控，PR 创建永远等人工）；**Investigate 模式**给 Codex 沙箱内的实时系统只读调查权（DB/云 API/复现 bug）；hooks 拦危险 Bash、状态更新门、commit/push/PR 质量标记门；**PreCompact hook 抢救压缩前记忆**；git worktree 隔离多开发者并行；每开发者 `.claude/local/state.md`（Done/Now/Next，gitignore）；`.forge-version` 团队版本漂移提示；审查校准（CALIBRATION 块：可及性、最小正确修复、过度工程按成本标记、findings 分级降级规则）；**计划审查 NECESSITY 轴**（可论证「更少」：任何延迟交付的 gate 必须回答它防止了哪个可触达故障）；**收敛断路器**（双引擎认证后 >3 轮额外审查 hook 阻塞一切 ship 动作直至人工裁决）。[事实]
- 可借鉴点：
  1. **认证后收敛断路器**——我们 maxReviewCycles 的语义补充：通过后若因合并/HEAD 变动重新触发审查，应有轮数上限+人工裁决。
  2. **审查校准（reachability + 最小正确修复 + 过度工程成本化）**——直接提升 reviewer 输出质量，比多强化 prompt 更系统。
  3. **证据门**：E2E 报告 artifact 绑定 checkbox 声明。
  4. **state.md 跨 worktree 守卫折叠**（seed-snapshot + 仅当 main 未变才回写）。
- 不建议照搬：**把巨型 `.claude/` 工作流模板提交进仓库**（其 changelog 反复记载跨版本 merge 冲突与 `--upgrade` 覆写事故）；14 阶段流程对插件用户过重。[推断]

### D8. umputun/ralphex — 自主执行 markdown 计划的 CLI（多级审查闭环）

- 元数据：MIT；Go；★1435；最近提交 2026-08-17；最新 release 2026-07-21；**非常活跃**。[事实]
- 核心定位：独立 CLI（git 仓库根目录运行），把 `docs/plans/<feature>.md`（`### Task N:` + `- [ ]` 复选框）的计划**自主执行**：每次任务在**全新会话**里跑（上下文隔离，避免长会话质量劣化）；自动建分支、每任务自动提交；四阶段审查：[事实]
  - Phase 2：**5 个并行审查 agent**（quality/implementation/testing/simplification/documentation，经 Claude Code Task 工具；支持 `{{agent:name}}` 模板自定义与 YAML frontmatter）；
  - Phase 3：**外部 codex 审查循环**（`--max-external-iterations`、**`--review-patience` 停滞检测**——连续 N 轮无提交/无工作树变化即终止、Ctrl+\ 手动打断）；
  - Phase 4：2 个 agent 终审（critical/major only）；
  - 可选 finalize：rebase/squash/push/通知脚本。
  - `--codex` 执行器模式：plan/task/review/finalize 全走 codex CLI；**明确跳过外部 codex 审查——codex 审 codex 是同模型自审，信号弱**（其原话理由，[事实]）；`--worktree` 用 git worktree 并行多个计划；`--review` 纯审查模式（针对分支已有改动，无需 plan）；`--serve` 网页进度；`session-timeout`/`idle-timeout` 杀掉挂起会话；limit/error/retry 三套文本模式分类处理限流与瞬时错误；Docker 模式（凭据 bind-mount 回宿主、TZ、CLI 自动更新）。[事实]
- 可借鉴点：
  1. **审查管线三段式 + 停滞检测**（并行初审→外部独立审→终审；`review-patience` 防烧钱死循环）。
  2. **`--review` 纯审查模式**：对已有改动单独跑审查管线——对应我们可以提供的「review-only 入口」。
  3. **限流/错误/瞬时重试模式分类**（claude_limit_patterns 等待重试 vs claude_error_patterns 判失败 vs claude_retry_patterns 瞬时重试）。
  4. **plan 文件即工件**（完成归档到 `completed/`）。
- 不建议照搬：
  1. **每任务全新会话**：我们以「宿主会话=执行器」为设计核心，会话连续性/审批上下文是价值所在；ralphex 为此牺牲会话连续性换取模型清醒，方向不同（可借鉴其「fresh context chunks」思路而非会话重置）。[推断]
  2. 依赖 `claude -p`（`--print`）的非交互执行：其 README 明示已被 Anthropic 划入 Agent SDK 独立计费池，CI/无人值守成本与策略风险大。[事实]

### D9. Averyy/codex-dobby-mcp — 委托服务器（多审查者扇出 + 后台任务原语）

- 元数据：MIT；Python；★0；最近提交 2026-07-10；活跃（个人项目）。[事实]
- 核心定位：本地 stdio MCP server：宿主（如 Claude Code）经 MCP 把 plan / research / brainstorm / build / validate / review / reverse_engineer 委托给 `codex exec`；`review` 支持**按领域扇出多个 Codex 子代理**（generalist / security / performance / architecture / correctness / ux / regression 可多选）；**后台运行原语**：`start_run`（立即返回 task_id）→ `get_run` / `wait_run`（可批量，first-to-finish 语义）/ `list_runs`（超时后可恢复 task id）；所有工具**强制显式绝对 `repo_root`**（防打到无关目录）；每次运行留 inspectable logs/outputs。[事实]
- 可借鉴点：
  1. **后台任务原语面**（start/get/wait/list + 超时后按 task_id 恢复）——对应长 Codex turn 的宿主侧异步化。
  2. **多审查者扇出**：按领域并行多个 reviewer 再汇总。
  3. **强制显式 workspace 参数**：我们目前从 session header 继承 cwd，可考虑在工具参数层断言 cwd 合法性。

### D10. ZSeven-W/dsh-crew — DSH 生态：Claude Code/Codex → DSH 宿主 worker（方向相反）

- 元数据：MIT；JavaScript；★43；最近提交 2026-08-17（当日仍有提交）；活跃。[事实]
- 核心定位（DSH 生态内与本插件互补）：Claude Code / Codex 作编排者，经 MCP 工具面（`dsh_run_worker` / `dsh_spawn_worker` / `dsh_worker_status` / `dsh_worker_result` / `dsh_worker_cancel`）把任务派给 DSH 宿主内的一等 session（hub 模式：Web UI 可见、按 cwd 归组、按 tier 挂 preset：flash/pro、effort off/high/max）；**escalate_on_failure**（flash 失败自动升级 pro 重试一次）；standalone 兜底（dsh-jsonrpc-agent 独立运行时）；长任务 `dsh_spawn_worker` + `dsh_worker_result(wait_seconds)` 轮询/等待双模式；进度镜像到 status 文件供 HUD/外部监控；多模态桥（describe_image / generate_image 借 Claude/Codex/Grok CLI）。[事实]
- 可借鉴点（我们若未来让其他宿主消费 DSH workflow，可复用它验证过的工具面与 hub/standalone 双路径）。

### D11. yhlooo/dsh-bridges — 把既有 Agent 工程资产桥进 DSH

- 元数据：（GitHub API 限流未核验 stars/license；README 已核验）DSH 插件。[事实(README)]/ [未核验(元数据)]
- 定位：把已配置 Claude Code / CodeBuddy Code / OpenCode / Codex / Pi / Gemini CLI / Cursor 的工程桥入 DSH——skills、commands、memory、hooks、permissions、MCP 资产按会话工作区自动发现，无需迁移。[事实]
- 借鉴：与「Codex 只读角色」互补——若未来要把 Codex 的技能/记忆资产引入 DSH 上下文，可参考其资产发现架构。

### D12. Optim-Agent/optim-plans — human-in-the-loop 规划插件（v0.3 主动砍执行引擎）

- 元数据：MIT；Python；★1；最近提交 2026-08-09；活跃（个人项目）。[事实]
- 核心定位：Claude + Codex 双平台插件，**只做规划质量**：5 个规划技能按规模/风险分级（create-a-small-plan / create-a-plan / create-a-big-plan / diagnose-before-plan / reference-before-plan）；逐条提问（推荐项最先、Other 次末、**Auto-complete 末位且被硬性限制：不得批准执行握手、破坏性清理、部署/合并/push、凭据使用或任何外部状态变更**）；产出 `PLAN_vN.md` + `## Verifier Checklist`；Reviewer / Criticizer 细化轮；结尾原生执行握手问题（现在执行 / 仅规划）；**状态存于 Git common 目录 `.git/optim-plans/`：`run.json` 初始化后不可变 + `events.jsonl` append-only 重放推导状态**；v0.3 明确移除独立执行引擎（README 自述「keep the product focused on planning quality」）。[事实]
- 可借鉴点：
  1. **事件溯源式状态存储**（不可变 run.json + append-only 事件重放）——比我们的「整条记录覆写」更可审计，对应实现成本也更高。
  2. **Auto-complete 的权限边界**——若我们未来给 planner 问题加「自动回答」选项，应同样禁止其越权确认。
  3. **规划规模的技能分级**。
- 设计对照价值：optim-plans 主动砍执行引擎，反证我们「执行闭环 built-in」的方向差异（它们面向纯规划工作台，我们面向单一任务闭环）。[推断]

### D13/D14. 轻量示例

- **evgenygurin/codex-bridge**（MIT；Python；★1；2026-04-08）：把研究/文档类任务委托给 Codex CLI，省编排者上下文——「任务类型路由外派」的最小实现。[事实]
- **goharanwar/claude-codex-review**（MIT；Python；★1；2026-01-28）：MCP server 组合 Claude/Codex 审查。[事实]

---

## 4. 相邻可借鉴项目档案（精选要点）

- **plandex-ai/plandex**（MIT；Go；★15590；最近提交 2025-10-03；最新 release 2025-07-16；**维护走弱**，Cloud 已于 2025-10-03 停止接受新用户）：终端 plan→build 引擎；**累进 diff 审查沙箱**（改动隔离在沙箱、确认后才 apply，可回滚）；**plan 版本控制与分支**（多路径/多模型对比）；2M token 上下文 + tree-sitter 项目地图；命令自动调试；自动提交 + 提交信息生成。[事实] → 借鉴：diff 沙箱与 plan 分支的「方案对比」能力；警示：云托管停摆。[事实]
- **sst/opencode**（MIT；TypeScript；★198462；最近提交 2026-08-17）：终端开源编码 agent；内置 **build（全权）/ plan（只读：默认拒编辑、bash 需询问）** 双 agent + general 子代理；会话持久化/resume；TUI + desktop。[事实] → 借鉴：plan agent 的「默认拒绝」语义与我们只读 Codex 线程同思路，可对照实现粒度。
- **charmbracelet/crush**（NOASSERTION 许可声明；Go；★27450；活跃）：CHAT.md/AGENTS.md 编排；**多工作会话/多上下文 per project**；会话中切换 LLM 保留上下文；Agent Skills 标准兼容；工具 deny 白名单。[事实] → 借鉴：多会话实例管理与会话感知。
- **block/goose（现 aaif-goose/goose，Linux Foundation AAIF 托管）**（Apache-2.0；Rust；★52913；活跃）：通用本地 agent，桌面+CLI+API 三形态，15+ provider，70+ MCP 扩展，ACP provider，custom distro。[事实] → 借鉴：形态分发与 MCP 扩展生态（本项目为插件形态，无此负担，仅作参照）。
- **cline/cline**（Apache-2.0；TypeScript；★66354；活跃）：IDE/CLI/JetBrains/SDK/Kanban；human-in-the-loop 审批；**Kanban 并行任务板**（每卡独立 worktree、自动提交、依赖链）。[事实] → 借鉴：并行 worktree 卡板（valued for 大任务并行）。
- **RooCodeInc/Roo-Code**（Apache-2.0；TypeScript；★24331；**归档：README 宣布 2026-05-15 停运**，社区 fork Zoo-Code 接续）：Modes 显式分离（Code/Architect/Ask/Debug/Custom）、MCP、checkpoints。[事实] → 借鉴其模式分离的用户心智；**警示：单一 IDE 扩展项目的存续风险**。
- **All-Hands-AI/OpenHands**（MIT；TypeScript；★84325；活跃）：本地/Docker/VM/云后端可插拔的 agent 运行时、AgentCanvas、microagents、Planner agent、沙箱隔离。[事实] → 借鉴：运行后端可插拔与 Docker 沙箱（我们由 DSH 宿主提供沙箱，无需自建）。
- **geekan/MetaGPT**（MIT；Python；★69865；最近提交 2026-01-21；release 放缓 2025-03）：「Code = SOP(Team)」多角色（PM/架构/工程/QA）→ 结构化工件。[事实] → 借鉴：角色+Schema 化工件范式（我们已是其最简形态）。
- **crewAIInc/crewAI**（MIT；Python；★57215；活跃）：角色编排框架；PlanningFlow；hierarchical process 由 manager agent 审查结果。[事实] → 借鉴：PlanningFlow 与 manager 门。
- **microsoft/autogen**（CC-BY-4.0 报告许可；Python；★60471；release 2025-09-30 后放缓，AG2 分叉）：GroupChat planner/executor/critic 轮转、发言者选择与 max_turns。[事实] → 借鉴：终止条件设计（最大轮次/发言者策略）。
- **Aider-AI/aider**（Apache-2.0；Python；★48286；最近提交 2026-05-22）：**repo map** 压缩上下文、git 原生集成（自动提交/undo）。[事实(README)]；architect/code 双模式 [推断，基于官方文档的已知事实，本会话未逐条复核]。
- **Codium-ai/pr-agent**（MIT；Python；★12585；release 2026-08-08；活跃）：PR 审查命令族 describe/review/improve + GitHub Action/CLI 触发。[事实] → 借鉴：审查的 CI 触发形态。
- **SWE-agent/SWE-agent**（MIT；Python；★20071；release 2025-05-22）：issue→补丁 + ACI + 测试执行反馈闭环。[事实] → 借鉴：测试反馈作为修复信号（与我们 review 的 testResults 参数同思路，可强化闭环）。
- **yicheng47/runner**（MIT；元数据部分未核验；release 2026-08-17；活跃）：本地 ADE 桌面应用编排 crews——runner=运行时+角色+系统提示词+cwd，crew=多槽位一 lead；mission 每槽一个真实 PTY + **append-only 事件日志（崩溃/退出可回放恢复，日志即事实源）**；`ask_human` 上浮到事件流；**自身也以 MCP server 暴露**（agent 可编程建 crew/启 mission/发信号）；聊天/任务按 cwd 分项目组。[事实(README)] → 借鉴：事件日志即事实源 + ask_human 上浮 + 能力 MCP 化。

---

## 5. 功能矩阵

> 图例：●=具备且核验 [事实]；◐=部分/弱化（括号注明）；○=不具备或未见设计；—=未能核验/不确定；空=不适用或未确认。
> 机制列缩写：MCP=Model Context Protocol 接入；Hook=宿主钩子/事件；Skill=技能包/提示词包；AppSrv=Codex app-server JSON-RPC；CLI=直接调 CLI；Plugin=宿主插件体系。
> 行序：基线 → 直接同类 → 相邻借鉴。

### 表 A：协作模式（接入/角色分离/审查循环/结构化输出/机制）

| 项目 | 接入方式 | Planner/Executor 分离 | 独立 Reviewer | 自动修复循环 | 最大轮次 | 结构化输出 | 使用机制 |
|---|---|---|---|---|---|---|---|
| **dsh-codex-workflow（基线）** [事实] | Codex app-server `--stdio` JSON-RPC | ●（Codex 只读规划，DSH 会话执行） | ●（detached/inline read-only Codex） | ●（fix→re-review） | ●（默认 3，可配 1–10） | ●（Planner/Reviewer 双 JSON Schema） | Plugin(Tools) + AppSrv |
| Kevin7Qi/codex-collab [事实] | Codex app-server JSON-RPC | ◐（Claude 编排、无强制只读约束） | ●（review 命令：PR/未提交/commit） | ◐（review 后继续 run） | — | ●（结构化事件/结果，verdict 未固定 schema） | Skill + CLI |
| ching-kuo/claude-codex [事实] | Codex MCP server（CLI mcp-server） | ●（Plan→Implement 分技能） | ●（Codex 审 diff，verdict 3 级） | ●（≤3 轮） | ●（3，多处明示） | ●（APPROVED/WARNING/BLOCKED） | Skill + MCP |
| anhnguyen0905/codex-mcp [事实] | spawn `codex exec --json`（MCP 封装） | ●（Claude 规划；Codex 执行） | ●（Claude+codex_review 双审） | ●（fixes loop back） |？ | ●（RUN 结果含 diff/usage/attempts） | Plugin + MCP + CLI |
| atompilot/claude-code-cross-review [事实] | MCP（CLI 回退） | ◐（只分写/审两角色） | ●（Codex 审） | ●（loop until clean→commit） | — | ◐（非结构化文本） | Skill + MCP |
| claude-codex-gemini [事实] | CLI 子进程 ×3 模型 | ●（6 角色，Gemini 编排） | ●（顺序 Sonnet→Opus→Codex 双链） | ●（needs_changes 修复重审） | ●（每 reviewer 10） | ●（review JSON 文件） | CLI 脚本 (Bun/TS) |
| ArgusBot [事实] | Codex/Claude CLI（含 auth loop 包装） | ●（main/planner/reviewer 三角色） | ●（reviewer 结构化 JSON 门控） | ●（reviewer continue 驱动） | —（有 watchdog） | ●（reviewer JSON schema） | CLI wrapper（daemon） |
| claude-codex-forge [事实] | Codex CLI（PTY shim）+ Claude Code | ●（claude 设计、codex 复审） | ●（/codex review + /council 5 顾问） | ●（review loop + 收敛断路器） | ◐（POST_CERT_REVIEW_ROUND_LIMIT=3） | ◐（findings 分级/校准） | Hook + Skill + CLI |
| ralphex [事实] | Claude Code CLI / codex CLI 双执行器 | ●（plan 文件 → 任务逐条执行） | ●（5 并行初审 → 外部 codex → 2 终审） | ●（review→fix→review） | ●（max-iterations + max-external-iterations + review-patience） | ◐（文本 finding，agent 模板化） | CLI |
| codex-dobby-mcp [事实] | spawn codex exec（MCP 封装） | ●（plan 工具只读；build 工具执行） | ●（review 按领域扇出多子代理） | ◐ | — | ●（结构化结果+工件落盘） | MCP |
| dsh-crew [事实] | MCP（DSH hub/standalone） | ●（编排者→DSH worker 角色分离） | ○（无独立 reviewer 概念） | ◐（escalate_on_failure 一次重试） | — | ◐ | Plugin + MCP |
| dsh-bridges [事实(README)] | 资产桥接（非委托） | ○ | ○ | ○ | — | — | Plugin |
| optim-plans [事实] | Claude/Codex 双平台 skill | ●（只规划，v0.3 无执行） | ●（Reviewer/Criticizer 细化） | ○（v0.3 移除执行/重试/checkpoint） | ◐（细化到收敛） | ●（PLAN_vN + Verifier Checklist） | Skill + 控制器 CLI |
| plandex [事实] | OpenAI/Anthropic/Google 等模型直连 | ◐（plan→build 单 agent 双阶段） | ○ | ◐（自动调试循环） | — | ●（plan 版本化、diff 沙箱） | CLI + server |
| opencode [事实] | 多 provider 直连 | ●（build/plan 双内置 agent） | ○ | ○ | — | ◐ | CLI/TUI + App |
| crush [事实] | 多 provider 直连 | ○ | ○ | ○ | — | ◐ | CLI（会话/skills） |
| goose [事实] | 多 provider + MCP 扩展 | ◐（plan 能力，未细核） | ○ | ○ | — | ◐ | Desktop/CLI/API |
| cline [事实] | 多 provider 直连 | ◐（plan/act 模式） | ○ | ○ | — | ◐ | IDE/CLI/SDK/Kanban |
| Roo-Code [事实] | 多 provider + MCP | ●（Architect/Code 等显式模式） | ○ | ◐（checkpoints） | — | ◐ | IDE 扩展（已停运） |
| OpenHands [事实] | 多 provider/后端 | ●（Planner agent + 执行） | ◐（微代理/评审） | ◐ | — | ◐ | 平台（本地/Docker/云） |
| MetaGPT [事实] | 多 LLM 直连 | ●（PM/架构/工程/QA 角色） | ◐（QA 角色） | ◐ | — | ●（结构化工件） | 框架 |
| crewAI [事实] | 多 LLM 直连 | ●（PlanningFlow/hierarchical） | ●（manager/审查 agent） | ◐ | ◐（process 配置） | ◐ | 框架 |
| autogen [事实] | 多 LLM 直连 | ●（planner/executor/critic 轮转） | ●（critic 角色） | ●（GroupChat 循环） | ●（max_turns） | ◐ | 框架 |
| aider [事实] | 多 provider 直连 | ◐（architect/code 模式） | ○ | ○ | — | ◐ | CLI |
| pr-agent [事实] | 多 provider | ○（单审查 agent） | ●（PR 审查） | ○ | — | ●（结构化 review 输出） | GitHub Action/CLI |
| SWE-agent [事实] | 多 LM 直连 | ○ | ○ | ●（测试反馈循环） | ◐ | ◐ | CLI/平台 |
| yicheng47/runner [事实(README)] | Claude Code/Codex/Qoder CLI（PTY） | ●（crew：architect/impl/reviewer） | ●（reviewer 槽位） | ◐（crew 协作循环） | — | ●（事件日志） | Desktop + MCP + CLI |

### 表 B：状态与运维（绑定/持久化/恢复/取消/并发/沙箱/可见性）

| 项目 | 会话绑定 | cwd/workspace 绑定 | 状态持久化 | 重启恢复 | 取消/超时 | 并发会话 | Git/非 Git 审查 | 审批与沙箱 | Desktop 可见 task |
|---|---|---|---|---|---|---|---|---|---|
| **dsh-codex-workflow（基线）** [事实] | ●（dshSessionId 强绑定，单会话单活） | ●（cwd 继承 + runtimeWorkspaceRoots + review 后 settings 修正） | ●（JSON 记录原子写 + schemaVersion） | ●（thread/resume + pendingInput 重启语义明示） | ●（turn 超时→interrupt；idleProcessMs 回收；AbortSignal） | ◐（status 并发安全；每会话 1 活工作流） | ●（isGit 探测：uncommittedChanges vs custom） | ●（Codex 侧 never+read-only+无网；宿主侧 DSH 审批） | ●（Codex Desktop 归组：name+workspaceRoots+serviceName+sessionStartSource） |
| Kevin7Qi/codex-collab [事实] | ◐（线程/工作区职责；run 绑定 cwd） | ◐ | ●（线程历史/run logs 于 ~/.codex-collab/） | ●（thread resume） | ●（kill；approval 策略可配） | ◐（多线程并行运行） | ●（PR/未提交/指定 commit） | ●（approval 4 档；read-only 沙箱选项） | ◐（detach+follow 观测） |
| ching-kuo/claude-codex [事实] | ◐（会话内技能流） | ◐（.claude/plan/ 项目级） | ◐（计划文件落盘） | ◐（Codex 线程可续） | — | ◐（多技能多流程） | ●（git diff HEAD 审查） | ◐（依赖用户审批） | — |
| anhnguyen0905/codex-mcp [事实] | ◐（per-workspace 串行） | ●（工作区内 .codex-flow/ 状态） | ●（STATE.md 恢复权威 + 切片 + 需求/任务文件） | ●（bounded auto-resume ≤2 次 + 退避） | ●（timeout/kill；aborted 信号） | ●（并行 wave：worktree+subagent，≤10） | ●（diff 返回，非 git null） | ●（sandbox 3 档暴露 + read-only） | ◐（live progress/terminal） |
| atompilot/cross-review [事实] | ◐ | ◐ | ○ | ○ | — | ○ | ●（未提交 diff） | ◐ | — |
| claude-codex-gemini [事实] | ◐（.task/ 状态 + 类型隔离 codex session） | ◐（项目内 .task/；跨平台脚本） | ●（FS-as-state .task/*.json；迭代计数） | ◐（codex session 自动 resume/重开） | ◐（run-codex --timeout） | ○（顺序） | ◐（git 隐式） | ◐ | — |
| ArgusBot [事实] | ●（session_id 持久 + daemon 恢复） | ◐（.argusbot/ 项目内） | ●（state.json + JSONL 归档 + plan 快照） | ●（resume last session_id；脏工作区先 git checkpoint） | ●（/stop；stall watchdog 1h/3h） | ◐（多项目多 run） | ◐（git 隐式） | ◐ | ◐（Telegram/飞书控制 + 报告） |
| claude-codex-forge [事实] | ◐（每开发者 state.md；worktree 并行会话） | ●（worktree 隔离 + cwd 修复） | ●（记忆层 + ADR/CHANGELOG + state.md） | ◐（state 跨 worktree 守卫折叠） | ◐（hooks 门控） | ●（worktree 多会话） | ●（基于 git 的审查） | ●（hooks 拦 Bash、敏感文件门） | — |
| ralphex [事实] | ◐（每任务全新会话） | ◐（计划目录参数） | ●（plan 文件 + 进度日志 + 分支/提交） | ◐（可重跑未完成 task；checkpoint 提交） | ●（session-timeout/idle-timeout；Ctrl+\ 打断；超时杀会话） | ●（--worktree 并行多计划） | ●（git diff master...HEAD 审查） | ◐（--dangerously-skip-permissions 等透传；Docker 隔离选项） | ◐（--serve 网页进度） |
| codex-dobby-mcp [事实] | ◐（后台 run task_id） | ●（强制绝对 repo_root） | ●（logs/outputs 落盘；list_runs 恢复） | ◐（task_id 恢复查询） | ●（timeout_seconds；wait 语义） | ●（多后台 run 并行） | ◐（git worktree 前提） | ●（danger 显式参数；沙箱模式） | ◐（wait_run/get_run 进度） |
| dsh-crew [事实] | ●（worker=DSH 一等 session，Web UI 可见、按 cwd 归组） | ●（cwd + preset 层级） | ●（status 镜像/事件流） | ◐ | ●（dsh_worker_cancel；timeout 参数） | ●（多 worker 并行） | — | ●（宿主沙箱 + 工具审批） | ●（DSH Web 会话列表 + HUD 状态段） |
| optim-plans [事实] | ◐（run-id） | ◐（.git/optim-plans 在 git 公共目录） | ●（run.json 不可变 + events.jsonl 追加重放） | ◐（重放推导状态） | ◐ | ○ | ◐ | ◐（hooks 只读细化 + deny 越权写） | — |
| plandex [事实] | ◐（session/plan 概念） | ◐ | ●（server 侧持久化 + plan 版本化/分支） | ◐ | ◐ | ◐ | ●（git 集成/自动提交） | ●（diff 沙箱审查后应用） | — |
| opencode [事实] | ●（会话持久化/resume） | ◐ | ● | ● | ◐ | ◐ | ◐ | ◐（plan agent 默认拒编辑/bash 询问） | — |
| crush [事实] | ●（多会话 per project） | ◐ | ● | ◐ | ◐ | ● | ◐ | ◐ | — |
| cline [事实] | ◐ | ◐ | ◐ | ◐（任务恢复） | ◐ | ●（Kanban 并行 + 依赖链） | ● | ●（human-in-the-loop 审批） | — |
| yicheng47/runner [事实(README)] | ●（mission 事件日志即事实源，quit/crash 可恢复） | ●（项目按 cwd 分组继承） | ● | ●（日志回放） | ◐（中断/取消未细核） | ●（crews/多槽位 PTY） | ◐ | ◐（ask_human 上浮） | ●（桌面面板/分屏/任务页） |

> 说明：「—」表示未核验或该维度不适用；矩阵单元格均为 2026-08-17 核验快照，个别薄弱项（如 crush/goose/cline 的恢复细节）未逐一深挖，标注见附录。

---

## 6. 与 dsh-codex-workflow 的源码级对照

> 基线事实依据本地 README.md + `src/`（index/store/workflow/tools/schemas/config/app-server/types，2026-08-17 通读）。

### 6.1 我们已经具备、而同类项目通常缺少的能力 [事实(基线)/推断(比较)]

1. **「宿主会话=唯一可写执行器」的硬约束**。Codex 双角色从线程创建起就锁定 `sandbox: read-only` + `approvalPolicy: never`，turn 内再强制 `readOnly + networkAccess: false`；授权/审批完全由 DSH 宿主侧决策。对比：claude-codex / ArgusBot / forge / ralphex 等方案中被委托方（Codex/Claude）普遍拥有写权限或至少依赖各自审批，评审与写权限的隔离不如我们彻底。（链路上 `item/.../requestApproval` 一律 `decline`，[事实]）。
2. **workflow 与 DSH 会话的强所有权模型**。`record.dshSessionId` 写入即绑定，`status/owned` 双重校验；`activeForSession` 保证单会话单活工作流，跨会话状态机天然隔离。多数同类是进程级或目录级的状态管理（如 ralphex 读 `docs/plans/` 目录、ArgusBot 读 `.argusbot/bus`），没有「该工作流属于哪个宿主会话」的所有权概念。
3. **Codex Desktop 可见性工程**。`thread/name/set` + `runtimeWorkspaceRoots:[cwd]` + `serviceName: dsh-codex-workflow` + `sessionStartSource: startup` + `ephemeral: false`，并在 detached review 后 `thread/settings/update` 修正 cwd（避免归到 app-server 进程 cwd）。同类项目基本不处理「Codex Desktop 把这些线程归到哪个项目」这一层（Kevin7Qi/codex-collab 接近但不完整）。
4. **Planner/Reviewer 双 JSON-Schema 强约束 + 容错解析**。`PLANNER_OUTPUT_SCHEMA`（status/planMarkdown/questions/assumptions）与 `REVIEW_OUTPUT_SCHEMA`（verdict/findings[severity,file,line]/testGaps/summary）全字段约束（`additionalProperties:false`），解析时剥 ```json 围栏、非法值直接判失败。同类中只有极少数做同等强度的 schema（ArgusBot 的 reviewer JSON 是弱约束；claude-codex 的 verdict 无字段 schema）。
5. **持久化/恢复的完整闭环**。JSON 记录原子写（tmp+rename）、`schemaVersion` 校验、planner/reviewer 双 threadId 持久化、`thread/resume`（`excludeTurns:true`）恢复线程，并**显式设计和文档化 pendingInput 跨进程重启语义**（原 JSON-RPC requestId 进程内，重启后以新 turn 重发答案）。绝大多数同类只做到「重启后重跑」或「线程可续」，没有 state 文件级别的恢复契约。
6. **宿主回合结束护栏**。`agent/turn-stopping` 钩子：执行/修复阶段若 agent 试图结束回合，`steer` 强制提醒「先完成计划/修复并 review」。同类项目没有等价机制（它们多为独立 CLI 或外部 daemon，宿主回合概念本就不同）。
7. **进程生命周期治理**。request 级超时 + turn 级超时（超时先尝试 `turn/interrupt` 再失败）、`idleProcessMs` 闲置回收 `codex app-server`、stderr 尾部 16KB 留存用于故障诊断、AbortSignal 全链路贯穿（工具超时/宿主取消均可传导）。这是「作为宿主内长时间运行服务」的工程细节，多数一次性脚本类项目没有。
8. **Git/非 Git 双路径审查**。`isGitRepository` 探测决定 `review/start` 的 target 是 `uncommittedChanges` 还是 `custom instructions`（后者把计划+实现摘要+文件+测试结果拼成审查指令）。
9. **移除 credential 接触面**（README 声明不读取/复制凭据、不改 Codex 配置、不开网络监听）——安全边界的明确承诺。

### 6.2 别人具备、我们值得加入的能力（按借鉴强度排序）

| # | 能力 | 出处 [事实] | 我们的差距 | 建议 |
|---|---|---|---|---|
| 1 | **审查结果携带 diff 证据**（`git status --porcelain`+`git diff HEAD`，64KB cap） | codex-mcp、cross-review | 我们只回传 verdict/findings 文本，宿主需自行 diff | 在 review 工具返回中附带「变更摘要 diff」，执行器按图修复，减少轮次 |
| 2 | **非阻塞改进裁决门**（MEDIUM/LOW 交给用户决定，不进自动修复） | claude-codex、codex-mcp（non-blocking improvements） | 我们的 findings 全部进入修复循环，可能过度修复/烧额度 | review schema 增加 blocking 维度或在 findings 分级上做「用户裁决」分流 |
| 3 | **审查停滞/徒劳检测**（连续 N 轮无提交/无工作树变化即终止 + 提示） | ralphex `--review-patience` | 我们只有 maxReviewCycles 计数 | 增加「no-change rounds」检测，终止并提示人工 |
| 4 | **review-only 纯审查模式**（对已有改动发起审查，不强制走 planner） | ralphex `--review`、codex-collab `review` | 目前 review 必须依附已完成规划的 workflow | 提供独立审查入口（可复用现有 review 管线） |
| 5 | **成本/用量观测与预算**（token/时长/失败聚合 + 预算上限自动降级/停止） | codex-mcp `codex_metrics`/`session-cost` | 无任何用量上报 | 每轮记录 model/token/耗时；超标告警 |
| 6 | **TDD 门**（先审测试再放行实现） | claude-codex `tdd-*` | 无 | 可作 P2 的「测试先行」工作流变体 |
| 7 | **并行多工作区**（git worktree 分波执行，独立审查后合并） | codex-mcp waves、ralphex `--worktree`、Cline Kanban | 明确单会话单活 | P1-P2：多 cwd 的并行 workflow 实例（需先解决合并冲突与审批复核） |
| 8 | **审查角色定制模板**（`{{agent:name}}` 模板系统、agent 文件 frontmatter） | ralphex | planner/reviewer 只有 model/effort 可配 | 支持 developer_instructions/persona 文件注入 |
| 9 | **bounded auto-resume**（瞬时失败自动续跑 ≤2 次，退避重试） | codex-mcp | 我们失败即置 failed | 对 turn/进程级瞬时失败增加有界自动重试 |
| 10 | **事件溯源式状态存储**（run.json 不可变 + events.jsonl 追加重放） | optim-plans | JSON 整条覆写 | 可做低成本改良：写 append-only journal，保留审计链 |
| 11 | **多级/多模型审查门**（Sonnet→Opus→Codex 顺序；或 council 并行顾问） | codex-gemini、forge `/council` | 单一 Codex reviewer | 可选配置多 reviewer（模型/角色数组） |
| 12 | **停滞看门狗 + 硬重启窗**（1h 软诊断/3h 硬重启） | ArgusBot | 只有 turn 超时 | 增加「长时间无进展」检测（区别于超时） |
| 13 | **决策门收窄**：计划门可论证「更少」（NECESSITY 轴） | forge | planner 只出计划不问「是否必要」 | 在 planner prompt 加「可移除项/简化项」要求 |
| 14 | **回合内权宜恢复**：计划阶段问题支持「失败开放」默认继续 | codex-collab ask fail-open、optim-plans Auto-complete（带权限边界） | waiting_input 会一直等宿主 | 增加「超时后按假设继续」选项（注意权限边界） |
| 15 | **任务类型路由**（研究/文档型任务外派给 Codex，省宿主上下文） | codex-bridge、dsh-crew | 无 | 可作为轻量工具补充 |

### 6.3 不建议照搬的设计及原因

1. **ralphex 的「每任务全新会话」**：用牺牲会话连续性换取模型上下文「清醒」。与我们的核心价值（宿主会话=执行器、审批与上下文一体化）冲突；且其 README 自述依赖 `claude -p` 已被划入独立计费池，无人值守成本与策略风险高。**替代方案**：借其「fresh context chunks」思路——我们的 planMarkdown 注入已是雏形，可进一步对超长计划做分块注入。[事实+推断]
2. **optim-plans v0.3 砍掉执行引擎**：它是「纯规划工作台」定位，执行闭环缺失使「审查-修复」闭环不复存在，恰好是我们存在的理由。但其**状态不可变+事件追加重放**与 **Auto-complete 权限边界**两处设计值得吸收。[事实+推断]
3. **codex-gemini 的「文件系统即状态」**：`.task/*.json` 存在性判相位、无锁、迭代计数直接写文件，多会话并发会竞争；我们 JSON store + 原子写 + schemaVersion 更稳。**不要**为了「看得见」而回退到散落状态文件。[推断]
4. **forge 的「巨型 .claude/ 模板提交进仓库」**：其 changelog 反复记载跨版本 merge 冲突、`--upgrade` 覆写用户自定义、版本漂移告警——把工作流机械提交进项目是团队级重工程，插件形态不合适。[事实]
5. **同一模型互审**：ralphex 明确论证「codex 审 codex 是同模型自审、信号弱」并因此默认跳过该阶段。我们的 planner 与 reviewer 虽同为 Codex，但走**不同线程、可配不同 model/effort**，且审查对象是宿主实现而非 Codex 自己的输出，信号来源不同；**不要**增加「同一 turn 内自己规划自己审查」的快捷路径。[事实+推断]
6. **依赖外部托管服务**：Plandex Cloud 停摆即为教训；我们全部本机进程（`codex app-server --stdio`）+ 本机状态文件，无外部依赖，保持。[事实+推断]

### 6.4 下一阶段候选功能（P0/P1/P2）

> 每项含：用户价值 / 实现难度 / 风险 / 参考项目。

**P0（高价值、中低难度、低风险，建议下一迭代）**

1. **审查证据回传（diff 摘要）**
   - 价值：执行器不再盲改，修复更准、轮次更少；审查结论可审计。
   - 难度：中（review outcome 聚合 `git status`/`diff`，64KB cap、非 git 降级）。
   - 风险：低（纯增量字段，不回破坏 schema 兼容——扩张 review 返回结构）。
   - 参考：anhnguyen0905/codex-mcp（diff 字段）、atompilot/cross-review。
2. **非阻塞改进裁决门**
   - 价值：避免「审查说什么都修」的过度修复与额度浪费；把判断权交还用户。
   - 难度：低-中（Review schema 增加 blocking 标志或沿用 severity 分级做分流）。
   - 风险：中（模型对 blocking 分类可能不稳定——需在 normalize prompt 中给明确判据）。
   - 参考：ching-kuo/claude-codex（BLOCKED/WARNING/MEDIUM-LOW 分流）。
3. **审查停滞/徒劳检测（no-change rounds 终止）**
   - 价值：防死循环烧额度；结合现有 maxReviewCycles 形成「计数+进展」双保险。
   - 难度：低（记录每轮 commit/工作树变化，连续 N 轮无变化即 blocked）。
   - 风险：低。
   - 参考：ralphex `--review-patience`。
4. **review-only 纯审查入口**
   - 价值：用户改完代码想单独让 Codex 审，不必再造 workflow。
   - 难度：中（复用 review 管线 + `thread/start` 只读线程，不需要 planner）。
   - 风险：中（脱离计划的审查需要独立的审查指令模板）。
   - 参考：ralphex `--review`、Kevin7Qi/codex-collab `review`。

**P1（高价值、中高难度、中风险）**

5. **用量/成本观测与预算**
   - 价值：额度合规、防止单任务烧穿预算；向用户透明。
   - 难度：中（每轮记录 token/耗时；需要从 app-server 事件或返回中取 usage；预算达限自动降 effort/停止）。
   - 风险：低-中（usage 字段来源与口径需验证）。
   - 参考：codex-mcp `codex_metrics` / `session-cost`。
6. **并行多工作区（git worktree / 独立 cwd 实例）**
   - 价值：大任务分块并行，显著缩短总时长。
   - 难度：高（并行 workflow 实例、会话绑定扩展、合并冲突处理、审批复核）。
   - 风险：高（写冲突、计划上下文跨工作区一致性）。
   - 参考：codex-mcp waves、ralphex `--worktree`、Cline Kanban、yicheng47/runner crews。
7. **审查角色定制（persona/developer_instructions 注入）**
   - 价值：领域化审查（安全/性能/架构），适配团队规范。
   - 难度：中（配置面扩展：接收 persona 文件或指令文本，注入 planner/reviewer 线程）。
   - 风险：低-中（prompt 膨胀与 schema 约束的平衡）。
   - 参考：ralphex agents/`{{agent:name}}`、forge CALIBRATION 校准块。
8. **bounded auto-resume（瞬时失败自动续跑）**
   - 价值：网络抖动/进程瞬时退出不再直接判 failed，减少人工介入。
   - 难度：中（区分瞬时与确定性失败；有界重试+退避；保留干预入口）。
   - 风险：中（错误分类不当时会掩盖真问题——需保留 error 详情并记录 attempts）。
   - 参考：codex-mcp（≤2 次自动 resume + resumeReasons）。

**P2（增强体验/生态，视资源推进）**

9. **TDD 门 / E2E 证据门工作流变体**
   - 价值：测试先行与「声明-证据」绑定提升交付质量。
   - 难度：中-高（新工作流模板 + reviewer 指令扩展）。
   - 风险：中（流程变长，用户接受度待验证）。
   - 参考：claude-codex `tdd-*`、forge E2E 证据门。
10. **能力 MCP 化（让其他宿主消费本工作流）**
    - 价值：Claude Code/其他 Agent 可调用我们的闭环；生态扩展。
    - 难度：中-高（MCP server 封装现有 manager；需处理宿主内权限/会话语义）。
    - 风险：中（双重审批语义、多宿主并发）。
    - 参考：codex-dobby-mcp、dsh-crew（MCP 工具面）、yicheng47/runner（自身即 MCP server）。
11. **事件溯源式状态日志（append-only journal）**
    - 价值：审计与故障回溯。
    - 难度：低-中（保留现有 JSON 主存储，另写 appendix journal 或迁移 store 实现）。
    - 风险：低。
    - 参考：optim-plans（run.json 不可变 + events.jsonl 重放）。
12. **停滞看门狗（无进展检测，区别于超时）**
    - 价值：长时间无进展时主动诊断/重启。
    - 难度：中。
    - 风险：低-中。
    - 参考：ArgusBot（1h 软诊断/3h 硬重启）。
13. **工作流可见性面板（DSH Web UI 内阶段/轮次/成本展示）**
    - 价值：直观观测多轮修复状态。
    - 难度：中-高（DSH Web 注入先例见 dsh-crew）。
    - 风险：中（Web UI 集成成本）。
    - 参考：dsh-crew 设置页/面板、ArgusBot --serve。

---

## 7. 来源确认的事实 vs 推断/建议

### 7.1 本报告直接核验的事实（2026-08-17，共 32+ 仓库）

- 全部 GitHub API 字段（许可证/语言/stars/`pushed_at`/`archived`/默认分支）见附录表；release 日期来自 `releases.atom`。
- 直接同类 D1–D14、相邻 A1–A16 的 README 细读内容（§3/§4 内标注 [事实] 的每一条），均来自 raw.githubusercontent 原文。
- 基线 dsh-codex-workflow 的全部能力描述来自本地 README + src 通读（§6.1）。
- 特别事实：Roo-Code 归档（README「shut down on May 15th」+ API `archived:true`、`pushed_at: 2026-05-15T18:08:47Z`）；ralphex 的 codex 自审弱信号结论；ralphex 对 Claude Agent SDK 计费池的说明；optim-plans v0.3 移除执行引擎；plandex Cloud 2025-10-03 停止（README 明示）；goose 迁移至 aaif-goose/goose（Linux Foundation）；sweep 转型 JetBrains 插件（描述字段）。

### 7.2 推断/建议（非事实）

- 「dsh-codex-collab 为内部迭代名」的判定（检索未命中，属推断）。
- 所有 §6.2/§6.4 的「值得加入/候选功能/难度/风险」意见。
- 「成熟度/维护状态」的定性评语（基于原始数据的时间间隔推断，原始数据可复核）。
- 对「不建议照搬」各条的目的地分析（§6.3 标注 [推断] 的部分）。
- 功能矩阵中标注「◐/—」单元格的定性判断。[推断]

### 7.3 未核验清单（未进入矩阵事实单元格）

- Cognition Runner、Sourcegraph Amp、coderabbitai ai-pr-reviewer 的当前仓库（404/未定位）。
- `dsh-bridges`、`yicheng47/runner` 的 stars/license 等 API 字段（限流）。
- aide architect 模式细节（仅以官方文档常识引用并标注）。

---

## 8. 附录

### 8.1 仓库核验数据表（api.github.com / releases.atom，2026-08-17）

| 仓库 | 许可证 | 语言 | ★ | forks | 最近提交(pushed_at UTC) | 最新 release | 归档 |
|---|---|---|---|---|---|---|---|
| dsh-codex-workflow（基线，本地） | MIT | TypeScript | — | — | — | — | 否 |
| Kevin7Qi/codex-collab | MIT | TypeScript | 95 | 8 | 2026-08-15T14:42:20Z | 2026-08-05 | 否 |
| ching-kuo/claude-codex | MIT | —(skill 为主) | 23 | 6 | 2026-04-01T06:34:56Z | — | 否 |
| anhnguyen0905/codex-mcp | MIT | TypeScript | 3 | 1 | 2026-08-14T03:55:58Z | ~v0.15+（2026-08 区间，README 提及） | 否 |
| atompilot/claude-code-cross-review | none | Shell | 0 | 0 | 2026-03-07T03:23:04Z | — | 否 |
| Z-M-Huang/claude-codex-gemini | GPL-3.0 | TypeScript | 18 | 3 | 2026-02-06T02:10:42Z | — | 否 |
| waltstephen/ArgusBot | MIT | Python | 314 | 28 | 2026-04-26T20:19:15Z | —（无正式 release） | 否 |
| pablomarin/claude-codex-forge | MIT | Shell | 5 | 3 | 2026-07-28T01:04:13Z | 频繁迭代（README 版本 5.x） | 否 |
| umputun/ralphex | MIT | Go | 1435 | 118 | 2026-08-17T16:07:04Z | 2026-07-21 | 否 |
| Averyy/codex-dobby-mcp | MIT | Python | 0 | 0 | 2026-07-10T18:06:31Z | — | 否 |
| ZSeven-W/dsh-crew | MIT | JavaScript | 43 | 2 | 2026-08-17T10:01:28Z | —（0.1.0-rc.1，npm） | 否 |
| yhlooo/dsh-bridges | —（未核验） | — | — | — | — | — | 否 |
| Optim-Agent/optim-plans | MIT | Python | 1 | 0 | 2026-08-09T13:23:55Z | v0.3.0（README 自述） | 否 |
| evgenygurin/codex-bridge | MIT | Python | 1 | 0 | 2026-04-08T17:37:53Z | — | 否 |
| goharanwar/claude-codex-review | MIT | Python | 1 | 0 | 2026-01-28T17:50:42Z | — | 否 |
| plandex-ai/plandex | MIT | Go | 15590 | 1171 | 2025-10-03T21:49:58Z | 2025-07-16 | 否 |
| sst/opencode | MIT | TypeScript | 198462 | 25573 | 2026-08-17T21:20:17Z | 2026-08-13 | 否 |
| charmbracelet/crush | NOASSERTION | Go | 27450 | 2163 | 2026-08-17T17:35:20Z | 2026-08-17 | 否 |
| block/goose（现 aaif-goose/goose） | Apache-2.0 | Rust | 52913 | 6021 | 2026-08-17T19:04:32Z | 2026-08-12 | 否 |
| cline/cline | Apache-2.0 | TypeScript | 66354 | 7138 | 2026-08-17T21:10:02Z | 2026-08-14 | 否 |
| RooCodeInc/Roo-Code | Apache-2.0 | TypeScript | 24331 | 3416 | 2026-05-15T18:08:47Z | — | **是** |
| All-Hands-AI/OpenHands | MIT | TypeScript | 84325 | 10952 | 2026-08-17T21:06:54Z | 2026-08-13 | 否 |
| geekan/MetaGPT | MIT | Python | 69865 | 8885 | 2026-01-21T10:12:33Z | 2025-03（放缓） | 否 |
| crewAIInc/crewAI | MIT | Python | 57215 | 8173 | 2026-08-17T20:20:58Z | 2026-08-14 | 否 |
| microsoft/autogen | CC-BY-4.0(报告) | Python | 60471 | 9115 | 2026-04-15T11:59:09Z | 2025-09-30 | 否 |
| Aider-AI/aider | Apache-2.0 | Python | 48286 | 4850 | 2026-05-22T14:02:20Z | 2026-02-12 | 否 |
| Codium-ai/pr-agent | MIT | Python | 12585 | 1714 | 2026-08-16T07:59:00Z | 2026-08-08 | 否 |
| SWE-agent/SWE-agent | MIT | Python | 20071 | 2197 | 2026-08-10T22:08:15Z | 2025-05-22 | 否 |
| sweepai/sweep | NOASSERTION | Jupyter Notebook | 7698 | 466 | 2025-09-18T06:10:59Z | — | 否 |
| smol-ai/developer | MIT | Python | 12185 | 1072 | 2024-04-07T07:11:03Z | — | 否 |
| openai/codex | Apache-2.0 | Rust | 106485 | 16179 | 2026-08-17T21:13:19Z | 2026-08-17 | 否 |
| anthropics/claude-code | none(仓库字段) | Python | 141768 | 22763 | 2026-08-17T20:20:58Z | — | 否 |
| yicheng47/runner | MIT（README 声明） | —（未核验） | — | — | — | 2026-08-17 | 否 |

### 8.2 检索/核验失败的仓库（2026-08-17）

- `runner-ai/runner`、`CognitionAI/runner`、`CognitionIA/runner` → 404
- `sourcegraph/amp`、`ampcode/amp` → 404
- `coderabbitai/openai-pr-reviewer`、`coderabbitai/ai-pr-reviewer`、`aidesignlab/ai-pr-reviewer` → 404
- `dsh-codex-collab`（npm）→ 404

### 8.3 主要参考链接

- 基线：https://github.com/deepseek-ai/deepseek-harness （DSH）；本仓库 dsh-codex-workflow
- 直接同类核心 README：Kevin7Qi/codex-collab · ching-kuo/claude-codex · anhnguyen0905/codex-mcp · atompilot/claude-code-cross-review · Z-M-Huang/claude-codex-gemini · waltstephen/ArgusBot · pablomarin/claude-codex-forge · umputun/ralphex · Averyy/codex-dobby-mcp · ZSeven-W/dsh-crew · yhlooo/dsh-bridges · Optim-Agent/optim-plans
- 相邻：plandex-ai/plandex · sst/opencode · charmbracelet/crush · aaif-goose/goose · cline/cline · RooCodeInc/Roo-Code · All-Hands-AI/OpenHands · geekan/MetaGPT · crewAIInc/crewAI · microsoft/autogen · Aider-AI/aider · Codium-ai/pr-agent · SWE-agent/SWE-agent · yicheng47/runner

---

*报告完。核验日期：2026-08-17。*