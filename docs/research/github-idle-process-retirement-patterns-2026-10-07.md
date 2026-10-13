# 第48轮研究：idle退出证明与外部交接

## 结论

外部交接必须等待捕获的原进程实例退出。订阅ACK、launcher退出、kill成功和stdio关闭分别是不同的事实。idle清理失败仍保留原树；后续明确请求只能先清理这组实例，证明完成后才允许新进程。

## 固定来源

Agent Reach的GitHub/`gh`后端只读获取；文件保存于`%TEMP%/dsh-fortyeighth-github-ed7eb4d6-9a07-4989-810c-8cbdd13d8b02`，未复制实现、运行外部测试或安装依赖。

| 来源 | 固定提交 | manifest / 许可 | 参考机制 |
| --- | --- | --- | --- |
| microsoft/playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | 1.65.0-next，Apache-2.0 | graceful/forceful分离，退出等待及后代stdio边界 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0，MIT | 等待exit、stdio、IPC等关联结果，不仅发送信号 |

[Playwright processLauncher](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L229-L269)区分强制终止与等待；[其execFile封装](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L294-L304)说明直接child被杀后grandchildren仍可保持stdio。它使用自身进程组或taskkill树；本项目继续使用已打开Windows handle及birth校验、Linux pidfd，未照搬裸PID/group策略。

[Execa wait-subprocess](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L82-L123)合并等待exit及相关stream结果。这个实现本身没有本项目的原实例birth证明，不能据此认定整个后代树已经结束。

Context7先resolve Node.js，再查询`/nodejs/node`。文档明确killed表示成功发送信号，exit/close时序不同，shell子进程及Windows detached进程可在父进程退出后存活。资料用于区分事件语义，真实Windows结果仍由本地原生fixture验证。

## 本地反馈及采用

命令`pnpm exec tsx --test test/external-handoff-process-exit.test.ts`首先RED。证据`%TEMP%/dsh-external-handoff-tree-GjXHiC`：launcher101340、signal SIGTERM、捕获实例3、unsubscribe1/model0，handoff已返回而treeExited=false。fixture仅写自身独有exit marker清理原backend并证明退出；不把模拟backend称作真实Codex文件writer锁。

idle退出保存原process/evidence，关闭launcher后调用现有安全tree helper，并独立证明原实例退出。失败保留清理状态，start不得跳过；恢复清理后才启动明确请求的后继。定时idle失败保持可查询的内部拒绝，不生成未处理promise rejection。永久stop接回同一清理，失败后只重试原树且保持停止标记。

首次交接观察者取消的新增case也先RED：初始调用没有在idle等待阶段观察signal。改为复用已有caller-only等待器，相同场景GREEN；取消一个等待者不取消共同清理。

最终相关91/91通过，82.92秒，含五项真实launcher/backend场景及SDK/初始化/stdio控制。Windows native执行；Linux pidfd未在WSL执行。未进行实际provider、Token费用或真实CLI文件锁并发验收。完整门禁及正式加载见[本轮记录](../iterations/2026-10-07-fortyeighth-idle-process-retirement.md)。
