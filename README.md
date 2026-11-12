# codex-workflow

让 Codex 负责只读规划和审查，让宿主 Agent 负责实施与测试的独立 Skill。支持规划、澄清、修复复审和单独审查，运行于 Windows、Linux、macOS。

适用于能够读取 `SKILL.md` 并执行本地 Node 命令的 Agent。不同宿主的 Skill 安装位置、发现方式和调用语法由宿主决定。

**2.x 已从 DSH 插件转为独立 Skill。** 旧 DSH 插件入口、侧栏和安装方式已经退役；旧数据和配置不自动迁移。[文档导航](docs/README.md)区分现行指南与历史资料。

## 下载与安装

1. 从 [GitHub Releases](https://github.com/kui123456789/dsh-codex-workflow/releases/latest) 下载附件 **`codex-workflow.zip`**。
2. 解压后，将完整的 `codex-workflow/` 目录复制到宿主支持的 Skill 目录。保留 `SKILL.md`、`references/`、`agents/` 和 `scripts/` 的相对位置。
3. 准备以下运行环境，在 Skill 目录运行能力检查。

| 依赖 | 要求 |
| --- | --- |
| Node.js | `^22.19.0 || >=24.0.0`，即 22.19 起的 22.x，或 24 及以上版本 |
| Codex CLI | 模型操作前完成配置和登录 |
| Git | 审查 Git 工作区时需要；非 Git 工作区须提供明确文件范围 |

```sh
node scripts/workflow.mjs doctor
```

分发包已包含运行时，使用时无需安装 npm 依赖。Release 中自动生成的 **Source code** 是源码快照，需要自行构建；直接安装请使用 `codex-workflow.zip`。附件 `artifacts.json` 和 `SHA256SUMS` 提供逐文件清单及 SHA-256 校验值。

`doctor` 检查 Node、Codex CLI 版本及命令能力，不调用模型，也不验证登录或真实推理成功。`doctor --offline` 只检查 Node。完整真实调用的验证范围见[版本验证记录](docs/verification-2.0.0.md)。

## 使用方式

让宿主读取 [SKILL.md](SKILL.md)，再提出任务。支持命名 Skill 的宿主可以使用 `$codex-workflow`；其他宿主使用其自身的 Skill 调用方式。

规划并实施的请求示例：

```text
使用 codex-workflow，为当前项目增加健康检查命令。由 Codex 规划和审查，你负责实现并运行测试。
```

单独审查的请求示例：

```text
使用 codex-workflow 审查当前项目的未提交修改，报告发现和测试缺口；本次只审查。
```

正常流程是 Codex 规划、用户回答必要问题、宿主实施并测试、Codex 审查。阻塞问题进入修复复审；仅有非阻塞建议时，提交用户决定；通过后报告结论和实际验证证据。单独请求审查不授权自动修复。

运行时默认最多审查 3 轮，仍有阻塞问题且连续 1 轮无可验证变化时停止修复。失败、证据不足或进程清理不确定时，宿主按返回的状态停止或等待，不能把这些情况当作通过。

## 命令与状态

统一入口是 `node scripts/workflow.mjs <command>`。命令返回 JSON，诊断写入 stderr。长文本使用 JSON 输入文件或 stdin；业务命令包括：

| 用途 | 命令 |
| --- | --- |
| 规划与澄清 | `start`、`continue` |
| 审查实施结果或单独审查 | `review`、`review-only` |
| 状态与原线程恢复 | `status`、`resume` |
| 非阻塞建议决策与取消 | `decide`、`cancel` |

模型操作在后台 worker 中执行。提交命令返回工作流 ID 后，使用 `status` 查询结果；单次等待最多 30 秒。`resume` 只续接符合条件的原线程，不能替换为最近使用的线程。参数、输入格式和完整返回字段见 [CLI 协议](references/cli.md)。

状态默认保存在 `~/.codex-workflow/`，由 SQLite 和工作流产物目录组成。通过 `CODEX_WORKFLOW_HOME` 或 `--home` 可以覆盖；状态目录须位于目标项目之外。同一项目目录默认只允许一个活动工作流，不需要常驻服务或网络监听。证据失效、取消及恢复诊断见[恢复与证据](references/recovery.md)。

## 从源码开发

开发需要 `package.json` 指定的 pnpm 版本。首次安装与常用检查：

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm pack:skill
```

`pnpm verify` 包含类型检查、构建和完整测试。`pnpm pack:skill` 生成 `dist/codex-workflow/` 和 `dist/codex-workflow.zip`；生成的 `scripts/workflow.mjs` 与 `dist/` 不手工编辑。

发布前运行 `pnpm verify:isolated`，它在源码副本中连续执行两轮 `release:check`。详细步骤、收据位置和产物交付方式见[发布检查清单](docs/release-checklist.md)。仓库开发约定见 [AGENTS.md](AGENTS.md)。

## 验证与历史

[v2.0.0 验证记录](docs/verification-2.0.0.md)固定到发布提交：三平台六项 CI、本机和 GitHub 隔离发布门禁均通过；真实 Codex 功能链路未验收通过。模拟 Codex 子进程测试与真实模型验证分别记录。

[CHANGELOG](CHANGELOG.md)保留版本变化；[DSH 历史资料](docs/README.md#dsh-插件历史资料)中的宿主配置、ephemeral 会话和侧栏说明属于 1.x 插件时期。
