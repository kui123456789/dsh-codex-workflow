# 第50轮研究：普通永久停止的原进程责任

## 结论

没有 fork 的 App Server 同样可能由 launcher/backend 组成。launcher 退出不能证明 backend 退出；永久停止必须持有原进程证据直到独立确认退出。初始化、空闲退出和永久停止可能竞争同一个 child，应共用退休阶段的原树采集和关闭标记。模型阶段的旧快照不能替代退休时的采集，因为它可能缺少后续创建的进程。

## 固定来源

通过 Agent Reach 的 GitHub/`gh` 后端只读获取，源文件、manifest 和许可保存于仓库旁 `.codex-workflow-verification/fiftieth-20261007/github-sources/`。没有复制实现或增加依赖。

| 项目 | 固定提交 | 版本 / 许可 | 借鉴机制 |
| --- | --- | --- | --- |
| microsoft/playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | 1.65.0-next / Apache-2.0 | 退出后完成 cleanup，gracefullyClose 等待同一清理结果 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0 / MIT | 保存原错误，仍等待退出、stdio 和原关联操作结算 |

[Playwright 的关闭逻辑](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L187-L225)把退出和 cleanup 结果连接起来。它的 PID/group 终止策略没有本项目的 birth/handle 保护，因此只参考生命周期责任，不照搬终止命令。

[Execa 的失败结算](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L115-L128)保存主错误并继续等待关联资源。本项目的进程树证明比 stdio/launcher 结算更严格，不能把这些结果视为后代全已退出。

本轮 Context7 查询 `/nodejs/node` 的 child_process 文档确认：`kill()` 发送信号，`killed` 不表示已退出；shell 子进程可在 shell 被 kill 后存活。文档用于校验 API 边界，实际 Windows 行为由原生回归验证。

## 本地采用和反馈

`pnpm exec tsx --test test/permanent-stop-process-exit.test.ts` 首先 RED：真实 SDK/stdIO、launcher 和独立 backend，在普通 ephemeral source 建立后调用 stop；没有 fork/model，stop 返回时捕获原树仍存活。原日志为持久目录 `permanent-stop-tree-red.log`，现场 `%TEMP%/dsh-permanent-stop-tree-6QLl2y/stop-result.json`。

修复在丢掉 child 前采集普通原树，加入既有停止清理屏障。退休专用 WeakMap 共用原证据和 close 标记；停止期间的初始化失败加入同一清理，不重新采集已失去的 launcher。清理失败保持 stopped 状态，只接受同一原实例清理重试。

五个原生场景已经 GREEN：普通停止、拒绝终止后重试、初始化竞争、空闲竞争、缺失 census。断言只有一次进程启动、一次退休采集、一次 backend EOF、零 fork/model。未知 census 明确保持失败，fixture 只通过独有 marker 清理自己的 backend，不伪造 SDK 清理成功。

完整门禁和正式加载记录见[第50轮记录](../iterations/2026-10-07-fiftieth-permanent-stop-ownership.md)。当前证据覆盖 Windows 原生拓扑和合成协议；不证明真实 provider 故障、Token 计费或浏览器交互，Linux pidfd 未在 WSL 实测。
