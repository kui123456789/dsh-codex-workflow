# 第49轮研究：初始化拒绝与原进程归属

## 结论及边界

初始化失败仍拥有其原process。关闭launcher和返回原始握手错误不能丢掉backend清理；物理清理失败保持屏障。初始化已拒绝后到来的明确新请求应等待原清理，再进入新初始化，而不能重新加入旧失败执行。本机制允许新独立启动，不恢复丢失的ephemeral工作流。

## 固定来源

使用Agent Reach的GitHub/`gh`后端只读获取。文件保存于仓库旁`.codex-workflow-verification/fortyninth-20261007/github-sources/`；未复制实现、运行外部测试或安装依赖。

| 来源 | 固定提交 | manifest / 许可 | 参考机制 |
| --- | --- | --- | --- |
| microsoft/playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | 1.65.0-next，Apache-2.0 | graceful失败后强制终止，等cleanup完成再结算 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0，MIT | 保存原error，同时等待退出和关联stream结果 |

[Playwright gracefullyClose](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L210-L225)保留监听并在失败后kill，再await waitForCleanup。其PID/group策略没有本项目的原实例birth证明，不直接照搬。

[Execa失败结算](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L115-L128)在catch中保留error，继续等待exit及stream结果。本项目借鉴主错误与清理责任并存，不把退出/stream结果混作所有后代已退出的证明。

Context7先resolve Node.js，再查询`/nodejs/node`：shell后代可独立存活；发送kill不是退出；spawn失败可能error后close、没有exit。这支持区分未取得OS PID的失败与已经启动的原进程。实际Windows tree证明仍由本地native fixture及现有handle/birth helper完成。

## 本地证据及采用

`pnpm exec tsx --test test/initialization-process-exit.test.ts`首先RED，真实SDK/stdIO及launcher/backend：非法initialize响应的原错误保留，但原捕获树仍live，process1/model0/thread0。日志保存在持久目录`fortyninth-20261007/initialization-tree-red.log`，原fixture证据`%TEMP%/dsh-initialization-stop-tree-tbE4A9`。

复用已实现的原树retirement：在丢掉child之前采集并清理原实例，清理错误不覆盖握手主错误。已丢失launcher且没有tree证据时保留未知屏障，不凭PID补造完整树。没有取得OS PID的真正spawn失败不制造虚假清理资源。

新增并发检查又RED：清理过程中发起的明确新请求仍加入旧失败initializer。标记rejected并复用已有“先等待旧尝试结束”入口，确保新的启动在旧清理完成后创建一次。原观察者仍得到原错误，取消保持观察者边界。

最终native/SDK/初始化/交接/stdio/fork组合96/96通过，91.45秒；五个原生场景分别覆盖拒绝、取消、helper拒绝、launcher丢失及新请求竞争。Windows实际运行，Linux pidfd未在WSL执行；未测试真实provider故障、Token费用或浏览器操作。完整门禁及正式加载见[本轮记录](../iterations/2026-10-07-fortyninth-rejected-initialization-retirement.md)。
