# 原进程树清理宽限期使用单调计时

状态：第106轮完整验收并正式加载。cleanup回归RED5/7、GREEN7/7，修正相关31/31、callback/清单28/28，verify/release各1683/1683、host/11恢复/diff通过；DSH PID46240认证HTTP200。首次1679/1680失败与补充清单观察修正另存证据。

## 缺陷与可复现证据

`stopCapturedProcessTree()` 在发送原进程树终止信号后，用`Date.now()`构造和检查确认轮询deadline。预算50ms且实际已过50ms，墙钟从1000回拨到500时，原实现仍等待。预算100ms只过50ms，墙钟向前到2000时，原实现直接返回未确认。

同一模块边界使用原生Date/performance方法mock和50ms timer tick，在本地worker内控制两个时钟，不修改操作系统时间；原evidence、信号目标及独立exit hook始终保持。原实现5/7，两个clock用例失败；候选把两处读数改为`performance.now()`后7/7。原5项身份拒绝、信号/退出证明和真实PID复用控制继续通过。

```powershell
pnpm exec tsx --test test/process-tree-cleanup.test.ts
```

checkout外第106轮的`cleanup-clock-red.log`、`cleanup-clock-green.log`保留原输出。其调用路径为原identity校验→一次原目标termination→按单调deadline轮询原exit证据→真实exit返回true或grace耗尽返回false；回拨不补充预算，前跳不提前取消观察。

## GitHub固定来源

使用agent-reach GitHub/gh后端核对并归档源码与许可证。四份资料的Git blob SHA1、SHA256与字节长度保存在`../.codex-workflow-verification/hundredsixth-20261011/github-sources/source-manifest.json`；未执行下载代码、未新增依赖。

| 来源 | 固定提交 | 采用机制 |
| --- | --- | --- |
| [p-retry剩余预算](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js#L71-L81)，MIT | `1472907affe8d6107aba5884abc36d6361b3042e` | 以performance elapsed计算本进程等待预算，异步回调后重新检查；不引入重试器或重复发送信号 |
| [Node performance.now](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/perf_hooks.md#L330-L344)，核心MIT | `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 高精度毫秒值相对本进程启动；从v19起保留performance receiver，使用`performance.now()`直接调用 |

Context7先resolve Node.js，再查询Node24高精度计时；检索片段覆盖hrtime和performance相关接口，未精确返回now定义，具体契约以已核对的固定官方文档和本地执行为准。

## 保持的边界

只改变termination之后的退出确认轮询宽限期，不改变原PID/birth校验、缺失证据拒绝、一次信号、退出优先与50ms轮询周期。native查询、termination各自仍有独立超时；本修复不保证整个stop只耗费waitMs。

持久lease、queue deadline、UI时间和系统CreationDate仍使用墙钟；这不改变线程恢复策略或允许替换未确认的原进程。第104轮自然CIM/清理异常的触发原因仍未确认，这两个受控clock回归不用于认定其根因。
