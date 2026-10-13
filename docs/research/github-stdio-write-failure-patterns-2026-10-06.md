# Child stdio 写入失败与 pending RPC 的生命周期

核验日期：2026-10-06。使用已读 Agent Reach GitHub／gh 路线读取两组固定源码、官方测试和License；Doctor原句柄3057已正常结束，GitHub warn只表示避免认证写探测，实际gh API读取成功。研究阶段先在C TEMP采证，本报告在本地缺陷确认后整理到docs/research/；不执行上游tests／服务、安装依赖、复制框架、修改生产或操作正式DSH／provider。未读取或输出正式stderr、请求payload或凭据。

## 问题边界

一个write可能同步throw，也可能返回后通过callback/error事件异步失败。返回false表示backpressure，不能当失败；返回true也不是远端RPC确认。pending RPC必须把所有退出路径接到自己同一份cleanup：response、timeout、caller cancel、transport close、同步throw和异步write error。移除原pending、计时器及abort listener，随后只settle原request一次。

主任务已确认两类本地红例：deadline后pending已经为0，但caller signal abort listener仍从0增加为1，stop后仍为1；真实SDK向暂停读取的本地上游写入4MiB JSON，writableLength=4194362、needDrain=true、pending=1，stop先以RPCStopped拒绝该RPC并确认原OS进程退出，原stdin socket随后报EOF／write EOF，因为没有error listener，SDK worker默认fatal exit1。探针只monitor异常，没有吞掉异常或执行正式模型。

本轮实施范围限定一次RPC settlement／统一cleanup，以及捕获原ChildProcess的stdin error handler：已stopped或旧A的迟到error仅消费，当前child的error沿现有failProcess保原cause。它不改变活进程的退役策略、远端ACK或全PID tree门禁。本报告不提前声称修复／全部门禁完成，也不把本地写失败当作远端turn停止的证据。

## 固定来源与许可

| 官方仓库 | 固定SHA／提交时间UTC | License范围 | 可采用机制 |
|---|---|---|---|
| microsoft/vscode-languageserver-node | b4f995b69c55502f3c41b6501a1057247258e402／2026-10-05 23:43:43 | [MIT][v-license] | stream callback进入write promise；sendRequest失败删除原pending并清取消登记 |
| modelcontextprotocol/typescript-sdk | b022522089a0c8b632595c6e7b536453945ed5a9／2026-10-05 14:38:02 | [转授权声明][m-license]：新代码Apache-2.0、未授权存量仍MIT，非规范文档CC-BY-4.0 | server error/drain listener清理、close后的late EPIPE消费；core per-request finally |

本文只引用原则和固定链接，不为MCP新文件统一套MIT，不引入其框架或依赖。Node官方Writable契约由主任务通过Context7 /nodejs/node实际核对：当前Node v24.14.0，write callback异步带error且先于error事件；false只表示等待drain的背压。本研究没有新增第三个源码仓库或执行Node上游测试。

## vscode-jsonrpc：写入结果必须接入请求的退出路径

Node适配器[WritableStream.write][v-callback]把每次stream.write的callback转成Promise：error=null/undefined才resolve，否则reject。同步throw由Promise executor传递为reject，异步callback错误也由同一个write promise返回；没有把write的boolean当RPC成功。

[MessageWriter][v-writer]订阅原writable的onError/onClose，并把本次header/body写动作组合成返回的Promise。与本项目一行JSON单chunk不同，它需要semaphore避免两个分帧消息的header/body交错；本项目无需因为引用此源码就增加同样的队列。

[sendRequest][v-request]先登记responsePromise，再await messageWriter.write。写失败catch只删除本次id，使用MessageWriteError拒绝该responsePromise。该reject与普通resolve都走取消state cleanup及原token listener.dispose，而不是等待RPC deadline补救。

官方[Request write failure does not cause an unhandled rejection][v-failure-test]使用已经destroy并close的真实PassThrough output，在独立Node子进程开启--unhandled-rejections=strict。它明确断言：

- sendRequest抛MessageWriteError，并观察ERR_STREAM_DESTROYED原原因；
- hasPendingResponse=false，cancel strategy cleanup只收到原id0一次；
- 原source随后cancel不能再send cancellation；
- 进程自然退出、输出done，dispose后cleanup仍只一次。

边界：这是destroyed stream／write promise的精确负例，不是本项目同步throw、真实child stdin EPIPE或old A/new B process代次的完整测试。writer.onError报告local I/O错误，也不自动证明远端业务或全部进程树已停止。

## MCP：pending send与关闭后的late error都要有归属

[core request finally][m-finally]把abort listener、response handler和timeout清理放在返回promise的finally；transport.send rejection在本request中reject，再由同一finally回收。这是per-request清理入口，不因失败而重发model。

其[StdioServerTransport.send][m-server-send]为pending write登记error/drain listener，任一完成路径都移除自己的两种listener并只settle一次。stdout的[生命周期error handler][m-server-error]先报告onerror再close；[close][m-server-close]在closed后保留只消费late error的handler，防止已接受的OS写动作后来EPIPE时因无error listener而崩溃。后继复用同stream时会清掉这种旧消费listener，避免累积。

固定官方测试已阅读，未执行：

- [pending write在drain前EPIPE][m-drain-test]用highWaterMark=1与可控Writable callback维持真实背压，callback返回write EPIPE后send必须reject；drain listener=0，只留1个生命周期error listener。
- [close后late EPIPE][m-late-test]write true的fast path先返回，stdin EOF关闭transport，随后emit error仍不throw；它直接证明true不保证OS写已完成。
- [error→close顺序][m-order-test]在stdout error后事件必须正好为error、close。

具体client边界必须写清：[StdioClientTransport][m-client-error]已给child.stdin注册error listener转发onerror，但它的[send][m-client-send]仍为write true即resolve、false等drain，没有同一write callback的错误reject。不能从server的上述保护推断child client所有异步send都已处理。它是本轮不能直接复制的负边界；vscode callback promise才与本项目每次stdin write更直接贴合。

此外client[原child pipe收尾测试][m-child-close-test]区分exit与close：grandchild继承stdio时，close可能滞后；dispose先确认原child退出并释放父侧pipe handles。该测试并未确认所有后代退出，本项目既有捕获PID tree与原thread owner仍独立核验。

## 本项目的最小采用与实际测试映射

| 原入口故障／控制 | 必须观察的本项目证据 |
|---|---|
| 原request write同步throw | caller收到原write cause；pending、timeout与该signal listener即时移除，后续abort/stop不重复settle、不重发 |
| write callback异步Error/EPIPE并随后同stream error事件 | 原caller一次拒绝，无uncaughtException/unhandledRejection；重复事件不清或改另一个owner的请求 |
| write返回false，稍后callback成功／drain | 继续等待原RPC响应，不当失败、不创建新thread/model；背压监听有明确清理 |
| 普通response、deadline timeout、caller abort、SDKstop | 每条路径cleanup自身pending/timer/listener；原错误cause与取消归属保持，stop后不残留登记 |
| A原stream late error/callback在B已合法启动后抵达 | 事件只消费A，不能fail B、删除B pending或close B child；error handler还要防A自身无监听器崩溃 |
| 写失败时旧模型turn／进程仍live或unknown | 不把本地pending清空当ACK／退出；仍按原handle、typed interruption和PID tree门禁处理 |

“统一cleanup”应属于原Pending对象与原ChildProcess／stream；写callback和stream error可能同时到达，应共享一次settlement规则。诊断只需要error code／固定stage，不附加stderr tail、原prompt或secret。

## 文档核对与证明范围

Context7对vscode-jsonrpc首次resolve返回无关库，改为microsoft vscode-languageserver-node后query命中其child stdio连接API；MCP resolve→query命中server send与v2迁移说明。但迁移概述的stdio write保护不能覆盖上述client源码差异；结论以固定实现与官方tests为准。所有公开解码文件在C:\Users\Z1803\AppData\Local\Temp\dsh-thirtyeighth-stdio-write-research。

本报告不证明此前历史corrupt会话可恢复，也不能从写失败补造丢失workflow/thread句柄。真实本地RED、实施和全门禁须由本项目实际入口另行追加。

[v-license]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/License.txt
[v-callback]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/ril.ts#L94-L110
[v-writer]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/messageWriter.ts#L126-L168
[v-request]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/common/connection.ts#L1448-L1474
[v-failure-test]: https://github.com/microsoft/vscode-languageserver-node/blob/b4f995b69c55502f3c41b6501a1057247258e402/jsonrpc/src/node/test/connection.test.ts#L256-L326
[m-license]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/LICENSE
[m-finally]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/core-internal/src/shared/protocol.ts#L1580-L1606
[m-server-send]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/src/server/stdio.ts#L186-L219
[m-server-error]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/src/server/stdio.ts#L75-L87
[m-server-close]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/src/server/stdio.ts#L154-L171
[m-drain-test]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/test/server/stdio.test.ts#L324-L346
[m-late-test]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/test/server/stdio.test.ts#L348-L372
[m-order-test]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/server/test/server/stdio.test.ts#L409-L420
[m-client-error]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L148-L178
[m-client-send]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/src/client/stdio.ts#L321-L335
[m-child-close-test]: https://github.com/modelcontextprotocol/typescript-sdk/blob/b022522089a0c8b632595c6e7b536453945ed5a9/packages/client/test/client/stdio.test.ts#L125-L152