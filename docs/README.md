# 文档导航

当前产品是独立的 `codex-workflow` Skill。安装和运行不依赖 DSH；历史插件资料单独列在下方。

## 当前使用与开发

| 文档 | 何时阅读 |
| --- | --- |
| [项目首页](../README.md) | 下载、安装、运行要求和使用方式 |
| [SKILL.md](../SKILL.md) | 宿主 Agent 执行规划、实施、审查闭环 |
| [CLI 协议](../references/cli.md) | 直接调用命令、准备 JSON 输入、解释状态 |
| [恢复与证据](../references/recovery.md) | 中断、取消、证据变化或原线程恢复 |
| [开发约定](../AGENTS.md) | 修改源码、测试和打包 |
| [发布检查清单](release-checklist.md) | 运行发布门禁、保留收据、交付验证过的分发包 |
| [v2.0.0 验证记录](verification-2.0.0.md) | 查看该版本的固定提交、CI、附件校验及真实模型验证边界 |
| [版本变更](../CHANGELOG.md) | 当前未发布改动和历次发行记录 |

`SKILL.md` 和 `references/` 随 Skill 分发。仓库开发文档和下面的历史资料不进入 Skill ZIP。

## DSH 插件历史资料

以下资料记录 `dsh-codex-workflow` 1.x 插件。正文中的“当前实现”“正式加载”、源码路径、命令和测试数字均属于记录时的版本。查阅旧代码可使用 [v1.1.15 源码快照](https://github.com/kui123456789/dsh-codex-workflow/tree/v1.1.15)。

| 主题 | 历史记录 |
| --- | --- |
| DSH 0.1.5 兼容与实机验证 | [兼容记录](compatibility-2026-09-13.md)、[实机验证](live-validation-2026-09-13.md)、[CLI 更新](cli-update-2026-09-13.md) |
| 宿主升级 | [DSH 0.1.7 适配](host-compat-2026-09-25.md) |
| 单独审查与会话恢复 | [review_only 修复](review-only-fix-2026-09-14.md)、[原会话继续验收](dsh-same-session-recovery.md) |
| Reviewer 线程问题 | [写者锁事故](reviewer-thread-lock-2026-09-24.md)、[桌面端可见性](reviewer-thread-visibility-2026-09-24.md) |
| 结构调整 | [模块化阶段记录](modularization-phases-2026-09-25.md) |
| 外部机制研究与历轮实施 | [研究归档导航](research/README.md)、[迭代归档说明](iterations/README.md) |

这些记录保留原有结论，不构成 2.x 的安装说明、Agent 指令或真实模型验收证明。
