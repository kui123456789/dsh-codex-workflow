# v2.0.0 验证记录

本记录对应 2026-11-12 发布的 **v2.0.0**，固定源码提交为 `99f007f48c94b99b43f5ab2ef38e1d8ef53a4421`。后续分支提交须单独验证。

- [GitHub Release](https://github.com/kui123456789/dsh-codex-workflow/releases/tag/v2.0.0)
- [发布源码](https://github.com/kui123456789/dsh-codex-workflow/tree/99f007f48c94b99b43f5ab2ef38e1d8ef53a4421)
- [三平台 CI](https://github.com/kui123456789/dsh-codex-workflow/actions/runs/43228755072)
- [GitHub 隔离发布门禁](https://github.com/kui123456789/dsh-codex-workflow/actions/runs/43228758905)

## 自动化验证

| 环境 | Node | 结果 |
| --- | --- | --- |
| GitHub Actions / Windows | 22.19、24 | 两项各 54/54，无失败、跳过、取消 |
| GitHub Actions / Linux | 22.19、24 | 两项各 54/54，无失败、跳过、取消 |
| GitHub Actions / macOS | 22.19、24 | 两项各 54/54，无失败、跳过、取消 |
| 本机 Windows | 24.14.0 | `pnpm verify:isolated` 连续两轮各 54/54 |
| GitHub Actions / Windows 隔离发布流程 | 24 | 连续两轮 `release:check` 各 54/54 |

每轮包含六个测试文件的完整原生收据。六项矩阵收据和 GitHub 隔离流程的两项收据已下载核对；两次本机门禁的源码指纹前后一致。

类型检查、构建、离线 doctor、Skill validator、ZIP 完整性、包内文件清单及无源码、无 `node_modules` 的复制包运行检查通过。转换期间，独立 Agent 还使用复制到中文及空格路径的 Skill 完成隔离审查示例，目标文件未改变。

这些测试通过 fake Codex 覆盖真实子进程边界，包括澄清、复审、独立审查、非阻塞决策、取消、原线程恢复，以及回执缺失、非法输出、超时、并发启动、证据变化和清理不确定的拒绝行为。它们不证明真实 Codex 模型链路成功。

## 真实 Codex 验证

**功能链路未验收通过。** 转换期间执行过两次最小试跑：

1. 默认配置试跑在 120 秒超时，随后确认所捕获的原进程树清理完成。
2. 隔离配置试跑返回符合 schema 的 Planner 失败结果；Windows 只读 workspace policy 阻止读取测试文件。

两次试跑均未修改目标工作区。第二次只证明结构化失败结果能被接收，不能作为规划、实施、审查闭环通过的证据。GitHub 发布阶段未重新运行真实模型试跑。

进程清理的证明限于捕获并核验身份的进程实例。POSIX 身份核对与信号发送不原子，macOS 进程出生时间为秒级；未知身份或无法确认清理时，运行时拒绝恢复。

## 发布附件

| 文件 | SHA-256 |
| --- | --- |
| `codex-workflow.zip` | `53b3226b4eb254e35721547c6e9c321d6906094bb99783f64017d05af795184d` |
| `artifacts.json` | `f163c0f265d8734d45b5be7c10922a3f66c1846f12c10a9b1821dae59f53116e` |
| `SHA256SUMS` | `6c2a524fd9f3f9b0bf187522854a4fd7f85de6a4052826977f465f8c76a4af21` |

发布后重新下载三项附件，逐一核对本地文件、下载文件和 GitHub 提供的摘要；哈希一致。原生收据保留在本地发布证据中，GitHub CI 产物另受各工作流的保留期限约束。
