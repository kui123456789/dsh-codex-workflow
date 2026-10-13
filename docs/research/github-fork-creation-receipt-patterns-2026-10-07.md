# 第44轮研究：异步 fork 创建回执的归属

## 固定来源与核验范围

通过 Agent Reach 的 GitHub/`gh` 后端读取 [microsoft/vscode-languageserver-node](https://github.com/microsoft/vscode-languageserver-node/tree/b4f995b69c55502f3c41b6501a1057247258e402)，固定提交 `b4f995b69c55502f3c41b6501a1057247258e402`，2026-10-05T23:43:43Z。所读 `vscode-jsonrpc` manifest 为9.0.3，实际固定 [License](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/License.txt) 为MIT。原文件保存在`%TEMP%/dsh-fortyfourth-github-d7f6a512-5146-4862-b09a-6cc9ee414038`；未运行外部测试、复制实现或引入依赖。

Context7先查询`vscode-jsonrpc`，未匹配到正确包；改为`microsoft vscode-languageserver-node`得到`/microsoft/vscode-languageserver-node`并查询取消与迟到响应。结果主要覆盖Language Client middleware与变更说明；不能将middleware丢弃结果的行为推断成底层JSON-RPC的响应登记策略，以下以固定源码为准。

## 可采用的机制

- [`connection.ts:1424–1477`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1424-L1477)：token取消发送cancellation；响应Promise按原request id登记。取消回调本身不删除这个登记或直接reject outgoing Promise。
- [`connection.ts:919–939`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L919-L939)：真实response到达时才从response map移除并resolve/reject；写入失败另有删除与错误路径。
- [`connection.test.ts:777–831`](https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L777-L831)：普通和预先取消的token能被内存transport里的server观察。测试没有验证返回资源的释放，也没有本项目的超时、fork或进程归属。

本轮采用原request路由与observer分离的原则。VS Code这一路径仍等待实际response，不能照搬成无限等待；本项目保留每个调用方的有界超时/AbortSignal，另保留fork创建回执至接纳或清理。取消消息并不能证明远端资源没有创建。

## 本项目真实RED

TEMP真实SDK/stdIO探针`%TEMP%/dsh-late-fork-receipt-087a58d689164f8aba310d480d1d5408`：健康对照fork1/model1/unsubscribe1；abort和timeout中，原RPC3已创建fork1、没有model，迟到回复被丢弃。再次normalize发RPC7创建fork2，只在fork2运行一次model并释放fork2，原fork1仍loaded。证据是重复创建和订阅泄漏，不是两次模型生成或已测Token费用。

新增行为回归首次运行2项通过、5项失败。原失败目录`dsh-fork-creation-receipt-tBQ6nX`、`VR6e4Q`、`dWuZob`、`GqIf3G`、`4ADvjf`保留在TEMP。完整验收仍以本轮实现和门禁记录为准。

## 最小采用与边界

`thread/fork`有单独的原创建回执：绑定实际进程、source owner、request id和转换输入身份。observer中止或超时不移除原回复路径。同一转换接回原fork；不同prompt/cwd/model/schema拒绝借用，并发observer不能两次消费。未采用的转换创建或已放弃的公共创建阻止source的新模型动作；未采用的创建均保持idle屏障。健康的独立public fork调用仍有独立创建语义，被放弃的迟到fork只释放其自己的subscription，真实unsubscribe ACK前保留其原归属。

没有编造fork/turn id，没有在创建回执前运行conversion，也没有把创建等待计入模型continuation预算。新DSH Planner/Reviewer默认ephemeral时直接原线程转换，不经过persistent source的fork路径；本轮针对SDK实际提供的fork资源管理，不声称恢复丢失原进程或历史corrupt会话。

同行审查追加两项真实RED：失败unsubscribe ACK前提前claim丢掉屏障（TEMP `dsh-fork-creation-receipt-aBSDoo`）；public调用在ready-start await后已取消却仍发fork（TEMP `dsh-fork-creation-receipt-TAyzd9`）。修正只在真实ACK及原generation未变后claim，并合并cleanup重试；提交前重检signal。首次过宽的source屏障还拒绝健康public并发调用，保留原独立语义断言并修正生产条件，未改测试迁就实现。

本轮停止回归验证单个受控原Node进程退出；没有把launcher退出当作全部后代backend退出的证据。该跨进程边界仍应按项目原进程身份规则单独验证，不能从此单节点测试推断。
