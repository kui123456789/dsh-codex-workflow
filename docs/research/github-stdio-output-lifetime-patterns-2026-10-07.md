# 第52轮研究：输出通道失效与原资源寿命

## 结论

OS进程存活不等于JSON-RPC可用。原stdout关闭或读取错误应使原观察者结算、禁用该线程的模型能力，但不能宣称远端模型结束或丢弃进程清理责任。待定启动回执仍属于原操作；已知回合仍需原中断ACK或进程树退出证明。

## 固定来源

使用Agent Reach的GitHub/`gh`后端只读核对main SHA并获取源文件、manifest及许可，保存于仓库旁 `.codex-workflow-verification/fiftysecond-20261007/github-sources/`。不复制实现、不安装依赖。

| 来源 | 固定SHA | manifest / 许可 | 参考机制 |
| --- | --- | --- | --- |
| microsoft/vscode-languageserver-node | `b4f995b69c55502f3c41b6501a1057247258e402` | vscode-jsonrpc9.0.3 / MIT | 读取关闭使连接Closed，dispose拒绝pending responses |
| modelcontextprotocol/typescript-sdk | `b022522089a0c8b632595c6e7b536453945ed5a9` | @modelcontextprotocol/client2.3.1 / Apache-2.0 | protocol关闭先换掉handler map、清计时器，再结算原请求 |

[VS Code close](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L659-L678)与[dispose](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1544-L1557)分别管理连接状态和请求责任；不能误写成close自动拒绝了全部请求。

[MCP protocol关闭](https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L836-L860)保留原handler快照、取消计时器并返回ConnectionClosed。这支持本项目在通道失效后结算本地观察者，但其标准stdio关闭逻辑不能替代本项目原进程birth/handle证明。

Context7先resolve Node.js，再查询 `/nodejs/node`：readable的end/close不同于child的exit/close；stream.finished能观察完成和提前关闭。源码显示child退出与stdio结算并非同一时点。实际Windows实现由本地OS Socket和SDK回归验证。

## 探针与实际RED

最初fixture尝试stdout.end、关闭fd1和输出handle，都没有在此Windows环境观测到父端EOF；这些是未成立的探针，不能作为SDK缺陷证据。首个等待探针按已验证command/birth终止自己的进程，后续探针采用已有15秒有界等待并最终清理自己。

有效RED是关闭SDK原有的真实读取Socket，不伪造事件、不改SDK方法。backend实际持有RPC、保持存活；Readable关闭后pending仍1、观察者未结算、线程仍可用。日志 `output-socket-close-red.log`，现场 `%TEMP%/dsh-output-close-OKNhBm/output-result.json`。

## 采用与控制

SDK监听原stdout/readline的error和stdout end/close，只对当前child保存首个output failure、失效可用性并结算原观察者。新调用拒绝，不启动替代进程；物理child仍保留到stop。通道错误分类优先于其文本中的stream disconnected/transport error，不能进入模型continuation或transient backoff。

第一个event-loop立即处理版本破坏真实exit/stderr前缀，原日志保留。无错误关闭改用独立100ms事件顺序窗口，真实退出仍由原exit handler结算；显式读取错误直接处理。没有调整已有RPC/模型或stderr场景预算。不是把Readable关闭当作原进程退出。

五个原生场景GREEN：关闭、实际Readable读取错误、active turn、pending start及retired error。活跃模型仍带原thread/turn和未确认进程证据；待定receipt不造turn；原停止证明进程退出，退休Socket不会污染后继。stderr控制仍验证两种current模式的实际65536字节旧OS数据不进入新错误。

这里证明本地真实Socket关闭/读取错误，不声称已复现provider端自然EOF，也不验证真实Token计费或Linux pidfd。全量门禁及正式加载见[第52轮记录](../iterations/2026-10-07-fiftysecond-output-lifetime.md)。
