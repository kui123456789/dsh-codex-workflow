# 正式 DSH 实机验证 — 2026-09-13

后续结果：用户授权更新系统 CLI 后，已升级至 0.154.0，原模型版本阻塞消除，
桥接主流程真实审查及回传通过。见 [CLI 更新与回传验收](cli-update-2026-09-13.md)。
下文保留首次测试时的历史结果。

结论：**插件加载、规划回传和 DSH 实现通过；审查被系统 Codex CLI 版本阻塞，全链路尚未通过。**

## 运行环境

- 用户启动的正式 `web` profile，PID `28116`，监听 `127.0.0.1:3080`。
- DSH `0.1.5-rc.1`，链接插件构建 `1.0.13`。
- 正式宿主 `pluginInventory/list` 返回：`include:dsh-codex-workflow`，`enabled: true`，`fiberPhase: active`。
- 未认证首页返回 401；使用现有本机认证材料在内存中认证后返回 200 HTML。没有输出或保存凭证值，没有修改凭证文件。
- 系统 PATH 中 `codex --version`：`0.150.1`。
- 桌面应用附带的另一份 CLI：`0.154.0-alpha.6.2`；本轮没有替换系统 CLI，也没有改变插件的命令配置。

## 真实任务

- DSH 会话：`session-12bd3089-daf0-4fe0-a8b9-df411a618894`
- 会话标题：`Codex 工作流 1.0.13 实机兼容测试`
- 工作流：`d4d18443-b2aa-4981-9699-6252fc38dda5`
- Planner / Reviewer 共用任务：`01a09a91-36c9-7e22-82eb-e9bc3d67d8d2`
- 隔离工作目录：`.live-review-acceptance/live-smoke-2026-09-13T11-39-26-822Z`

任务要求新增 `sum.mjs` 和 `sum.test.mjs`，用 Node 内置测试验证三个加法案例。
由正式 DSH 模型调用插件工具完成，不是离线 Mock 或单独实例化 WorkflowManager。

| 检查 | 实测结果 |
| --- | --- |
| 正式宿主加载 | active |
| CLI 在线会话注册 | 精确列出测试会话与 cwd |
| `codex_workflow_start` | 成功调用，Planner 实际使用 `gpt-5.6-sol` |
| 可读计划回传 | 成功，工作流进入 executing |
| DSH 实现 | 写出两个指定文件，原 README 未修改 |
| `node --test sum.test.mjs` | DSH 执行 3/3 通过；操作员独立复跑同样 3/3 通过 |
| `codex_workflow_review` | 在原 Planner 任务上启动只读 CLI 审查，但请求失败 |
| 审查轮次 | 0，没有把基础设施失败算作审查通过 |
| 取消与收尾 | `codex_workflow_cancel` 成功，工作流 cancelled，DSH 会话 running=false、出现 turn/end |

## 审查阻塞证据

实际后台命令走的是系统 CLI。它以默认 `gpt-6-astra` 恢复原任务，并记录了模型元数据缺失、请求重连以及服务端拒绝：

```text
The 'gpt-6-astra' model requires a newer version of Codex.
Please upgrade to the latest app or CLI and try again.
```

这条拒绝来自真实请求，不能由插件加载成功或离线测试通过抵消。
DSH 曾尝试在第二次 review 调用里传 `reviewerModel`，但该工具没有这个覆盖参数，
因此没有改变后台模型。操作员随后通过正式会话取消接口停止重试，并让 DSH 调用
工作流取消工具保留诊断记录。未修改全局模型、账号、CLI 安装或正式 profile。

下一步应让插件使用支持当前默认模型的较新 Codex CLI，再重新跑完整审查。
本机已有较新的桌面附带 CLI，但仅核对了其版本，尚未验证以它替换后台命令后的结果。

测试目录中的 `.mnemon/` 是 DSH 记忆插件生成的运行元数据，Planner 已将其识别为既有内容。
文件、测试会话与工作流历史均保留，便于复查；没有重启正式 DSH。
