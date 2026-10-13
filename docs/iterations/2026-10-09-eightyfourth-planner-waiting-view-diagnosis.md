# 第84轮：Planner暂停状态的显示契约诊断

状态：Planner过程状态修正已完成verify/release各1490/1490、host恢复及受控加载，新PID53640；原生UI、v2回放和前后数据核对通过，持续优化目标active。

## 实际反馈循环

仓库外`probe-planner-waiting-view.mjs`复制当前host-recovery检查，只调整本地lib导入路径，并在首个Planner等待结果处读取真实SessionProjectionRegistry。没有更改record、投影或模型输出；预期显示层能取得waiting这一明确过程状态。

原实现退出1：workflow phase为planning、processState为waiting，原plan显示status为planning，但processState不存在；投影仍保留正确原child，thread/child各创建1，受控模型回合2。原manager.stop和fiber清理按既有finally执行，没有调用正式provider或操作用户workflow。

这条检查已经运行并能捕获真实数据遗漏；仅改前端“planning”文字无法区分正在运行与暂停，不能把所有规划一律标暂停。

## 路径核查

最初区分三条路径：producer没发布过程字段、schema丢弃过程字段、renderer忽略已存在字段。当前源文件表明：

- Planner保留可恢复运行的store更新确实写入processState waiting并返回原record。
- 初始plan-started只发送status planning；该等待更新路径未发送独立暂停更新。
- CodexPlanUpdatedEvent/CodexPlanView没有独立过程字段，apply plan-updated显式构造的对象也未保留它。
- planSchema为passthrough，schema本身不主动丢弃额外字段；但这不能替代producer和显式fold缺少字段的事实。

因此后续修正应覆盖原等待/继续生命周期事件、投影及renderer，而不是解析lastProgressMessage或绕过原线程资格。先证明waiting→running→ready、调用者中止、待定原回执、旧日志兼容及新workflow隔离，再以真实宿主继续验收。终态失败与待清理资源要保留原失败语义；不能由显示字段授予continuation资格。

## 保留当前交付链

第83轮源码仍冻结310份，hash偏差0；实际verify终态exit0，1481/1481，fail/cancelled/skipped/TODO及异步警告0，1003.39秒。唯一runner38920/birthKey`win32:134359837411831380`继续执行release，不重开原门禁。

第83轮修正的Reviewer/Planner现有明确status提示已取得局部及UI证据，本轮数据遗漏属于它明确保留的边界。计划暂停契约修正尚未实现或加载，不能把新的RED当作已完成修复，也不能用1481项通过否认该新增验收缺口。

证据目录：`../.codex-workflow-verification/eightyfourth-20261009/`，保存生成脚本、实际stdout/stderr及`planner-waiting-observation.json`。正式DSH保持PID57092；历史provider、凭据、会话及corrupt child不变。

## 独立候选实现与反馈

从第83轮310份冻结原字节创建仓库外candidate-source，复用本仓库node_modules Junction，无安装依赖。只改候选的4文件：plan事件/View增加可选processState并验证枚举，fold保留明确字段；初始/继续明确发布running，等待/待回执/原清理更新触发显示事件；renderer只将明确planning/waiting标为“规划已暂停”。终态failed加waiting资源清理仍保持失败heading，不授予resume资格。

8项真实projection+renderer候选测试，原源码3失败/5兼容控制通过；候选及原展示套件37/37通过，typecheck/build通过。兼容控制包括旧日志无字段、不把旧pause粘到后来事件、新workflow不继承、完成清除pause和clarification优先。

首次真实host候选仍失败：恢复时planStarted引用之前waiting record，导致发布waiting而非running。原store实际已running，诊断不是模型恢复失败。保留candidate-stale-start-red.log，planStarted显式running后host全部11场景通过，记录自然`running→waiting→running→ready/completed`，native/converted回答和model_interruption也通过，原child/thread保持。相关原生命周期31/31通过。

补齐未确认native答案恢复waiting_input后的显示更新及非恢复失败事件发布；最终候选typecheck通过，8项投影和答案/commit相关18/18通过。候选过程字段不用于恢复资格、thread创建、用量或lease判断。

生产4文件hash和candidate hash已记录`candidate-change-manifest.json`。候选尚需将新字段生命周期断言加入正式host检查，完成producer的pending/cleanup/abort边界回归及原生UI，才能合入并跑独立完整门禁。37/31/18项局部不能替代这些剩余要求。第83轮source freeze310份偏差0，候选未写主工作区。

## 当前正式实例

第83轮完整门禁终态通过后已独立受控加载状态文字修正，新formalPID36424/birthKey`win32:134359863173341550`。加载前后414会话身份、111workflow、119queue保持；旧428份文件逐项hash保持，新增会话文件早于加载但无加载前字节清单。第83轮最终记录说明该边界，不把候选plan字段冒称已部署。

## 主工作区合入及producer边界

保留第83轮原310份冻结输入核对后，先合入实际显示/producer测试。主源码RED为8项显示3失败/5控制；实际abort/timeout start receipt及失败terminal cleanup三项全失败，日志保留。随后只合入候选4文件，并增强host脚本断言等待、继续、ready序列。

现有真实App Server suites新增父Session事件断言：待回执必须显示planning/waiting而不发新turn；native答案成功后caller abort显示pause，resume后ready/completed；terminal cleanup waiting仍为failed业务状态并保留原错误，ACK后过程failed；cancel/stop晚回执不增加新的waiting事件。相关9文件共70/70、typecheck及11host场景通过，原生命周期业务断言保留。

独立candidate确认这些边界后主源码同步。可选processState及字段fold变化使投影版本需更新；[宿主官方机制核对](../research/github-planner-process-projection-patterns-2026-10-09.md)补齐stateVersion2。v1真实检查点测试失败，v2新9项全部通过；初次测试仅有plugin参数及SessionHeader类型错误，修正测试类型后typecheck通过，未当作生产故障。11host场景以v2再次通过。

## Planner原生界面候选

独立端口3103、PID52044/birthKey`win32:134359868992796820`，真实宿主UI/SessionStore/ToolRuntime/SubagentRuntime/JSONL，运行candidate版本1的新增字段，轻量Agent工厂和受控网关。

parent `ui-recovery-parent-6c91a7ab-b818-459e-bc20-138b5cbe2a77`，workflow `fc13213f-b455-4d9a-a4fb-c8e732ba7a17`，child `dd92c629-b5e7-419f-98da-f9ca1f08046e`，thread `planning-a5d6c9df-d47f-4f8d-a720-7a94381e9b4d`。两次受控失败后原summary显示“规划已暂停”；原线程resume成功后“规划已完成”，pause清除。原workflow/child/thread保持，各创建1，3次turn/start/end，child释放1。summary标签以合法已保存布局恢复，不能冒称导航入口通过。此UI不包括随后v2缓存失效的完整浏览器回放；v2由真实宿主checkpoint/host验收覆盖。

原隔离两实例树按birth确认退出，命名浏览器dsh-planner84关闭。截图及身份回执位于`output/playwright/planner-pause-20261009/`。主工作区完成的恢复状态链不改变模型资格、自动预算、线程身份或旧日志；正式服务暂仍第83轮PID36424，不能把已合入当作已加载。

## 唯一完整门禁

311份代码/测试/脚本及发布输入、同数原字节副本已冻结，manifest SHA256`3C322A2811C9AC7E5CA53134AE857AC48B0397D6B4FCADA58F664FDE6A8716D1`。10:46启动唯一runner PID49424/birthKey`win32:134359875955879220`，gate目录`final-gates-e4011168-d705-405d-92f2-2598b01bae2b`。verify/release完整计数预期1490（1481+9），再执行host、host-recovery和diff。

首次观察确认原runner活、verify已进入测试，311份input哈希偏差0，尚无终态。正式只读核对414会话身份、111workflow及119queue保持，running/waiting/pending/有效租约0。正式PID36424没有为局部结果重载；必须以本轮原完整回执及版本冻结证明放行，不能复用第83轮1481项通过结果。

[第85轮](2026-10-09-eightyfifth-current-session-baseline.md)已补齐加载前当前文件全量基线和第二次工作状态查询，样本429份双读/capture/verify通过，不覆盖旧基线；再次capture被拒且原hash保持。真实基线会在后来受控加载时采集，不把准备样本当作停止前证据。原门禁仍运行时实际reload guard先exit1，未写实际基线、未停止formal或创建替代实例。

## 完整verify结果及新边界

原runner的verify终态1490/1490、fail/cancelled/skipped/TODO及异步警告0、exit0，946.54秒；原release继续运行。本轮还未正式加载。

[第86轮](2026-10-09-eightysixth-cold-projection-history.md)在没有Agent/model gateway的隔离实例验证v2原生API正确回放原日志，旧cache错误状态不覆盖完成结果，journal保持。但真实cold summary渲染读取undefined projection报错；最小probe亦复现默认空snapshot引用不稳定，仓库外候选3项GREEN。该新缺陷未合入主源码，不能以1490项通过覆盖它，也不能为历史显示创建替代Planner。

## 最终加载

原runner49424于11:18:36结束exit0：release1490/1490、961.57秒，host4.00秒、host-recovery6.53秒及diff通过；全部fail/cancelled/skipped/TODO及异步警告0。217份build manifest SHA256`4791C25B1869CF6FEDDEFC19940FE3C51624B6F4841E153859959E62EFDB4A44`，source SHA保持。

真实空闲核对后重新捕获429份文件基线，原11实例树退出确认，一次启动新formalPID53640/birth `2026-10-09T11:37:42.8432740+08:00`/birthKey`win32:134359906628432740`。认证HTTP200；414会话身份、111workflow、119queue及429当前文件完整哈希前后一致，0新增/缺失/修改，原parent/corrupt child保持。217build和27模块偏差0，fatal及running/waiting/pending/有效租约0，exec48326终态exit0。

正式资源包含Planner pause及projection stateVersion2，client SHA256`4c9ad9cde057914375efb084cdc80693655cebacb9bff06f05a12ed225b399aa`，服务响应SHA256`4b4dc1dec6a6706505436180dcbf48ceebbc90b65e04dffc123db33c58dca503`。读取无Agent/model创建。本轮之后cold client在第87轮另行合入，不属于本轮已验收版本。
