# 原进程清单的脱敏诊断

状态：第107轮完整验收完成，补充第108轮 fork rerun 已正式加载。生产者诊断RED1/10、GREEN10/10，扩展12/12；真实SDK退役RED1/3、GREEN3/3，相关44/44、callback/诊断组合40/40；两次 verify/release 各1695/1695、host/11恢复/diff通过，正式DSH PID72976认证HTTP200。

## 原缺口与复现

`boundedOutput()`的native错误、无效JSON/行结构、root缺失与birth不完整最终被折叠为undefined或PID-only evidence。清理仍正确拒绝，但操作者无法知道哪个观察失败。新增回归在实际CIM生产者边界注入权限errno、终止标志、非零退出、启动失败、输出溢出、无效返回及缺失身份；原producer没有返回任何诊断，9项失败，观察者异常控制保持成功。

新增`captureProcessTreeEvidence`可选观察者，每次捕获生成一个冻结的观测：原PID、固定code、单调elapsedMs、4000ms预算，必要时附数字exitCode和白名单errno/signal。原Error.message、命令/参数、环境、stdout及stderr不进入观测；未知字符串字段也丢弃。同步抛错或异步拒绝的观察者均被隔离，不能改变capture结果。

SDK把原退役和fork creation/release的最多两次捕获及owner退役观测保存在独立WeakMap；错误的`cleanupDiagnostics`只读且数组/条目冻结，message仅附固定code和时长。没有改动ProcessTreeEvidence或WorkflowRecord序列化形状。真实callback actor确认持续不可用和retired-owner仍exit1、原树保留、额外模型请求0、永久stop后仍拒绝start；新增诊断不触发transient backoff或model continuation。

```powershell
pnpm exec tsx --test test/process-census-diagnostics.test.ts test/retirement-census.test.ts
```

证据位于checkout外`../.codex-workflow-verification/hundredseventh-20261011/`，包括producer RED/GREEN、SDK RED/GREEN、扩展脱敏与相关回归日志。首次类型检查发现无参数mock的强制转换不满足execFile静态属性，已修正测试类型并保留输出，未放宽产品类型。

## GitHub固定来源

通过agent-reach GitHub/gh读取固定源码与许可证，四份原字节的Git blob SHA1、SHA256和长度核对后存于`github-sources/source-manifest.json`；未执行外部代码或新增依赖。

| 来源 | 固定提交 | 采用机制 |
| --- | --- | --- |
| [Execa result](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/return/result.js#L132-L175)，MIT | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 退出、终止、取消、输出溢出和duration独立记录；本项目仅采用结构化观测，不照搬其命令/stdio日志 |
| [Node child_process](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md)，核心MIT | `f657bb8ed86365ff3fdbe32e27563e778b41486a` | execFile回调的code/signal及timeout/maxBuffer界限；killed不等于进程已退出 |

Context7先resolve Node24，再查询execFile错误/信号契约；检索混入exec/spawn片段，具体execFile行为以固定官方文档和实际producer执行为准。

## 保持的边界

4秒query预算、1MiB buffer、原owner有效时一次补读、PID/birth验证与独立退出证明不变。`query_terminated`不擅自断定超时，elapsed与limit分别显示事实；权限标签仅来自明确EACCES/EPERM，不解析含敏感文本的PowerShell错误。当前诊断覆盖退役捕获；未声称所有lost/fork/native termination路径都有同等明细。完整输入337份、原生文件摘要179份、217份构建产物哈希匹配；416会话、431文件、111 workflow、119 queue及配置/凭据保持。

历史自然查询异常没有原CIM返回，新增诊断不能反推旧根因，也不证明真实provider或Token账单。新失败若落在这一退役路径，能保留脱敏观察供下一次诊断。
