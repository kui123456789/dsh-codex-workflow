# Node测试事件与完整运行回执

状态：[第92轮](../iterations/2026-10-10-ninetysecond-native-test-receipts.md)完整验收通过：原verify/release各1612/1612，169文件及原生累计回执分别核对、host/11恢复/diff成功，原进程exit0；最低Node22.19相关68/68及typecheck通过。运行时217产物与正式相同，保留DSH56144。固定来源与小型探针本身不是完整放行依据。

## 来源与可复用机制

通过agent-reach的GitHub/gh后端读取Node官方固定提交：

- [Node 22.19.0](https://github.com/nodejs/node/tree/f8fe6858549f75a4b4e9633abf39dd2038dbf496)。
- [Node 24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)。

各版本保存`doc/api/test.md`、`test.js`、`runner.js`、`tests_stream.js`、reporter utils及完整LICENSE，共12份Git blob/SHA256核对。核心许可MIT，依赖许可以原LICENSE为准。证据位于仓库外`.codex-workflow-verification/node-test-summary-20261010`，两个source index保存路径、字节及固定SHA。

Context7先resolve Node，再查询22.20及24文档；22.20检索同时出现main片段，因此最低版本事实以实际22.19固定源码为准。两个版本的`TestsStream.summary()`均发送`success/counts/duration_ms/file`；其`nesting`形参不写入summary数据。`counts.topLevel`是数量，不是摘要层级标志。

## 本机实际契约

Node24.14原生CLI、两份隔离夹具及一个嵌套测试产生两条文件摘要和一条`file`未定义的累计摘要；每次都有三个测试、两个顶层测试。原始JSONL、stderr和各次exit/signal回执保存后独立重读，没有用重新运行替代缺失证据。

| 场景 | 累计摘要 | 退出码 | 完整门禁 |
| --- | --- | --- | --- |
| 全通过 | passed3，success true | 0 | 可通过 |
| 跳过一个 | passed2/skipped1，success true | 0 | 拒绝 |
| 失败一个 | passed2/failed1，success false | 1 | 拒绝 |
| 取消一个 | 文件cancelled1；累计failed1/cancelled0，success false | 1 | 拒绝 |

Windows首个探针误用盘符路径加载ESM reporter，产生`ERR_UNSUPPORTED_ESM_URL_SCHEME`；需`pathToFileURL(...).href`。随后两次计数断言分别混淆文件与累计层，日志保留；这属于研究夹具修正，不是项目产品RED。最后独立审计原四份exit/JSONL回执通过。

## 后续采用边界

如果引入机器回执，必须记录文件摘要与累计摘要、拒绝缺失/重复/异常字段、保留原诊断，并结合原实例的实际退出结果。stream结束、success true或零退出均不能单独放行。单文件、TODO、自然异步警告、进程中止、损坏回执、多reporter和Node22实际执行尚未覆盖；当前结果不证明这些边界。

第91轮先完成已有隔离验证，不据此替换其运行中reporter或扩大依赖。该研究为后续机制准备，不声明新的完整门禁或正式部署。

## 第92轮实际采用与新证据

第91轮全量verify/release各1574/1574及host/11恢复/diff实际完成后，进一步复现两条实际缺陷：合法dot的完整3/3被文本计数拒绝；断言前zero-exit的原生文件被TAP人工计数误放行。原代码及候选小型真实CLI日志/exit分别保留。新companion独占创建语义JSONL、保留人工reporter配对、绑定原run/root；reader必须取得各文件与累计摘要、stream完成和实际命令exit0，拒绝不完整结果。

13个实际原生用例加25个身份/格式/归属控制通过，连同既有隔离/reporter控制实际68/68及typecheck；真实覆盖单/多文件、suite、TODO/skip、取消/失败、自然异步错误、提前zero-exit、空文件、多reporter、scope和既有回执保护。进一步取得官方SHA256核对的便携Node22.19，真实运行同四文件68/68与typecheck通过；不能把相关最低版本控制当Node22整个项目门禁。当前唯一原CLI32980在325输入副本执行新1612预期完整链；10份采用文件与旧字节回滚保留，完整状态见第92轮。

该原链最终03:43:36完整success/真实exit0；verify/release各1612/1612，两个独立run/root的169文件/累计/stream摘要与冻结inventory核对，host/11冷回放/diff通过。325份输入、10采用文件及217正式内容/HMR metadata无偏差，429会话文件与完整workflow/queue保持。此前运行中表述保留时间顺序；最新放行及未覆盖范围以第92轮最终节为准。
