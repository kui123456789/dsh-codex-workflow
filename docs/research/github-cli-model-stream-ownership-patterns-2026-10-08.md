# 第64轮研究：CLI输入与模型输出流错误责任

状态：第64轮已验收加载。隔离回归、真实stdout探针、最终相关71/71及typecheck通过；完整verify/release各1341/1341、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID141052，会话身份及完整workflow记录保持。

## 实际故障与不同流的责任

第63轮只修复了诊断stderr错误。真实stdout Readable.destroy(Error)仍触发Unhandled error event，探针宿主exit1；stdin活动写入同样缺少自己的error监听器。已有ChildProcess.error不代替stdio流自己的监听器。

诊断丢失时仍可使用完整健康stdout；prompt输入或模型输出失败时，原结果不能被当作成功。首次10项隔离测试8失败2通过，其中首次stdin在写完后注入没有命中活动写入。改为真实后端暂停读取、原4MiB写入等待完成，stdin和取消后stdin两项均RED。旧失败记录中的未捕获错误已复制保留，测试没有安装会吞掉异常的uncaughtException处理器。

## 固定源码研究

通过agent-reach的GitHub/gh后端读取Execa固定源码；Context7先resolve Node.js，再核对v24的流错误、exit/close与exitCode/signalCode。8份固定源码含许可、测试的原字节与Git blob核对，路径和SHA256保存于本轮 `github-sources/fixed-source-index.json`。

| 来源 / 固定提交 | 许可 | 采用机制与限制 |
| --- | --- | --- |
| sindresorhus/execa `63ddae6aeb6934da06fdb3754647791e58cd87c3` | MIT | waitForStream逐流观察，waitForSubprocessResult在失败后仍等待原exit和流收尾；借鉴每原流处理与失败结算责任，不迁移其通用EPIPE忽略策略、transform或运行框架 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | 无监听的error会退出；exit时stdio可能仍打开，close在进程结束及stdio关闭之后；因此信号发送不等于run可以丢弃原child |

[Execa每流观察](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-stream.js)、[失败结算](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js)、[Node子进程事件](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md)。

## 本项目采用

只在CLI原run增加stdin/stdout持久error消费者，活动错误加入原abort/kill/close流程。pendingError保留首次原因，先前取消不被后续流错误覆盖；同步stdin.end异常走同一入口，不在Promise隐式拒绝后遗留进程。出现pendingError后，不再解析新stdout data或最终flush的线程身份，已接纳的identity binding仍等待结算。

已结算的旧流错误仍被消费，不杀旧child、不影响新独立进程。原错误对象由CLI回合直接抛回，CLI的transient结果重试循环不会把该管道错误转换为第二次运行；上层workflow的恢复分类继续沿用其原策略。本轮没有统一更改所有上层重试语义或实现整树退出证明。

失败后已观察到的可读模型结果也不能变成正常verdict。保留原kill escalation、timeout和stdout字节上限，stderr诊断隔离保持；没有新增依赖。真实SIGTERM退出证明仅针对这个child，不等于所有后代已结束。只覆盖显式流error和同步写入异常，不证明静默管道堵塞、OS自然EPIPE或provider自然故障。

## Evidence → Finding → Path

- Evidence：真实 `cli-output-failure-red.log` exit1，stdin活动写入两项RED，原10份actor uncaught记录；Finding：输入/输出流缺少独立错误归属，同步写异常可能绕开原清理；Path：原abort/close结算与首次原因保留。
- GREEN：11项初始隔离场景通过；补充第12项身份绑定控制，原进程关闭时child仍被持有、caller未结算，原绑定保存后才返回同一个错误。真实stdout探针starts1、sameCause true、原backend SIGTERM退出。
- 原cancel先于错误时精确返回原取消对象；旧stdin/stdout错误在实际后继运行期间触发，两个原进程均exit0且killRequests0。同步stdin.end异常也等原进程关闭，未产生CLI自动重试。

从仓库运行 `pnpm exec tsx --test test/cli-model-stream-failure.test.ts` 可重放。完整验收与正式加载见[第64轮记录](../iterations/2026-10-08-sixtyfourth-cli-model-stream-ownership.md)。
