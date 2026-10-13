# 第54轮研究：初始化ACK与原通道就绪

## 结论

握手ACK只确认协议回复，不能覆盖随后的I/O故障。初始化还在收集原进程身份时，stdin错误会发生在无待定RPC的窗口；只rejectPending会漏掉启动观察者。应保存原child的首个读写故障，ready前重查，拒绝后仍完成原资源清理。

就绪后的通道错误同样禁用RPC和模型能力，保留物理child和已接受模型的清理责任。读写首因应共享一份记录，后来的错误或generic stdin unavailable不能遮盖原原因。

## 固定来源

本轮通过Agent Reach的GitHub/`gh`后端再次核对main SHA，固定源码、manifest和许可保存到仓库旁 `.codex-workflow-verification/fiftyfourth-20261007/github-sources/`，不复制实现、不加依赖。

| 项目 | 固定SHA | 版本 / 许可 | 参考机制 |
| --- | --- | --- | --- |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0 / MIT | 原I/O错误与退出、stream结算并存 |
| modelcontextprotocol/typescript-sdk | `b022522089a0c8b632595c6e7b536453945ed5a9` | client2.3.1 / Apache-2.0 | stdio读写错误传播与protocol pending handler管理 |

[Execa失败结算](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js#L115-L124)保存原error，仍等待exit和streams。本项目采用错误与清理责任同时保留，不能把stream或launcher结束当作原backend已退出。

[MCP stdin错误传播](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L157-L179)传给onerror；[protocol close](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L836-L860)管理原handlers/计时器。没有把MCP的error callback误写成自动处理了本项目初始化窗口。

Context7先resolve Node.js，查询 `/nodejs/node`：Writable.destroy(error)发error/close，后续write/end产生ERR_STREAM_DESTROYED；写入错误通常关闭stream。spawn/ACK与进程/stdio寿命不是同一证明。实际本地Socket故障由native回归驱动。

## RED与采用

真实SDK和本地backend在initialize ACK后保持运行，初始化原census尚未完成。关闭原stdin Socket并提供真实error，旧SDK仍返回ready。日志 `initialization-input-red.log`，现场 `%TEMP%/dsh-initialize-input-failure-kXkTPi/input-result.json`。此时没有thread/model请求。

根因为stdin监听仅failProcess，初始化窗口没有pending RPC，且只stdout有记录。共享transportFailures弱表只记当前child的首因；stdin错误具有terminal prefix与原cause。初始化ready前重查首因，再走已有原树退休路径；正常退出/stderr的100ms观察规则保持。

六个native模式通过：initializing、joined、caller-abort、ready、first-cause、active-turn。初始化窗口用真实已完成系统查询的callback delivery gate固定，只延后结果交付，不伪造census、不修改SDK方法、不放宽期限。caller-only取消仍返回其自身reason；其他观察者保存同一physical error。active-turn仅接受一个原模型，保持原未确认thread/turn和process evidence，后续故障不新增模型。

原输出/stdio/stderr组合首轮12/12保持，包括实际65536字节旧pipe隔离和4MiB队列写入。完整门禁与正式加载见[第54轮记录](../iterations/2026-10-07-fiftyfourth-initialization-input-failure.md)。本轮不是provider自然EPIPE、真实Token费用、浏览器或Linux pidfd实机验收。
