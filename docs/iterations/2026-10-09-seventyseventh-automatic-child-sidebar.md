# 第77轮：实际浏览器模块自动打开原Planner侧栏

状态：隔离Planner自动开栏、同标签继续和刷新回放通过；第76轮完整门禁仍使用原runner运行。本轮不修改被冻结的代码、测试和发布输入。

## 验收夹具改进

第75/76轮已验证原child的实时追加和持久回放，但侧栏标签由保存布局恢复。核查[模块注册机制](../research/github-native-client-registration-patterns-2026-10-09.md)，本轮临时包声明与生产相同的`dsh.client`依赖和`./client`入口，复制实际`lib/client.js`，仅将注册ID改为临时包名。

`browser-module-receipt.json`逐字节确认只有ID变化，生产client SHA256为`eb631409c8a373d033d5defb20515129804beb63341b2c1e9e6de8cb8bf9ad54`。临时服务仍使用真实WorkflowManager、ToolRuntime、SessionStore、SubagentRuntime、JSONL持久化和原生浏览器组件；轻量Agent工厂及脚本网关不调用真实provider。

## 原身份与实际观察

隔离服务PID52520，birthKey`win32:134359767326208500`，端口3099，独立DSH_HOME。

- Parent：`ui-recovery-parent-58202575-606c-41aa-980b-6ed1a04912e7`。
- Workflow：`f89dd0f2-b33f-4c29-8300-7802c9e16099`。
- Child：`2b347647-a9d0-4f0a-853a-ea093e0cd769`。
- Thread：`planning-c1e7e218-c881-46ad-80c7-e41423058b9b`。

开始前DOM标签数量0，原父会话的侧栏布局不存在；测试只设置父会话选择，没有写入侧栏布局。调用start后两次受控模型失败，进入planning/waiting；插件自动打开原Planner的subagentchat标签，自动continuation可见。

省略workflowId调用resume，第三回合成功，原thread/child各创建1次，child释放1次。等待、成功及刷新回执均保持原`tab2`和同一资源URL；最终计划来自原child，父会话无替代输出。原生API记录child有效descriptor、34事件、3个turn/start，父目录仅原child。认证前的401日志与认证后的页面分开；后者仅有API Key输入框的DOM提示，无插件错误。

`audit-auto-sidebar.mjs waiting|completed|reloaded`实际执行均exit0。安全前后截图和回执位于`output/playwright/autosidebar-20261009/`（Git忽略）；完整脚本和外部源码证据位于`../.codex-workflow-verification/seventyseventh-20261009/`。

## 未覆盖范围

此次证明实际Planner浏览器逻辑自动开栏；未验证Reviewer开栏、真实provider故障/费用或完整AgentLoop组合。完成后的日志回放也不代表插件重启后能继续旧ephemeral线程。没有修改生产成功释放逻辑，没有提交、发布或正式重启。

第76轮唯一门禁runner PID53340/birthKey`win32:134359764438484850`仍活，verify继续推进；不得因等待或观察超时重开测试。

## Reviewer实际缺陷与候选修正

后续使用独立端口3100和相同模块装载方法验证Reviewer。原生产浏览器逻辑确实创建原Reviewer标签，但在`review/end`投影将`activeReview`置null后，又打开并选中`Codex Review`汇总标签。继续回合仍在原child成功执行，但用户看不到原标签中的continuation。此结果否定“Reviewer自动展示已通过”，不否定恢复身份本身。

Reviewer parent为`ui-recovery-parent-7fe263e1-75b7-495f-943a-3dae18881fc2`，workflow为`8648f4ec-e0f3-42ad-a02b-cb542ae5574e`，child为`a4a20140-251f-49c7-a97e-de175a82af93`，thread为`reviewing-5f7d99bc-ade1-4841-8871-ba5c1edce051`。两次失败与手动继续成功仍只创建1个child/线程、3回合，成功释放child一次。初始标签`tab2`为原child，`tab3`汇总页抢走焦点；截图及原等待回执保留。

初次审核脚本还误用了Planner的自动继续文字，修正后仍失败；真实DOM证实汇总页被选中。不得将该脚本文字错误作为生产缺陷，也不得伪造未产生的`waiting-auto-sidebar.json`成功回执。

原因：`scan`只读取`active?.childSessionId`，忽略`reviews`中最新审查仍保存的child身份。仓库外VM探针使用实际源文件：运行转等待、冷读完成审查且旧Planner存在、新业务审查切换三项失败，childless旧记录fallback控制通过。将该表达式仅在内存中改为`latest?.childSessionId`后4/4通过。

仅临时浏览器模块应用同一行候选修正后，重新加载同一已完成Reviewer，自动选回原`tab2`，显示原continuation和结果。恢复临时原代码并刷新再次失败`Summary tab displaced original Reviewer`；重新应用候选并刷新通过。期间未调用额外模型、未新建Reviewer、未改变workflow/child/thread。真实等待过程的候选UI尚需新的受控场景验收，当前只证明原等待缺陷、VM等待修正及原完成记录的浏览器回放修正。

证据脚本：`reviewer-sidebar-probe.mjs`及`reviewer/audit-reviewer-sidebar.mjs`；有效RED/GREEN：`reviewer-sidebar-red.log`、`reviewer-sidebar-candidate-green.log`、`reviewer/original-browser-red.log`、`reviewer/candidate-browser-green.log`。Reviewer截图及回执位于`output/playwright/autosidebar-20261009/reviewer/`。

生产源码保持第76轮冻结状态，候选修正尚未合入或部署。第76轮verify现已1463/1463通过，失败/取消/跳过/TODO0、异步警告0、exit0，1061.88秒；原runner进入release:check。待冻结门禁结束后再写正式回归与修正，不修改正在验收的输入。

08:00收尾检查：Planner隔离PID52520和Reviewer隔离PID40744各自捕获的两实例树均按原birth身份确认退出，两命名浏览器均关闭。Reviewer清理脚本初次放入深一层目录导致相对import失败，未执行停止；修正相对路径后对同一原实例完成清理，未重启。正式413会话身份、111完整workflow及428会话文件仍与基线一致，running/waiting0。第76轮308份冻结输入hash偏差0，原runner53340仍活，release测试继续推进。所有RED与候选回执保留，未宣称生产修复完成。
