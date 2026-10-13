# 第56轮研究：stderr错误与JSON-RPC能力

## 结论

stderr读取失败是诊断能力丢失，不等于stdin/stdout控制通道失败。在控制流仍正常时，应消费stderr的error，避免Node默认退出；继续原初始化、原线程与活跃模型。如果该进程后来实际退出，再用固定标记说明诊断流曾不可用。旧进程的迟到错误不能改变后继的诊断。

## 固定来源

通过Agent Reach的GitHub/`gh`后端核对main SHA并读取固定source、manifest和许可，保存于仓库旁 `.codex-workflow-verification/fiftysixth-20261007/github-sources/`。不复制实现、不增加依赖。

| 项目 | 固定SHA | 版本 / 许可 | 参考机制和局限 |
| --- | --- | --- | --- |
| microsoft/playwright | `d469960fdfc461e2d5795a3fa48a58a52a91ecaf` | 1.65.0-next / Apache-2.0 | stdout/stderr日志与process lifecycle分开，不证明其stderr错误自动隔离 |
| modelcontextprotocol/typescript-sdk | `b022522089a0c8b632595c6e7b536453945ed5a9` | client2.3.1 / Apache-2.0 | stdin/stdout承载protocol，stderr单独暴露或继承；其pipe代码不能替代本项目error消费 |

[Playwright日志处理](https://github.com/microsoft/playwright/blob/d469960fdfc461e2d5795a3fa48a58a52a91ecaf/packages/utils/processLauncher.ts#L175-L184)独立读取stdout/stderr，并在进程生命周期完成cleanup。本项目参考诊断与进程责任分离，不声称它直接解决了这个Readable错误。

[MCP stderr接口](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L180-L198)单独暴露诊断stream；stdin/stdout的error连接protocol error。选择本项目的stderr诊断策略时，没有把MCP stderr.pipe写成会自动消费源error的证明。

Context7先resolve Node.js，查询 `/nodejs/node`：EventEmitter的error没有监听器会抛出并退出宿主；destroy(error)产生真实error/close。error monitor只能观察，不会代替error listener。这支持隔离SDK worker保留默认fatal行为的反馈方法。

## 本地RED与采用

真实SDK启动原source，读取原birth树；实际原stderr Socket `.destroy(error)`，stdin/stdout仍可用。旧代码stderrErrorListeners=0，SDK worker自然exit1，uncaught-monitor记录该诊断错误；没有全局异常workaround。日志 `stderr-read-red.log`，现场 `%TEMP%/dsh-stderr-read-failure-fjKNqy/states.jsonl`。外层只按捕获原身份清理遗留诊断child。

新增stderr error消费与每child局部boolean，只允许当前未停止child标记自己的退出diagnostic。不会调用failTransport、清owner或提交模型；不转述private error.message。实际exit仍使用原prefix，固定marker在body尾部出现，原树证据规则保持。

四个真实Socket场景为ready、initializing、active、exit-diagnostic。当前RPC和owner保持，真实caller cancel仍中断原model；只有实际exit才出现诊断不可用标记。初版active测试误把signal放入options，按真实签名第三参数修正；没有改期限或生产行为以让测试通过。

另在既有late-pipe actor增独立late-read-error模式：真实旧OS数据在新进程接入后到达，再毁掉仍实际开放的原Socket。current-own/current-silent两种后继均没有旧marker或diagnostic-unavailable标记；原late无fault和drained控制保留，65536字节实际旧pipe证明保持。组合8/8通过，29.12秒，typecheck/diff通过。

完整门禁与正式加载见[第56轮记录](../iterations/2026-10-07-fiftysixth-stderr-diagnostic-error.md)。这是本地真实Socket故障，不声称provider自然stderr故障、Token费用、浏览器或Linux pidfd实机验收。
