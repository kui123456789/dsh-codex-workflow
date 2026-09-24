# 系统 Codex CLI 更新与回传验收 — 2026-09-13

后续修复：下文记录的 `review_only` 空任务问题已在 1.0.14 修复，见
[2026-09-14 修复与验证记录](review-only-fix-2026-09-14.md)。本页保留更新当天的实测历史。

系统 npm 安装的 Codex CLI 已从 **0.150.1 更新为 0.154.0**。
使用当前默认模型 `gpt-6-astra` 的真实后台审查已通过，并成功回传到正式 DSH 会话。

## 更新与保留

- 官方 npm 包：`npm install -g @openai/codex@0.154.0`，退出码 0。
- 系统入口：`C:\Users\Z1803\AppData\Roaming\npm\codex.ps1`。
- 登录状态：`Logged in using ChatGPT`。
- 更新前后及复测结束时，`~/.codex/config.toml` 和 `~/.codex/auth.json` 的 SHA-256 均一致。
- 原安装和三个命令入口备份：
  `C:\Users\Z1803\.dsh\backups\codex-cli-update-20260913-211509`。
- 新 Windows CLI 二进制 SHA-256：
  `BE96B992178B1E467C225800DA0D65F2C86D5EBA1EF0B14632F65DB381CBDFDE`。
- 未切换全局模型、未修改账号，也未重启正式 DSH。

安装方式参考 [OpenAI Codex 官方仓库](https://github.com/openai/codex/blob/main/README.md)。

## 已完成验证

- `node scripts/doctor.mjs --json`：14 项检查全部通过，0 失败、0 跳过；包括登录、真实 SQLite 完整性、CLI resume/stdin 契约及 App Server 连通性。
- 正式 DSH 的工具执行记录实际返回 `codex-cli 0.154.0`，不是仅在外部终端确认版本。
- `sum.mjs` 与 `sum.test.mjs` 的 3 项 Node 测试再次通过，审查模型也独立复跑通过。
- 主流程：CLI 分发计划 → 原 DSH 会话验证 → `codex_workflow_submit` → CLI 恢复原 Codex 任务审查 → 内部转换与校验 → 结论落库和回传 → DSH 结束。

最终工作流：`03dcdce2-ce08-4634-afc3-0bed1e96eec8`。

| 字段 | 实际结果 |
| --- | --- |
| phase | passed |
| latestReview.verdict | pass |
| reviewCycles | 1 |
| submissionState | delivered |
| callbackState | idle |
| DSH 会话 | session-12bd3089-daf0-4fe0-a8b9-df411a618894 |
| 来源和审查 Codex 任务 | 01a09a91-36c9-7e22-82eb-e9bc3d67d8d2（相同） |
| 会话收尾 | running=false，持久化记录含 turn/end |
| 正式插件 | enabled=true、fiberPhase=active |

只记录了必要的状态、标识与哈希，没有导出凭证值。

## 测试中发现的独立问题

1. **`review_only` 的空任务交接仍待修复。** 工作流
   `9071b883-2f62-4291-a240-e6e4c0c58331` 新建无对话历史的审查任务后，
   报 `codex thread 01a09ae9-cc85-7920-a7e6-02a6dc5f2ecd does not exist`。
   已取消并保留证据。本轮没有修改这条插件代码路径；主流程通过不代表这个模式已修复。
2. 首次桥接复测的模型结论是 pass，但测试仓库未忽略 `.mnemon/`，运行时元数据变化触发指纹不一致，插件正确拒绝应用旧结论。
   操作员只在隔离测试仓库的 `.git/info/exclude` 加入 `/.mnemon/`，保留原文件备份，
   取消旧测试后重新提交。最后一轮指纹保持稳定并正常 passed，没有绕过校验或人工写入 verdict。

之前的阻塞记录见 [首次实机验证](live-validation-2026-09-13.md)。
