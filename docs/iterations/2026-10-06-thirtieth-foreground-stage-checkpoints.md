# 第三十轮：前台审查只恢复失败阶段

日期：2026-10-06。仓库 `D:\工作文件\projict\dsh-cc\dsh-codex-workflow`，HEAD `abb6174d283ced56590bee90b3511948e494b3f0`。保留历史未提交修改，无 commit、push 或发布。基线 `%TEMP%/dsh-thirtieth-source-baseline-e20a9acb-91dc-4a5a-9b74-1c8ab8100873` 保存第二十九轮源文件。

## 真实缺陷与上游参考

采用真实 SDK、原生 DSH 子会话、SQLite 与本地协议进程，没有调用正式上游模型。原 7 场景重复运行稳定为 5 RED／2 CONTROL：

| 原现场 | 原问题 | 修复路径 |
|---|---|---|
| 可读审查完成，conversion／alignment 通用模型失败 | 原 Reviewer／child 被释放，同材料再次 review 创建替代者 | 保留 validated readable／normalized 产物及原资源，只恢复失败阶段 |
| 私有 alignment timeout，failed ACK，原 writer 仍活；另一 Manager 使用同 SQL | 原 retry 被清空，空 runtime 的 Manager 重建 Reviewer 并通过 | durable pending marker、原资源 checkpoint、准确私有 pair 的确认 receipt |
| 注册 Reviewer 后 permission／Schema 拒绝 | 默认 review 再次创建 Reviewer | typed terminal reason，同证据默认拒绝，允许真实原范围变化或明确独立轮次 |
| Reviewer thread/start 未成功返回 | 没有原模型运行／线程可恢复 | 保留原业务的首次审查重试，不标已注册资源丢失 |
| 原审查、转换、一次修正完成，后置转换／再对齐失败 | 整段重跑或 resume 找不到原 handle | 保存 reconciliation 部分结果，跳过成功步骤 |

首个红命令实际 exit=1：

```powershell
node ./node_modules/tsx/dist/cli.mjs C:/Users/Z1803/AppData/Local/Temp/dsh-thirtieth-foreground-private-probe.mts --assert-original-recovery
```

原矩阵 `dsh-thirtieth-foreground-private-probe.results.json`，late-stage 矩阵 `dsh-thirtieth-reconciliation-stage-probe.results.json`。正式扩展回归在一致旧源码 snapshot 上 **1/12 通过、11 失败**，日志 `dsh-thirtieth-foreground-stage-expanded-baseline-red.log`；漂移用例当时失败于前置等待未实现，不冒称旧源码已执行漂移拒绝逻辑。

参考 [阶段检查点研究](../research/github-foreground-stage-checkpoint-patterns-2026-10-06.md)：LangGraph 按 task ID 保存成功输出、重试失败步骤；Inngest 复用服务端确认的步骤状态。两个来源固定提交，分别 MIT／Apache-2.0，上游测试只读未运行。没有引入框架依赖或复制框架实现。

## 实现与边界

- 新 `foreground-review-checkpoint.ts` 保存 readable、verdict、alignment、reconciliation 与 finalizing 进度。原 input、settings、证据与范围被捕获，包含批准计划、上次 review、合同失败状态；revision／heartbeat 不构成新业务。产物只存在于原进程，SQLite 的 `retryState.reviewCheckpoint` 仅保存 stage。
- 原 Reviewer 与 native child 保留。App Server 的 foreground conversion 实际在原 ephemeral Reviewer 上；alignment／reconciliation 使用独立私有 seed，不把其 pair 假装成原 Reviewer。一个业务轮次共享最多一次自动继续，人工 resume 不重置预算。
- 每个完成步骤在 scope guard 后推进。恢复不重做已完成的 readable、conversion 或一次性修正；确认后自动继续和公开 resume 都先检查原 Reviewer 可用。原进程已丢失时保留等待身份，不自动启动新 SDK 服务。
- 私有 cleanup receipt 严格关联 workflow/thread/turn；缺少 map 不是 ACK。原 tuple、PID tree 与 pin 保留到实际 ACK 或完整进程树退出。未知／仍活 writer 阻止第二 Manager 和显式新业务轮次。
- 权限、Schema、显示与解析错误终止，不由前台 fallback 切换运输层掩盖。注册失败后的同证据默认 review 拒绝；thread 未创建仍可首次 retry。合同未对齐单独报告 `review_contract_conflict`，没有被接受的代码修复任务；独立轮次仍遵守累计两次冲突 block 的规则。
- finalizing 临时读取错误／证据不足可以恢复后只验证文件，模型调用为 0。可靠的 kind／fingerprint 变化永久作废旧结果，保留原抛错与清理规则。

## CLI 闭环与错误分类

真实本地 CLI 子进程证明：readable correction 成功后内部 normalization 两次失败，原实现把 correction 执行了 3 次。新增可选第三 recovery 参数在 normalized verdict 返回前捕获 validated visibleText；旧两参数调用兼容。后续只转换保存的文本。

同时验证了参数入口：私有运行使用 `exec --ephemeral`，不得添加 `resume ephemeral`。官方 [非交互运行文档](https://developers.openai.com/codex/noninteractive/) 已实际 fetch，HTTP 200；Context7 resolve→query 核对 `/openai/codex`，本地 `codex exec --help` 也支持 `--ephemeral`／`--output-schema`。没有调用模型、改变配置或切换 provider。

CLI 包装后的纯 `turn failed` 通过可信 producer 的非枚举分类标记传递；没有有效最终消息且完整诊断不含 terminal 信息时才允许 generic model recovery。它不 unwrap 任意用户字符串。权限／认证拒绝混有断流／过载文本时在两个 retry 层都优先终止，原请求执行一次。

## 验证与曾暴露的回退

- 初始新增核心 **12/12** 通过；完整 common 组合暴露了旧真实 fingerprint 变化被泛 finalizing 等待吞掉。改为 TypedEvidenceChanged 与临时 EvidenceUnavailable 分开，原 freshness **9/9** 通过，原 throw／cleanup 断言没有删除。
- 增加 warm 私有 ACK、缺失原 artifact、文件暂缺后恢复三个控制，**3/3**；没有凭 durable stage 重建内存结果。
- 新 CLI 回归先 **3/5 通过、2 失败**，证明 correction 重放与 raw generic 包装误判。修后 CLI、App Server 核心与原 CLI 组合 **40/40**。
- 独立源码审查实际跑分类器，确认 permission／401 与 stream 混合文本被误判，新增纯分类＋真实 retry 请求计数回归先红后绿；与原 transient 组合 **8/8**。
- 忠实辅助 fixture 证明：确认旧私有进程退出后，原自动重试又启动新 backend。新增原 Reviewer availability barrier 后，实际 processStarts 仅原进程、private seed 仅一次；日志 `dsh-thirtieth-actual-aux-process-exit-verified.log`。
- 冻结目标组合实际 **98/99 通过**，唯一 CLI fixture initialize 在机器负载下超时；只提高本地 fixture deadline 到 15s 后，该单项精确复验 **1/1**，不改生产 deadline 或失败语义。日志 `dsh-thirtieth-frozen-independent-stage-regressions.log` 与 `dsh-thirtieth-frozen-cli-permission-verified.log`；类型、diff check 通过。

一致 red snapshot `dsh-thirtieth-reconciliation-red-a6860ee1-207b-442c-838a-e6f70f67d62a` 含依赖 Junction，已标 `DIAGNOSTIC-SNAPSHOT.md` 保留，禁止递归删除。本轮协议故障、安装宿主检查与正式上游模型 UI 故障不混称验收。

## 完整门禁暴露的旧预期与观察期限

首个完整 `pnpm verify` 实际执行 966 项：952 通过、11 失败、3 因测试总时限取消，615.32s，异步警告 0。记录 `%TEMP%/dsh-thirtieth-final-gates-626d9bed-ba33-4a88-ab2a-745f7fad8ef0/summary.json`；它不是最终通过证据，没有执行其后发布与重载步骤。

- 六个行为预期忠实更新：前台不暗中 CLI fallback；人工继续不重置整轮一次自动预算；已注册终止失败报告原线程不可用；转换、显示契约与基础设施终止失败之后，同材料只能显式请求独立轮次。保留周期、原资源计数与拒绝默认替代断言。相关目标 4/4、5/5 通过。
- 六个观察/租约场景及两个后台观察在机器负载下超过旧测试期限。仅调整测试观察或总期限，不改生产 RPC、模型超时或租约；200ms heartbeat 用可控 Date 保留同 TTL，并增加实际到期回收控制。六场景 6/6，相关后台场景纳入上述 5/5。

当时正式 DSH PID 29828、411 会话，runningIds=[]、waitingWorkflowCount=0，本轮没有单独重启它。随后用户提供的“中止后无句柄”解释引出了迟到创建响应丢失，独立 5 场景实际 3 RED／2 CONTROL，见 [第三十一轮](2026-10-06-thirtyfirst-planner-start-receipts.md)。两轮合并的冻结门禁最终 **977/977**，verify、两次 release:check、host、host:recovery、diff check 均通过，异步警告 0。正式合并构建已重载为 PID **75648**，认证 HTTP200、411 会话与指定原 parent 保留；详细实际结果以第三十一轮记录为准。
