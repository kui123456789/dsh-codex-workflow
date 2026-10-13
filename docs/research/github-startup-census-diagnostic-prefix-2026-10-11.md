# 保留原启动清单的诊断前缀

日期：2026-10-11；第110轮。完整门禁和加载结果见[迭代记录](../iterations/2026-10-11-hundredtenth-startup-census-diagnostics.md)。

## 查清启动观察为什么消失

第109轮将丢失进程后的刷新原因保留下来，但 `startProcess()`捕获初始树时没有观察者；随后刷新会覆盖最新诊断。因此启动查询退出13的原原因最终只剩 `original_identity_incomplete`。现有真实SDK回归改为要求 `query_failed`/exitCode13，首次RED0/1确认原因丢失。

另一回归实际创建launcher/backend，持有原CIM回调，独立捕获并比对出生身份；让原生SDK launcher退出后再交付原返回。原启动错误、PID-only fallback及禁止新线程均保持，但diagnostics为空，RED0/1。新增前缀后同场景GREEN1/1；三次调用均保留同一fallback和冻结观察，未接纳延迟返回的后代身份，原树最终退出、unhandled事件0。这里使用真实CIM结果，未模拟PID复用。

## 本项目采用方式

`startupDiagnostics`按原生 `ChildProcess`存一份冻结前缀。lost record保存针对该child的只读访问器；清理先等待原捕获完成，再拼接“原前缀 + 本次刷新”。前缀不从上一次组合结果读取，故多次清理不会累积历史刷新；经过成功刷新而保留了更丰富evidence的lost record也保留原前缀。

捕获完成时沿用原owner/exitCode/signalCode条件，失去原owner则追加 `owner_retired`，仍返回原PID-only证据。启动catch中的保守fallback直接附前缀，因为下次start先尝试idle retirement，未必到达lost cleanup。取消、stopped标志本身不被当作owner退役；不增加任何retirement等待startup完成的依赖，避免与startup catch已等待idle shutdown形成循环。

原始异常文本、birth值、命令、环境及stdio不进入诊断。原始启动错误优先；观察不是ownership或exit凭证，不改变预算、补读次数、模型重试和替代线程屏障。

```powershell
pnpm exec tsx --test test/startup-census-ownership.test.ts test/permanent-stop-process-exit.test.ts
```

## 固定一手来源与选择边界

按agent-reach GitHub/gh路线读取 [Execa result:132–175](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/return/result.js#L132-L175)，固定 `63ddae6aeb6934da06fdb3754647791e58cd87c3`、MIT。duration、termination、exitCode、signal及cause code独立保存，支持“诊断随原操作保留”的机制。本轮只采用脱敏结构化诊断；没有引入Execa，也没有采用其命令/cwd/stdio记录。原源码与license的Git blob SHA1、SHA256及长度核对后保存在checkout外第110轮证据目录。

[psutil identity:545–557](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L545-L557)，固定 `8dab8e999877f177b4768700fe9a8e5bfac97188`、BSD 3-Clause，仍作为未知身份不能当作已退出的边界依据；来源字节见第109轮研究证据。本轮没有移植其管理代码或改变本项目实例判定。

## 证据与限制

真实SDK组合12/12通过，含清单失败、launcher退出、刷新失败和终止失败；重复stop保留原startup原因一次。独立只读设计审查关注capture pending时的exit、取消/stop与fallback先于lost cleanup的分支。

退出若发生在初始捕获开始前，本前缀合法为空；本轮不能诊断此前阶段或反推历史自然CIM异常。普通retirement和fork诊断没有等待该前缀，不增加查询或扩大超时。真实provider、浏览器交互与Token账单不在本地故障注入验证范围。
