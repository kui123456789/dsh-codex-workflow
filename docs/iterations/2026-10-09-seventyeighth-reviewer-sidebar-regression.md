# 第78轮：Reviewer原侧栏的回归与全过程候选验收

状态：Reviewer修正、5项正式回归及持久化宿主验收增强已完成完整门禁与受控加载，正式PID57092。verify/release各1468/1468、host/host-recovery/diff通过，数据保持；见[第82轮最终记录](2026-10-09-eightysecond-final-gates-and-formal-load.md)。

## 回归边界

接续[第77轮](2026-10-09-seventyseventh-automatic-child-sidebar.md)已确认的缺陷：`review/end`将activeReview置null，但最新reviews仍携带原child；客户端进入汇总页fallback，遮住原Reviewer的continue消息。

仓库外`reviewer-sidebar-regression.test.ts`使用真实`src/client.js`和原投影订阅接口，准备以下5项Node回归：

1. running转waiting后不打开汇总页。
2. running转completed后不打开汇总页。
3. 冷读完成审查优先选原Reviewer，而非旧Planner。
4. 保留审查的重复更新不重开标签；真正的新业务审查选其新child。
5. 缺少child的旧记录保留summary fallback。

原代码5项中4失败、1控制通过；仅在测试内替换child选择表达式后5/5通过。使用继承仓库tsconfig的临时配置单独检查这些测试，exit0。候选环境分支只存在于仓库外诊断文件；合入正式测试时应删除它，测试直接运行实际源码。

## 从首次失败开始的真实UI候选场景

独立DSH_HOME、端口3101；PID28656/birthKey `win32:134359778216601390`。真实安装宿主0.1.7-rc.2的ToolRuntime、SessionStore、SubagentRuntime、JSONL后端和浏览器组件；轻量Agent工厂和受控本地模型网关。临时模块只替换包注册ID及`active?.childSessionId`到`latest?.childSessionId`这一个选择表达式，冻结源文件未改。

- Parent：`ui-recovery-parent-7770f5ff-2949-41c7-815a-a51addce2868`。
- Workflow：`53607346-6b01-437c-981e-e5ee15276823`。
- Child：`252cbbd8-b900-45e6-aca9-8ffc7d03353a`。
- Thread：`reviewing-96db8de4-da78-4620-87a7-73a6c4ce4040`。

开始前无side layout、0标签；只选择原父会话。review_only经历两次受控失败后进入waiting，原Reviewer仍为活动`tab2`；没有summary抢焦点。省略workflowId调用resume，第三回合成功；completed及刷新仍选原`tab2`、原child资源，短continuation和审查结果可见。

waiting/completed/reloaded三份机器回执均exit0：线程和child各创建1，turn/start、turn/end由2增为3，等待未释放child，成功释放1次。原生API读取child有效descriptor、34事件、3次turn/start，父目录只保留原Reviewer。这是独立验收场景，不是重建第77轮已完成的线程。

## 证据与保护

第77轮证据目录保存5项回归RED/GREEN和类型检查；本轮仓库外目录`../.codex-workflow-verification/seventyeighth-20261009/`保存候选模块hash、装载脚本、断言及原生API结果。安全截图和回执位于`output/playwright/reviewer-candidate-20261009/`（Git忽略）。

原候选实例捕获的两实例树已按birth身份核对退出，命名浏览器`dsh-reviewer78`已关闭。正式DSH没有重启，provider、凭据、历史会话及corrupt child保持。

候选通过不等于正式交付；需等第76轮原release/host门禁结束，再合入一行生产修正与5项正式回归，运行所需完整门禁并受控加载。真实provider故障、Token账单与完整AgentLoop组合仍未验收。

## 合入及局部验收

第76轮release于08:15:56真实结束为exit1，1462通过/1失败；失败是模型目录初始化拒绝后的原进程树清理未确认，未说明与UI修正有关。单例复查1/1通过，原失败原因仍未定位，不用局部结果覆盖它。

确认原runner53340不再存活后，将5项回归写入`test/reviewer-sidebar.test.ts`，删除临时候选环境分支，直接读取实际`src/client.js`。合入前正式RED为1通过/4失败，exit1。生产改动仅在scan中使用`latest?.childSessionId`，并说明waiting/completed历史保留child。没有改变线程生命周期、模型提示词、错误恢复资格或成功清理。

合入后新回归及原`client-sidebar.test.ts`共14/14通过，失败/取消/跳过/TODO0，exit0；`pnpm typecheck`exit0。README、CHANGELOG及发布清单同步说明原Reviewer选择和独立UI验收边界。下一轮完整测试预期1468（1463+5）；以新的冻结manifest验收，不复用第76轮通过计数。

## 新完整门禁

309份输入及同数实际副本已冻结，manifest SHA256为`782C28F76B9018F04C8C6BE43907CDA28624C82723A4AA8F41A418A76715202E`。08:18启动唯一runner PID43236/birthKey`win32:134359787058308250`，门禁目录`final-gates-b22f7238-c570-4bd0-94d0-82d7205650f3`。依次执行verify、release、host、host-recovery和diff，测试计数门槛1468；命令、真实exit、异步警告及source hash分别核对。

首次观察确认原runner仍活、verify进入测试；没有复用第76轮已失败的runner。当前尚无完整门禁终态，未进行正式重启。正式428份会话文件、111条workflow完整记录仍与基线一致；正式413会话身份的最近只读核对不变。原初始化清理失败及单例通过的边界保持，不能声称已定位或修复该异常。

[第79轮有界观察](2026-10-09-seventyninth-initialization-cleanup-observation.md)的8样本未复现第76轮清理异常；24次原retirement、48实例退出均确认，模型0，原因保持未知。该探针不改变本轮冻结版本；原runner及verify继续观察。

[第80轮](2026-10-09-eightieth-controlled-load-preparation.md)已准备绑定原formal身份和当前门禁的受控加载脚本。309份source偏差0、217份build路径保持、仅client变化且与src匹配；未完成门禁的实际冻结守卫exit1，未写build冻结或启动替代实例。正式加载仍待原完整门禁通过。

## 完整verify结果

08:36原runner summary确认verify exit0，1468/1468通过，失败/取消/跳过/TODO及异步警告0，1036.21秒。五项新增Reviewer回归在完整日志1113—1117均通过；第76轮失败的error初始化拒绝用例本轮verify通过，但原失败原因仍未知。原runner43236已进入release:check，后续宿主门禁和受控加载未完成，不能将verify通过当作整体放行。

## 最终交付

原runner于08:53:10结束exit0，release1468/1468、host、11场景独立持久回放及diff全部通过，异步警告0。最终217份build冻结后，原formal41660的11实例树退出确认，一次启动新PID57092/birthKey`win32:134359809091459730`，认证HTTP200。413会话身份、111workflow、119queue及428会话文件保持，build/关键模块hash偏差0。

正式boot及实际服务client响应也核对包含冻结修正代码；此次读取没有创建会话或模型请求。完整证据和保留的历史失败边界以第82轮记录为准，以上待完成表述属于此前时间线。
