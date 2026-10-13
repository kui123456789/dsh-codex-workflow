# 第107轮：原清单失败的脱敏诊断

状态：完整验收与正式加载完成。verify/release各1695/1695、179份原生文件摘要；host、11个恢复场景、diff、offline doctor和pack audit通过。正式DSH从PID46240切换到PID64836，认证HTTP200。

## 改动

进程清单捕获现在可向内部诊断观察者发送冻结的 `ProcessTreeCaptureObservation`：原PID、固定结果码、单调耗时、4000ms查询上限，以及可选的数值退出码或白名单错误字段。原始命令、参数、环境、stdout、stderr和错误文本不会进入诊断。观察者同步抛错或异步拒绝会被隔离。

原 App Server 退役证据保留同一 live/owned ChildProcess 的至多一次补读；持续失败或 owner 已退役仍保留 cleanup barrier。清理错误附加冻结 `cleanupDiagnostics`，只用于现场诊断，不改变原线程、模型重试或替代进程判定。

## 来源与验证

- Execa 固定源码展示 `timedOut`、`isTerminated`、`isMaxBuffer`、`exitCode`、`signal` 等分离结果字段；Node `execFile` 文档定义 error code/signal、timeout 和 maxBuffer。固定提交、许可证、blob/SHA256见研究记录。
- producer 诊断 RED1/10→GREEN10/10，非法根和观察者异常扩展至12/12。
- 原退役 census RED1/3→GREEN3/3；相关真实进程/身份/清理回归44/44，callback/诊断组合40/40。
- 完整门禁 `isolated-2OlXo9` 原PID56676/`win32:134361634216697300` 实际exit0；verify/release各1695/1695、179份摘要，337份输入，217构建产物哈希一致。

## 正式加载

只加载 `lib/app-server.d.ts/js/js.map` 与 `lib/infrastructure/process-transport.d.ts/js/js.map` 六份产物；原正式构建及回滚副本保留。416会话、431会话文件、111 workflow、119 queue、7份配置/凭据、指定旧会话、原parent、历史corrupt child及新增未播种空白会话保持。新PID64836空闲、无running/waiting workflow或lease。

自然清单异常的原始CIM返回仍未保存，不能声称已确定第106轮旧失败根因；本轮只改善后续诊断证据。未commit、push、publish，持续优化目标保持active。
