# 回调恢复的终止分类优先级

状态：第96轮完整验收及正式65896加载完成：原62488真实exit0、verify/release各1645/1645、172原native文件摘要、host加载/11恢复/diff通过。原21308完整verify1644通过/1取消及清理证据保留。414会话/429文件、111workflow/119queue保持；不将受控检查泛化为真实provider故障或Token费用。

## 实际证据与两个绕行层

[原调查](callback-timeout-terminal-precedence-investigation-2026-10-10.md)确认六条终止/具体错误包含timeout片段时，原dispatcher实际产生两次visible请求、一次continuation和一次conversion，最终verdict；两个真可恢复对照通过。线程创建仍1，这是一轮内多发模型请求，不是新thread/child。

源码存在两层放宽：inner catch把统一分类与非锚定timeout正则做OR；outer catch再用timeout/rate-limit/writer文本返回waitInThread。仅删inner OR仍会把原终止结果停放成待继续，因此候选同时处理两层。

## 固定GitHub机制与取舍

agent-reach GitHub/gh实际读取[p-retry固定index](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js)及MIT license，两份Git blob/SHA256核对，保存在本轮source-evidence。Context7先resolve p-retry再查询终止优先；固定源码在retry回调前先识别AbortError并返回原错误。main检索内容与固定版本分别记录，不把检索描述当实际依赖版本。

采用其“先做终止判定，再给重试机会”的职责边界，复用本项目已有isRecoverableModelFailure/transientReason，而非引入p-retry依赖、AbortError wrapper或更换调度器。原typed pending receipt、interruption、signal/cancel与thread owner在现有早期分支处理，候选没有重排这些分支。

## 候选修正与控制

inner只接受统一recoverable分类；outer把三条宽松fallback合并为现有transientReason及recoverable分类。合法完整model timeout仍保留turn timeout状态名，第二次generic失败保留原Reviewer而不是消耗完自动继续后变终态。具体control timeout和终止诊断附rate-limit/writer字样都不获恢复资格。

13项新增候选覆盖原六缺陷、两个真可恢复对照、四个mixed fallback及两次generic失败后的原线程手动恢复。相关9文件95/95、fail/cancelled/skipped/TODO和异步警告0及typecheck通过；真实RPC、取消、原start receipt、interruption barrier、thread owner和usage hooks均在范围内。初步35项也通过，但最终95来自一次真实相关命令，未拼接计数。

candidate与base哈希及95结果已封存prepared-candidate.json。主源码仍保持第95轮327冻结输入；只在其完整门禁/交付后按base hash采用，再获取新的1645全量、宿主/恢复和精确加载证据。这里没有真实provider进程或Token账单，不能把受控请求计数当实际费用。

上述采用条件已实际满足：第95轮真实exit0/完整1632与正式22108数据保护完成后，比较原327输入和4份base/candidate，备份旧字节再采用。第96轮原CLI21308及observer29564运行在isolated-rkLIyY，328输入、13新增与1645预期固定；正式lib仍第95轮。最终真实回执与加载状态见[第96轮](../iterations/2026-10-10-ninetysixth-callback-terminal-precedence.md)，先前candidate-only段为时间顺序。
