# 第51轮研究：意外 launcher 退出后的原后端归属

## 结论与边界

普通进程退出回调会清掉当前 child，但它可能只是 launcher。成功初始化应先记录原进程身份；意外退出后仍持有清理责任。初始化快照可能缺少后来创建的后代，因此清理时只从仍匹配原 birth 的存活实例扩展当前后代，不能扫描已复用的 PID 或补造缺失的原始身份。

这只支持原资源清理，以及清理完成后的明确独立启动。丢失的 ephemeral Planner/Reviewer 仍不能恢复，也不会被新的 metadata 进程替换。

## 固定来源

本轮通过 Agent Reach 的 GitHub/`gh` 后端再次核对 main SHA，保存固定源文件、manifest和许可到仓库旁 `.codex-workflow-verification/fiftyfirst-20261007/github-sources/`。没有复制实现或增加依赖。

| 项目 | 固定 SHA | 版本 / 许可 | 参考机制 |
| --- | --- | --- | --- |
| microsoft/playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | 1.65.0-next / Apache-2.0 | 保留 process handlers 到 close/cleanup，重复关闭等待同一清理结果 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0 / MIT | 原错误与 exit/stdio 结果并存，等待关联操作结算 |

[Playwright](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L187-L225)把关闭和 cleanup 责任联系起来；它的 group/PID 策略缺少本项目要求的 birth/handle 证明，不直接采用。

[Execa](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L115-L128)在主错误后继续等待 exit/stdio 和原操作；这些结果不能独自证明所有 backend 已退出。

Context7 的 `/nodejs/node` 查询确认 `exit` 不等全部 stdio 关闭，`killed` 只表示发送信号，launcher/shell 后代可能继续存活。实际树扩展和终止仍由本项目的出生身份校验与原生测试验证。

## 本地反馈与采用

普通 launcher 先退出回归首先 RED：`stop()` 成功返回，但捕获 backend 仍 live，process1/fork0/model0。精确失败日志为持久目录 `lost-launcher-exit-red.log`，现场 `%TEMP%/dsh-permanent-stop-tree-VfeZQv/stop-result.json`。测试最后只用独有 marker 清理自身进程。

新增初始化身份记录、丢失进程清理表和共享清理。后继启动先清理原实例，永久 stop 重试保持 latch。扩展树只接纳匹配 birth 的原 backend 当前后代，合并原身份；未知、部分或冲突的身份保留未确认状态。现有正常 stop 继续采集退休阶段证据，避免用旧初始化快照替代它。

首轮相关控制出现6个 idle 回归：身份采集期间 idle 判断未排除初始化，提前关闭原进程。增加初始化未完成的 idle 屏障后，原9个 idle/clarification/pin场景全部 GREEN，场景时限和断言未放宽。

Windows 原生场景覆盖 launcher 先退出、初始化后创建的真实后代、明确 metadata 后继、拒绝终止后重试、启动身份采集缺失。数据边界测试覆盖 PID重用、未知birth、部分采集、跨平台身份和冲突。完整结果和正式加载见[第51轮记录](../iterations/2026-10-07-fiftyfirst-unexpected-launcher-exit.md)。

证据证明捕获原实例及本轮实际晚建后代的清理，不宣称未来任意后台进程都会被穷尽；没有真实 provider/Token费用/浏览器或Linux pidfd实机验收。
