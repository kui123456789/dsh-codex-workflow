# CLI已接纳操作跨阶段的取消首因

日期：2026-10-09。第71轮verify/release各1435/1435、host加载/恢复及diff通过，已冷启动加载到正式DSH，PID4448。原release/正式进程的中断记录及后台输出编码审计保留；会话和workflow数据保持。未增加依赖或修改公开Gateway参数。

## 本地实际RED

第70轮等待release期间发现：缓存reconcile已进入capture，caller先取消、再停止dispatcher。释放callback后没有模型请求（starts0/capture1），却把原caller Error替换为dispatcher is stopped。隔离probe连续两次退出1。下阶段withCancellation先检查全局stopped，遗漏它继承的是原操作仍托管的signal。

原Signal.any并未改写原因；原callback也一直被正确等待。20项回归中10失败、10个控制通过，失败集中在缓存/真实子进程成功输出后的caller、workflow、submission、默认DOMException及字符串原因先于stop。停止后的新请求、先stop后caller、身份变化、最终review callback和普通capture错误是原有正确控制。

## 固定源码比较

| 来源及固定提交 | 实际机制 | 本项目采用 |
| --- | --- | --- |
| [p-retry](https://github.com/sindresorhus/p-retry/tree/1472907affe8d6107aba5884abc36d6361b3042e)，MIT | index.js:233–249在异步input前后检查原signal，停止后续调用时保留已有reason | 使用原操作仍托管的signal作为阶段交接凭据；保留公开新请求的stopped准入规则。 |
| [Node v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)，核心MIT，完整许可见固定LICENSE | lib/internal/abort_controller.js:433–451中已aborted立即返回，并把原reason传播给dependent signal；any测试验证因果及对象引用 | 原因读取仍使用原signal，注册范围及workflow/submission必须匹配，不额外制造新原因。 |

通过agent-reach的GitHub/gh后端搜索与固定读取；Node annotated tag先解引用到实际commit。8份源码/测试/README/许可原字节、Git blob SHA1和SHA256核对，收据位于本轮github-sources/fixed-source-index.json。原先猜测any测试为.js收到404，目录查证实际为.mjs后读取固定文件。Context7的Node24官方文档确认any取触发取消的signal原因，重复取消细节以固定源码为准。

## 实现与边界

在现有pendingRuns保留原signal引用。公开操作、retry/run及原child准入共用assertAdmission：只有已取消signal仍由相同workflow/submission持有时，保留其reason；新/身份变化的请求经过原stopped门。取消交接始终拒绝，不放行模型。普通callback错误、首个终止、预算和回调责任保持。

修复后20/20、相关167/167、原probe通过，modelStarts0/capture1；非Error原因继续原fallback，DOMException/Error对象保持。10份负向actor目录保留。完整1435项门禁及正式加载状态见[第71轮记录](../iterations/2026-10-09-seventyfirst-cli-firstcause-handoff.md)。受控测试不代表正式provider自然故障、Token费用或浏览器UI。
