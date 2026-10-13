# 第63轮研究：CLI诊断流错误与原进程归属

状态：第63轮已验收加载。生产修复、9项隔离场景、59/59相关控制与真实CLI探针通过；首轮1328/1329的既有Bridge取消观察顺序失败证据保留，只修正事件屏障后verify/release各1329/1329、0异步警告。包审计、host加载/恢复与diff通过，正式DSH为PID133572，会话身份与workflow完整记录保持。

## 可复现的宿主崩溃

原CLI dispatcher只注册ChildProcess.error，没有消费stderr Readable自身的error。真实本地Node backend正常准备模型输出时，在父进程受控destroy(stderr, Error)后，探针进程因Unhandled error event直接exit1，而非返回可诊断结果。单独的ChildProcess监听器不能处理另一个EventEmitter的错误。

7项初始隔离控制中，正常场景1通过、6个错误场景失败；6份actor记录均有uncaughtExceptionMonitor事件。该monitor仅记录，不消费异常。附加原非法线程标记及后继隔离控制后，最终9项场景均通过。底层故障是受控Readable错误，不冒称正式provider或OS自然管道故障。

## 固定源码与采用限制

通过agent-reach的GitHub/gh后端读取固定Execa实现；Context7先resolve Node.js，查询v24的EventEmitter和ChildProcess事件契约。6份原字节及许可均与Git blob核对，SHA256/路径保存于本轮 `github-sources/fixed-source-index.json`。

| 项目 / 固定提交 | 许可 | 核对机制与限制 |
| --- | --- | --- |
| sindresorhus/execa `63ddae6aeb6934da06fdb3754647791e58cd87c3` | MIT | waitForStream用finished分别观察每个流，按方向处理EPIPE与提前close。采用每原流独立观察错误的原则；未迁移其通用流错误传播策略，本项目stderr仅提供诊断 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | 未注册error监听器的EventEmitter会抛错并退出；stderr是独立Readable，ChildProcess.error描述spawn/kill/IPC失败，不等于stdio error |

[Execa每流观察](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-stream.js)、[Node error契约](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/events.md)、[stdio与进程事件](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md)。本项目App Server此前已有诊断流隔离；本轮在实际不同的CLI入口补齐这项责任，没有替换运行框架或增加依赖。

## 本项目行为

在每原child的stderr持续注册error监听器，正常结果不因诊断流丢失而被拒绝。尚未结算的原run记录stderrUnavailable；结算后的旧错误仍被消费，但不能修改结果或后继运行。错误后的stderr data不再计入已失效诊断；已解码和缓存的原字节仍按原尾部预算收尾。

run内部结果独立携带诊断可用性；所有失败出口将固定说明追加在compactDiagnostic之后。分类仍只读取原stdout/stderr字节，错误对象的“permission denied/server_overloaded”等文本不会诱发终止或重试。非法线程仍报原CodexInvalidThreadError，成功模型结果照常完成；既有取消/stop和stdout超限仍优先保持自己的错误。

固定说明不计入source retention预算，也不占用原诊断字节；本轮没有新增模型请求、线程或子会话来恢复stderr。它不修复坏管道、不恢复丢失诊断，不保证底层向坏stderr写入的backend一定成功，也不处理stdin/stdout的其他错误路径。

## Evidence → Finding → Path

- Evidence：真实 `cli-stderr-failure-red.log` exit1和6个actor uncaught记录；Finding：未消费诊断Readable错误使宿主退出；Path：为原stderr独立消费错误，诊断可用性与模型结果分离。
- GREEN：9/9隔离场景、完整6文件59/59（21.82秒）、typecheck/diff通过。真实probe starts1、stderr错误1、actual exit0、原pass结果返回。
- 公有review的503诊断仍为可重试失败，permission denied仍为终止错误；诊断读错误的混合词未进入分类。成功旧流的迟到错误在新独立运行实际失败期间触发，后继只报告自己的权限诊断，没有旧不可用标记。
- 从仓库运行 `pnpm exec tsx --test test/cli-stderr-failure.test.ts` 可重放。完整门禁及正式加载见[第63轮记录](../iterations/2026-10-08-sixtythird-cli-stderr-error-ownership.md)。
