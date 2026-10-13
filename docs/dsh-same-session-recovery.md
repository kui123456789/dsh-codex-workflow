# 在 DSH 验证原会话继续

使用独立的验收父会话，保持同一 DSH、插件和 App Server 进程。中途重启会丢失 ephemeral 线程；本测试不能修复历史 `corrupt` 子会话。以下提示词用于 **DSH-led 工具流程**，Bridge 审查通过原 submission 的后台重试恢复。

## 测试 Planner

在 DSH 发送：

```text
请调用 codex_workflow_start，让 Codex 只读分析当前项目的模块划分，给出一份新增本地健康检查的计划。只规划，不修改文件、不执行实现、不发起审查；计划完成后等待我确认。
```

看到 Codex 子会话开始输出后，停止当前**父会话回合**，然后在同一父会话发送下面的继续提示词。不要调用 `codex_workflow_cancel`；它会取消 workflow，并非制造一个可恢复的调用者中止。

```text
继续刚才的原 Codex workflow。先调用 codex_workflow_status，不传 workflowId。
只有 continuation.available 为 true 时，才发送新的模型继续：调用 codex_workflow_resume；workflowId 可以省略，instruction 使用“请在原会话继续完成未完成部分”。
若 reason 是 running，等待原操作；若是 start_receipt_pending，可调用 resume 只检查原回执，不重复提交模型请求；若是 interruption_unconfirmed，可调用 resume 处理原回合中断确认，确认后才能继续。这两种安全检查不要求 available 为 true。
其他不可用状态或查询异常，请报告准确原因。不要重新 start、不要新建 Planner/Reviewer、不要重发完整任务，也不要在父会话代写计划或审查。
```

工具未返回 `workflowId` 不等于没有记录。先按父会话查状态；若确实未取得原线程身份，恢复应被拒绝。

## 当助手声称“没有句柄，无法继续”

先要求它在**原父会话**调用不带 ID 的 `codex_workflow_status`，按实际返回值判断：

- 返回原记录且 `continuation.available: true`：省略 `workflowId` 调用 `resume`，继续原线程。
- 原启动回执待定或中断未确认：按上面的安全检查处理原操作；不能再次启动模型。
- 明确返回没有活动 workflow，或原线程不可用：报告原始诊断并停止恢复。历史 `corrupt` 子会话不能靠重新 `start` 修复。

`start` 的“一次”约束用于防止重复启动，不是失败后永久耗尽的配额；但它也不授权创建替代 Planner。`continue` 用于回答规划澄清问题，失败恢复使用 `resume`。侧栏子会话是插件托管的显示入口，恢复身份以 workflow 和原 App Server thread 为准；不要直接向侧栏会话发消息冒充恢复，也不要由父会话代写结果。

`no active workflow`只说明当前查询没有找到活动记录，不能据此断言数据库没有记录。2026-10-10只读核查原验收父会话，实际存在两条终态记录：`failed`且错误为`operation aborted`，以及`cancelled`；二者均未保存Planner/Reviewer原线程身份。记录存在和模型线程可恢复分别判断：缺失身份不能根据历史corrupt child补造，也不证明远端线程从未创建。本次数据库观察没有执行原父会话工具或恢复模型。

## 测试 Reviewer

在另一个验收父会话发送：

```text
请调用 codex_workflow_review_only，只读审查当前工作区的失败恢复机制，重点核查是否复用原子会话和原线程。不要修改文件，不运行 Planner，不自动发起新的审查轮次。
```

看到 Reviewer 开始输出后，按上面的父回合停止与继续步骤测试。恢复期间保持工作区和审查范围不变；实际工作区变化属于新业务审查，不能用来证明同一轮恢复。

## 核对结果

开始前和继续后记录工具参数、状态结果，以及原子会话截图。子会话 ID 可从侧栏 `dsh-resource://subagentchat/session/…` 资源地址或宿主会话列表核对。

| 核对项 | 恢复成功的证据 | 不能据此认定成功 |
| --- | --- | --- |
| Workflow | 两次状态的 `id` 相同 | 仅看到相同任务标题 |
| 模型线程 | `plannerThreadId` 或 `reviewerThreadId` 相同 | 新线程重做后得到相似内容 |
| 侧栏子会话 | 原 child ID 保持，追加继续回合与消息 | 父会话自行交付结果 |
| 等待状态 | 可恢复失败为 `processState: waiting`；按恢复资格继续 | 任意 waiting 都强行 resume |
| 提交次数 | 原回执未返回时不重复模型启动 | 把另一个 start 当作重试 |

验收结束后，先查询并确认这个验收 workflow 的真实 ID，再显式取消未完成的验收任务。不要取消其他会话的 workflow。

人工停止验证的是**调用者中止与句柄找回**。模型自然断流、超时和服务过载须分别记录实际错误；不能用提示词要求模型“报错”代替这些故障。安装宿主的隔离检查 `pnpm host:recovery:check` 使用本地受控模型网关，不调用正式 provider；它证明工具、原生子会话及恢复身份契约，不代表真实模型故障或 Token 费用已验收。

更多维护者检查见[发布清单](release-checklist.md)；已有正式 UI 中止验收的历史证据见[第六轮记录](iterations/2026-10-05-sixth-runtime-validation.md)。

## 当前修正与验收状态

Reviewer在等待或完成后，其原child仍保存在最新审查记录里。[第78轮](iterations/2026-10-09-seventyeighth-reviewer-sidebar-regression.md)修正客户端选择并新增5项回归，避免汇总页遮住原child的continuation。相关14/14、完整verify/release各1468/1468、宿主及持久回放检查通过；[第82轮](iterations/2026-10-09-eightysecond-final-gates-and-formal-load.md)已受控重载正式DSH并核对实际服务client和历史数据。测试旧运行环境时，可手动选择原Reviewer标签核对原回合，不以汇总页内容推断新线程或父会话代写。

已取得的隔离UI证据：

| 验收 | 实际结果 | 限制 |
| --- | --- | --- |
| [第75轮实时追加](iterations/2026-10-09-seventyfive-native-sidebar-continuation.md) | 同一child追加自动/手动继续 | 完成后刷新失败，临时工厂缺少日志写入器 |
| [第76轮日志回放](iterations/2026-10-09-seventysixth-persisted-child-replay.md) | 补齐原生日志生命周期后，刷新读取三回合；host检查增加独立读取 | 侧栏由保存布局恢复，未证明自动开栏 |
| [第77轮实际客户端](iterations/2026-10-09-seventyseventh-automatic-child-sidebar.md) | 无预置布局，Planner自动开栏；同时复现Reviewer抢焦点 | 原Reviewer线程恢复成功，展示验收失败 |
| 第78轮候选全过程 | Reviewer等待、继续、完成和刷新均选原标签 | 真实宿主UI、轻量Agent工厂和脚本网关；完整门禁及第82轮受控加载通过，真实provider仍需独立验收 |

上述证据不代表真实provider故障、Token费用或完整AgentLoop组合已验收。日志可读也不证明重启后ephemeral模型线程仍能恢复。

第83轮summary文字及[第84轮Planner过程字段](iterations/2026-10-09-eightyfourth-planner-waiting-view-diagnosis.md)均已完整验收并正式加载：原暂停、继续running、ready/completed及terminal失败清理显示核对通过，旧日志不推断缺失字段。verify/release各1490/1490，重载前后当前429文件全量哈希保持。显示pause仍不能代替continuation.available判断。

[第87轮](iterations/2026-10-09-eightyseventh-cold-projection-snapshot.md)补齐未就绪投影的稳定加载快照，避免冷summary崩溃；相关44项、只读history候选、verify/release各1496/1496和受控加载通过。正式服务资源包含新guard，历史数据保持；加载显示本身不创建Agent，也不恢复已丢失的ephemeral线程。

[第88轮](iterations/2026-10-09-eightyeighth-sidebar-disposal.md)已通过verify/release各1504/1504、host及11恢复场景，并在Windows重启后受控恢复正式DSH。实际PID51892认证HTTP200，414会话身份、429文件及完整workflow/queue保持，服务client包含sidebar退役guard。旧进程的ephemeral上下文不因历史文件保存而恢复；本轮未修复历史corrupt child。

后续[第89轮](iterations/2026-10-09-eightyninth-monotonic-retry-clock.md)单调重试预算及[第90轮](iterations/2026-10-09-ninetieth-sidebar-retry-budget.md)侧栏重试耗尽保护均已完成完整门禁并正式加载。第90轮verify/release各1557/1557、host及11恢复场景通过；正式PID56144在2026-10-10 00:05启动，认证HTTP200，414会话身份、429文件及111workflow/119queue完整哈希保持。这些结果不证明真实provider断流、Token费用或历史corrupt child已修复。

[第91轮](iterations/2026-10-10-ninetyfirst-isolated-verification-command.md)新增`pnpm verify:isolated`，完整检查在独立代码副本生成产物，避免验证构建经HMR提前更新正式侧栏。verify/release各1574/1574、host/11持久冷回放/diff已通过，原进程实际exit0；321输入及217正式文件内容/metadata保护通过，429会话文件及完整workflow/queue保持。本轮运行时产物与正式相同，保留DSH56144；命令不自动部署或重启。后台进程未重启不能单独证明客户端版本未变，需核对实际服务资源；HTTP读取也不能代替浏览器执行验收。

[第93轮](iterations/2026-10-10-ninetythird-partial-child-output.md)补齐失败/取消收尾的部分正文保留，避免原child的block-end只剩错误提示。失败状态保持，诊断在原当前段后追加；partial不是已接受计划或verdict，也不改变继续资格。verify/release各1620/1620、host/11冷回放通过，原DSH树退出后精确交付已测JS/map，正式PID12176认证HTTP200，414身份/429文件及完整workflow/queue保持。实际provider、浏览器组合与Token费用仍未验收；历史corrupt child未修改。

[第94轮](iterations/2026-10-10-ninetyfourth-child-replacement-output.md)修正原子会话对replacement快照的追加错误：只替换当前段同kind/item正文，实时显示退役旧临时流，模型thread和child保持。独立实际browser验证旧draft消失、corrected正文保留、等待/刷新/原resume/释放后回读，thread/child/tab均相同；网关为scripted-local，Agent工厂轻量。verify/release各1632/1632、host/11恢复通过，正式59112已精确加载，429文件与完整workflow/queue保持。该结果不代表真实provider故障、费用或完整AgentLoop已验收。

[第95轮](iterations/2026-10-10-ninetyfifth-output-destination-contract.md)进一步统一模型指令的显示位置：Planner及共用Reviewer明确指向当前DSH child和右侧栏，去掉旧Desktop位置声明，保留Markdown/只读/语言与独立Schema转换。完整verify/release各1632/1632、host/11恢复通过，正式22108已加载，217产物及全部历史保持。后续callback终止优先级候选仍须独立验收，不能借本轮结果宣称终止错误多调用问题已修复。
