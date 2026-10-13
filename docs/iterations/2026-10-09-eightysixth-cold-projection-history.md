# 第86轮：v2历史回放与冷投影渲染诊断

状态：v2原生API历史回放通过，Agent创建0、原日志hash保持；冷summary界面未通过，发现pending/absent snapshot边界。仓库外最小候选3项通过，未合入冻结主源码。第84轮verify1490/1490通过，原release继续运行。

## 受控旧检查点

独立DSH_HOME、端口3104、PID47536/birthKey`win32:134359881872199880`。复制先前端口3103受控场景的2份原生日志及派生cache，不接触正式历史。缓存本来为v1/seq9/ready，在独立副本中把plan状态改为planning并删除processState，模拟过时折叠；没有修改原日志或源cache。此错误cache是明确的受控输入，不声称真实v1实现自然产生过这个错误状态。

临时插件仅注册实际v2投影；agent-loop关闭，没有Agent工厂、WorkflowManager、workflow工具或模型网关。只读API读取原parent及child：planStatus ready，parent10事件，原child有效descriptor/34事件/3回合。cached planning没有覆盖原日志完成状态。磁盘cache仍为v1，说明本次只读读取并不承诺重写cache，不能以文件版本号否定正确回放。

Runtime回执Agent创建0、模型网关/manager/工具均未安装；2份目标journal和2份原journal逐项hash一致，无新journal。恢复的是历史显示，不是已结束的ephemeral模型线程。

## 浏览器路径与失败

采用原生已保存summary布局。默认Workspace导航将只有插件事件的空白parent尝试复用为可运行Agent，报no agent factory；无实际创建，不把该配置拒绝当作模型故障。随后临时browser入口通过公开uiWorkspace.openSession导航原parent，原业务渲染代码保持；仍没有模型驱动。

该次真实summary冷加载报TypeError读取undefined.reviews。只读API兼容通过不能扩大为UI通过。真实console错误和加载限制保留，没有重建原Planner来掩盖问题。

## 最小确定性反馈循环

`cold-projection-render-probe.mjs`读取实际src/client.js，在真实插件注册/summary渲染接口模拟loading snapshot：

| 输入 | 原实现 | 仓库外候选 |
| --- | --- | --- |
| face存在但getSnapshot未返回 | TypeError reading reviews | 显式loading状态、不抛异常 |
| face未提供 | 每次read返回新对象，reference不稳定 | 固定空快照，reference稳定 |
| 已返回的空workflow | 正常“等待审查”控制 | 同样正常，未误显示loading |

原probe exit1，候选exit0，3/3。候选只在内存替换：稳定EMPTY_PROJECTION、读取pending时使用同一个fallback、明确“正在加载工作流状态”。没有改变主源码、测试输入或正式服务；候选尚需真实cold UI和loading→loaded订阅边界验证，不能把probe绿色声称生产修复已完成。

## 原门禁与清理

第84轮原runner49424/birthKey`win32:134359875955879220`的verify终态1490/1490、fail/cancelled/skipped/TODO及异步警告0、exit0，946.54秒；原release继续执行。新诊断不改变311份冻结输入，完整通过不证明未覆盖的冷renderer边界不存在。

隔离原2实例树已按birth确认退出，命名浏览器dsh-history86已关闭。证据位于仓库外`../.codex-workflow-verification/eightysixth-20261009/`，包含controlled stale cache、源cache副本、readonly API结果、runtime/journal审计和原RED/候选GREEN。正式实例保持PID36424；未改profile/provider/凭据、未创建替代workflow或commit/publish。
