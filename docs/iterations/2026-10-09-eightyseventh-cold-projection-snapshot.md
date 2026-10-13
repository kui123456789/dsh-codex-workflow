# 第87轮：稳定冷投影快照与原历史summary

状态：冷加载修正完成完整verify/release各1496/1496、host/11恢复及受控加载，新formalPID3436。相关44/44、typecheck、隔离history和实际服务字节核对通过，全部历史数据保持；持续优化目标active。

## 修正与回归

只改client读取和loading展示：不可变LOADING_PROJECTION、稳定默认subscribe，pending/null/absent返回同一快照，loaded数据按原引用返回；getter保留face receiver，client/server读共用函数。summary先显示“正在加载工作流状态”，真正empty workflow仍等待审查。

6项回归覆盖上述状态、3次原通知loading→pause/running/completed且订阅1次、getter receiver。正式测试已移除仓库外候选环境分支。主源码先5失败/1控制，修正后相关44/44、typecheck通过，fail/cancelled/skipped/TODO0。初次候选生成CRLF匹配失败而没有文件，误跑日志保留，未当作有效候选结果。

外部[React固定机制](../research/github-cached-external-store-snapshot-patterns-2026-10-09.md)核对4份实际字节及许可，0blob偏差，未添加依赖或升级宿主。后端投影版本、恢复资格、原thread/session身份和模型预算未变。

## 实际只读历史界面

独立端口3105、PID44552/birthKey`win32:134359891819732920`。复制原受控parent/child两份journal及旧cache到新home，注册实际v2投影；agent-loop关闭，无工厂、模型网关、WorkflowManager或workflow工具。旧cache在独立副本受控设为planning，无processState；原日志保留ready/completed。

原parent `ui-recovery-parent-6c91a7ab-b818-459e-bc20-138b5cbe2a77`、child `dd92c629-b5e7-419f-98da-f9ca1f08046e`。候选冷summary不再报undefined.reviews，显示原计划及“规划已完成”；刷新后原child三回合和summary仍可读。API返回ready/completed，不使用受控错误cache；2journal逐项hash保持，Agent创建0，模型继续0。

临时导航等待目录ready后公开openSession，summary由保存布局恢复。首次导航太早未稳定选择；默认空白复用仍产生no agent factory警告。修正只在临时导航，不证明该宿主导航警告已修复；没有加载工厂、新建Planner或伪造旧ephemeral线程。真实cold UI过渡与6项确定性通知回归分别记录，未将其扩大为正式provider故障验收。

## 清理与当前交付链

候选原2实例树按birth退出确认，命名浏览器dsh-cold87关闭。安全截图/回执在`output/playwright/cold-history-20261009/`；仓库外第87轮保留RED/GREEN、源码、API/journal审计。

第84轮原runner49424于11:18:36结束exit0，verify/release各1490/1490、host/11恢复/diff通过。先冻结217build并受控加载该版本，新formalPID53640/birthKey`win32:134359906628432740`，认证HTTP200；原11实例树退出，414会话身份、111workflow、119queue及重新捕获的429会话文件全量哈希前后一致，build/27模块偏差0。

随后合入本次client和6项测试。新完整门禁/受控加载尚未完成，不复用1490项通过作为1496放行；正式服务暂仍第84轮已验收版本。未commit/push/publish，未验证真实provider故障/费用或完整AgentLoop组合。

## 唯一完整门禁

312份代码/测试/脚本及发布输入、同数原字节副本冻结，manifest SHA256`84CC634FB5BDF2F84346D2623AC99E6DF01C3CEC9C11474D6C7FEAC97DD516F4`。11:56唯一runnerPID44428/birthKey`win32:134359917692160250`启动，gate目录`final-gates-06774d99-e29c-46c5-a9f3-f2b581856f67`；完整测试预期1496（1490+6），依次verify/release/host/host-recovery/diff。

主client与已验证候选在归一CRLF后逐字一致，未复制测试导航shim到产品。首个原runner观察确认仍活、verify进入测试，312input hash偏差0，尚无终态。正式只读414会话身份、111workflow、119queue及运行/等待/lease状态保持；本次完整结果及受控重载仍待完成。

## 完整verify终态

原runner44428的summary确认verify exit0，1496/1496，fail/cancelled/skipped/TODO及异步警告0，961.65秒；原日志最终计数相同。原runner继续release，不重开已完成测试；其后host/host-recovery/diff及当前正式加载均尚未完成，不能将verify或第84轮1490结果当作整体放行。

## 原实例加载守卫准备

9份仓库外加载/审计脚本绑定本轮312/217/1496、source SHA与原formal PID53640/birthKey`win32:134359906628432740`。3份PowerShell语法解析错误0，实际服务检查补充LOADING_PROJECTION、缺失getter保护及加载文字；不以旧client选Reviewer代码证明本次新fix。

原release仍运行时，执行实际controlled-reload守卫：exit1，`Original gate is incomplete: release`。随后确认实际current baseline、原tree和reload receipt均未写，原formal出生身份仍匹配。真正重载仍须等所有原门禁通过，再采集当前会话文件并复查工作/数据库状态；准备操作没有停止或创建正式实例。

## 最终门禁与正式交付

原runner44428于12:28:32真实结束exit0。verify1496/1496、961.65秒；release1496/1496、968.61秒；两者fail/cancelled/skipped/TODO及异步警告0。host4.27秒、host-recovery6.99秒，11场景persistedColdReplay及diff通过；doctor/pack通过且tarball清理。原完整最终计数独立解析，未重开原runner。

217份最终build manifest SHA256`ECD461927E008D576A48BD9F7FF2A73B43A6BAFBFEB65273671519EA9BDFF090`，source SHA保持。停止前重新确认真空闲并捕获429文件双读一致基线，原formal53640的11实例树退出；一次启动PID3436/birth `2026-10-09T12:29:01.1571740+08:00`/birthKey`win32:134359937411571740`。

首次post-reload审计调用过早，新auth-state尚未写，报ENOENT；此时原reload exec32076仍运行。继续观察同一新实例，原reload完成exit0、认证HTTP200后再执行只读比较，未新启动或重启。旧过早检查日志保留，不将它归为生产故障。

最终PID/birth/入口/3080监听匹配，414会话身份、111完整workflow、119完整queue及429当前文件路径/字节/hash前后一致，新增/缺失/修改0。原parent/corrupt child保持；217build、27模块偏差0，fatal/running/waiting/durable pending/lease0。

正式boot及实际响应包含冻结client、LOADING_PROJECTION、pending getter保护和加载状态；client SHA256`a37585430f1d38fd244ed55cbb21f70ffafc850a621fc19304a33f7cd036cb3f`，服务包装响应SHA256`bac788baa46e73ccb5a35fe1ae2edd7884df6144377ad111cf8d793ae0047a2e`。该读取没有Agent/model创建，不作为正式浏览器完整AgentLoop验收。候选UI和零模型history边界保持；未commit/push/publish，未恢复历史corrupt或丢失的ephemeral线程。
