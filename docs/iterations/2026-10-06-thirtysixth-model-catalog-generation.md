# 第三十六轮：模型目录与默认选择限定原 backend 代次

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。本轮完整门禁通过，正式 DSH 已由 PID75844 重载至 PID79432，411会话及原父会话保留。最终实时证据见文末。保留全部既有修改、历史资料与配置，没有 commit/push/发布，也未修改 provider/profile。

## 已复现的问题

| Evidence | Finding | 本轮处理路径 |
|---|---|---|
| SDK本地协议重复使用同一个客户端实例，A实际退出或idle关闭后B公布不同model/default/effort；三场景RED | 客户端的cached model目录与默认选择跨过了原后端生命周期，独立新工作使用旧metadata | SDK在正确的原进程退出／新进程准备边界reset model cache；新进程独立请求读取B |
| Gateway挂起旧model/list、已有目录推导default、named及fallback Plan响应，reset后B先完成；初始四场景RED | 清两个缓存字段仍不足以阻止A的await后回填或从B目录派生旧请求结果 | 每次派生保存opaque cache generation，跨每个await及回填点重新核对 |
| initialize RPC error与非法 `{}` 两个真实探针：第一次reject保原cause，但PID仍活；第二次调用跳过initialize并接受其metadata | initialized状态在确认前被接纳，坏握手污染后续请求 | 成功验证后才接纳；失败只清原child，等其退出，随后SDK调用重新初始化 |

这组metadata读取使用真实SDK与独立本地协议进程；没有调用正式模型或注入provider故障。初始化RED的wire只有initialize一次，后续错误地发出model/list，而没有线程／模型；诊断进程最终已实际退出。进程观察、协议请求与业务恢复能力分别核验。

公开来源见 [Apollo／node-redis固定研究](../research/github-model-catalog-cache-generation-patterns-2026-10-06.md)。Apollo捕获自己的Trie/entry且精确匹配后清理；node-redis的特定NoRedirect entry变体验证creator与socketEpoch。普通Basic cache的clear仅清map，不能当作旧loader已经失效的证明。上游源码、MIT License、官方测试固定到SHA，测试仅阅读，未执行或添加依赖。

## 最小采用与边界

- `ModelSelectionGateway.resetCache()`更换原namespace的generation并清目录/default。迟到目录解析、已有目录的default派生及Plan-mode named/fallback响应不能越代回填；原RPC失败cause保留，不缓存为成功或空目录。
- SDK公开default/list与mode metadata在工作前准备真实server，并在await后复核该process。原已接纳模型请求继承自己的process/thread owner，失去原process时拒绝，不为它spawn B来查询默认值。
- 同进程健康目录保持缓存命中，包括可验证的空目录。独立新进程的Plan、conversion、silent-review读取当前默认和catalog effort；显式model/effort覆盖仍优先，既有private低effort策略不变。
- 原Planner/Reviewer已经保存的model/effort与thread owner继续冻结；全局默认或目录刷新不能把原waiting workflow接到B。真正独立的新run使用新进程metadata，遵守已有新审查轮次接纳条件。
- initialize未成功时不能接纳metadata/thread。失败清理只作用于发生错误的原child，不强停后继进程；下一次独立SDK请求可重新初始化，但不会重建旧Planner／Reviewer。
- cache reset仅使namespace失效，不调用workflow start、resume或subagents.start，不添加singleflight，也不改变caller取消归属。当前CLI0.157.1的UUIDv7 producer未证明tuple/prefix碰撞可达，本轮保持辅助缓存键语义。

## 当前本地证据

| 检查 | 已有实际证据 |
|---|---|
| SDK目录、public metadata、永久stop、initialize、owned preparation | 初始10场景RED；当前 `model-catalog-generation.test.ts` **10/10 GREEN**，日志 `%TEMP%/dsh-thirtysixth-model-catalog-regression-green.log` |
| Gateway旧目录/default/Plan与控制 | 初始四红例后，当前独立组合 **12/12 GREEN**，包含ready-cache handoff、错误、空目录和caller取消；日志 `%TEMP%/dsh-thirtysixth-model-selection-cache-generation-green.log`；源码冻结后的最终组合仍待确认 |
| initialize两个原始探针 | `%TEMP%/dsh-thirtysixth-initialize-boundary-probe.results.json`保留RED现场；当前SDK回归两种失败均证明旧PID退出、下一次重新initialize且仍reject原配置错误 |
| typecheck／最终目标组合 | 当前中间typecheck已通过，日志 `%TEMP%/dsh-thirtysixth-model-catalog-typecheck.log`；全量源码冻结后的最终结果待确认 |
| `pnpm verify`、连续两次release、host及正式重载 | 待执行；没有本轮全套通过或正式75844载入新构建的证据 |

SDK当前GREEN控制还保留显式override-C/xhigh与同进程model/list一次缓存命中。10个场景不等于全套证明，不填预期总数，也不以三原SDK探针／四Gateway红例相加作为完整验收数量。

## 复跑与采证位置

```powershell
pnpm exec tsx --test test/model-selection-cache-generation.test.ts test/model-catalog-generation.test.ts test/model-catalog.test.ts
```

原目录切换三RED在 `%TEMP%/dsh-thirtysixth-model-catalog-generation-probe.results.json`与对应exit/idle wire；SDK初始10RED为 `dsh-thirtysixth-model-catalog-regression-red.log`。原源码基线 `%TEMP%/dsh-thirtysixth-baseline-d33ef2bf-6486-4931-8075-d6fdf1d4aa35`保留，不清理其依赖Junction或旧诊断材料。

辅助索引审计保留CLI契约及边界资料，当前不是tuple缺陷或修复完成证据。研究稿由C TEMP整理到 `docs/research/`，没有复制整个上游或建议框架迁移。

## 最终门禁与正式重载：待追加

SDK最终新增13/13与Gateway12/12组合25/25通过；目录／冻结设置／原owner组合48/48通过，既有SDK／owner／Planner设置兼容59/59通过。初始化单flight最后调整后，7个启动／idle／stop控制再次通过。类型与diff检查通过。

追加的真实held initialize探针还证明：ACK未到达时，旧start优先认可活child，导致第二个start与metadata提前完成并发送model/list；stop前ACK仍held时，joined调用已错误fulfilled。调整为优先等待原starting句柄后，ACK前secondReady与metadataReady均false、model/list为0，ACK后顺序正确；stop-before-ACK所有joined观察者返回stopped且原EOF一次。这个修复没有新建工作流或修改模型／provider配置。

后续需记录实际冻结源码、最终目标测试数量、`pnpm verify`、连续两次`pnpm release:check`、`pnpm host:check`、`pnpm host:recovery:check`和`git diff --check`。正式重载必须先实时核对旧PID／命令／监听及会话活动，再核新PID、认证HTTP、构建hash、411会话及原父会话；目前不宣称这些动作完成。

持续优化目标保持active。目录协议与初始化错误是本地fixture注入，不能冒称正式provider、费用或真实UI完整验收。

## 最终验收与正式重载

上节保留交接时的待执行状态；以下是之后实际完成的最终结果。完整套件的117个测试文件均以文件并发2执行，原场景内部并发与断言不变。

| 检查 | 实际结果 |
|---|---|
| `pnpm verify` | 1110/1110，311.59s，异步警告0 |
| `pnpm release:check` 第一次 | 1110/1110，457.08s，doctor／pack通过，异步警告0 |
| `pnpm release:check` 第二次 | 1110/1110，468.49s，doctor／pack通过，异步警告0 |
| `pnpm host:check` | exit0，6.87s |
| `pnpm host:recovery:check` | exit0，13.05s |
| `git diff --check` | exit0 |

三次完整套件的失败、取消、跳过均为0；offline doctor的5项正式Codex检查按契约skipped。真实门禁记录位于 `%TEMP%/dsh-thirtysixth-final-gates-5bb3f21e-b7c4-4394-bea3-948ca7f2807c/summary.json`。运行时仅两个源文件改变，源码与对应两个构建文件、新增三份测试／协议产物哈希均在重载前匹配。

重载前复核PID75844的准确命令入口、监听及活动：411会话、runningIds=[]、waitingWorkflowCount=0。只停止已核验的正式DSH进程树，再使用原入口、profile与参数隐藏启动，没有修改provider、凭据或历史corrupt会话。

重载后实时核验：旧PID75844已退出；PID79432监听 `127.0.0.1:3080`；认证HTTP200，页面标题 `DeepSeek Harness`，stderr fatal匹配0。411会话数量不变，原父会话 `session-1f26c68f-4026-41e2-bca9-0d0b5812fe55` metadata存在，runningIds=[]、waitingWorkflowCount=0。正式receipt的19个运行模块构建哈希再次核验均一致。

证据位于 `%TEMP%/dsh-thirtysixth-reload-receipt.json`、`dsh-thirtysixth-formal-metadata-before.json`、`dsh-thirtysixth-formal-metadata-after.json`、`dsh-thirtysixth-source-freeze.json`、`dsh-thirtysixth-build-freeze.json` 与 `dsh-thirtysixth-test-freeze.json`。第35轮源码／构建／测试基线保全于 `%TEMP%/dsh-thirtysixth-baseline-d33ef2bf-6486-4931-8075-d6fdf1d4aa35/`，其中依赖Junction仅用于冻结诊断，禁止递归删除。

本轮local SDK／原生DSH service验收证明目录namespace刷新、初始化准入与原线程恢复边界。没有在正式会话切换模型目录或注入真实provider故障，也未测量实际Token费用；认证页面和metadata检查不替代完整交互UI验收。持续优化目标保持active。
