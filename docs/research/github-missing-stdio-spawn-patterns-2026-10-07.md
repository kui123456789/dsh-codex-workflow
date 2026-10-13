# 第55轮研究：stdio创建前的spawn失败

## 结论

Node的spawn调用可能返回ChildProcess，但没有stdio和PID。它会在后续tick发送原error/close，不发送exit。若立即createInterface或访问stdout.on，先发生的TypeError会遮盖真正的资源错误，且原child可能仍无error listener。需要先注册原child生命周期，等待失败receipt，再拒绝启动；不能创建fake input来假装连接已就绪。

## 固定来源

通过Agent Reach的GitHub/`gh`后端获取固定source、manifest和许可，保存仓库旁 `.codex-workflow-verification/fiftyfifth-20261007/github-sources/`。不复制实现、不增加依赖，不对正式服务耗尽句柄。

| 来源 | 固定SHA | 版本 / 许可 | 参考机制 |
| --- | --- | --- | --- |
| nodejs/node v24.14.0 | `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 与本机Node一致 / MIT及文件内许可 | EMFILE/ENFILE在stdio赋值前返回，后续error/close |
| IndigoUnited/node-cross-spawn | `77cd97f3ca7b62c904a63a698fc4a79bf41977d0` | 7.0.6 / MIT | 直接返回native child，并仅增强特定ENOENT事件 |
| modelcontextprotocol/typescript-sdk | `b022522089a0c8b632595c6e7b536453945ed5a9` | client2.3.1 / Apache-2.0 | 先注册process error/spawn/close，stdio使用可选访问 |

Context7先resolve Node.js，再查询 `/nodejs/node`，返回明确的缺失stdio契约和官方EMFILE测试。固定[本机版本内部实现](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js#L397-L426)确认early return早于this.pid和stdio setup；[官方测试](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/test/sequential/test-child-process-emfile.js)检查undefined stdio、原EMFILE及无exit。本项目未运行会耗尽资源的上游测试。

[cross-spawn](https://github.com/IndigoUnited/node-cross-spawn/blob/77cd97f3ca7b62c904a63a698fc4a79bf41977d0/index.js#L7-L22)不替调用者创建stdio或等待error；[MCP stdio](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L148-L177)把生命周期receipt与stdio可选访问分开。借鉴监听顺序和缺失stdio建模，保留本项目同步child ownership及原树退休规则。

## 实际回放及采用

隔离SDK worker通过native spawn-adapter端口返回真实ChildProcess对象，受控回放无stdio/PID和异步EMFILE/close；不创建OS进程、不修改SDK方法。旧代码先报 `input.on is not a function`，原error receipt监听数0，uncaught-monitor观察到EMFILE，worker自然exit1。没有uncaughtException handler或强制success。RED日志 `missing-stdio-red.log`，现场 `%TEMP%/dsh-missing-stdio-spawn-YmROpx/states.jsonl`。

transport只在stdout存在时创建readline；SDK同步拥有child，注册可用stream及原error/exit监听后，在缺少必要stdio时等待原failure。receipt用原RPC预算，支持取消与close/成功spawn-but-incomplete contract错误，不提交initialize。NoPID不制造原进程证据；有真实PID走既有原树清理。

10项隔离case通过：EMFILE、ENFILE、joined、cancel-one、cancel-last、stop、sync-throw、close-only、timeout、actual-pid。其中cancel-last使用明确真实metadata后继并晚交付原failed receipt；actual-pid真实启动忽略stdio的本地keeper并验证原birth树退出。两条实际spawn路径没有模型/线程请求，其他错误case仅回放native契约。

相关104项控制保持，原stdin/stdout、初始化取消、stderr真实65536字节隔离和4MiB queued write断言未改。完整门禁与正式加载见[第55轮记录](../iterations/2026-10-07-fiftyfifth-missing-stdio-spawn.md)。没有声称真实EMFILE/ENFILE耗尽、provider/Token计费、浏览器或Linux pidfd实机验收。
