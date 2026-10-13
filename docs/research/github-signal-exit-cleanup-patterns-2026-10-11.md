# 已退出子进程的清理判断

状态：第101轮完整验收与正式加载完成。生产回归旧2/6、候选6/6；模型目录夹具的受控旧PID探针旧0/1、修正1/1，相关45项控制、typecheck/diff通过。修正gate verify/release各1673/1673、176份原生文件摘要、host/11恢复/diff通过；正式DSH PID61132健康HTTP200。

## 具体缺陷

在真实Node子进程收到SIGTERM并完成close后，`exitCode`为null、`signalCode`为SIGTERM。公开 `stopProcess()` 只检查exitCode，因而继续调用stdin.end，再请求SIGTERM和SIGKILL。退出等待函数已经正确识别signal，因此这次复现未发现等待超时的延迟；缺陷是已退出后的重复清理请求。

同一个实进程探针中，旧实现记录EOF一次、信号请求两次；修正候选均为0，模型请求0。Node原生kill使用ChildProcess handle，退出时该handle已清除；本轮没有宣称旧请求实际杀死了其他进程，也没有费用或性能百分比结论。

## 固定GitHub来源

| 来源 | 固定源码 | 采用的机制 |
| --- | --- | --- |
| Execa | [`kill-descendants.js`](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/terminate/kill-descendants.js) | `exitCode !== null || signalCode !== null`判断真正结束；Windows下已退出的进程不再以PID发树信号 |
| Execa | [`wait-stream.js`](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-stream.js) | 同样的双字段判断区分Node退出后的stdin清理和运行中的流失败 |
| Node v24.14.0 | [`child_process.md`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/child_process.md)、[`internal/child_process.js`](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js) | exit事件提供code或signal；`killed`仅为信号请求确认，handle在退出时关闭 |

通过agent-reach的GitHub/gh后端读取固定commit。以上源码与许可证共6份原字节核对长度、Git blob SHA1及SHA256；Execa为MIT，Node许可证原文也保留。Context7核对Node v24的exit/close与signalCode语义。没有执行下载源码或增加依赖。

## 本项目采用与验证

`process-transport.ts`将退出判断作为stop/wait共用的私有函数。stop在触碰stdin前先检查已退出状态，在每次等待后重新检查，只有仍活着的直接子进程才继续已有的有限升级。

六项回归覆盖已完成的数字/信号退出、stdin grace内的信号退出、真正的强制终止、仍存活但只收到killed确认的控制，以及正常EOF退出。额外调用路径控制覆盖永久停止、外部交接、输出管道关闭及原树清理，合计31/31。直接子进程退出仍由原有进程树身份/实际退出证明约束；本轮不改变模型重试或原线程恢复资格。

首次门禁的两项失败均在旧模型目录夹具的历史数字PID结束断言，六项生产回归全通过。失败瞬间没有出生时间，现场只能证明旧PID判断不足。新增探针以实际已退出的Node进程和只读PID存在模拟复现同一断言；修正保留原ChildProcess观察真实退出，不再依赖历史PID仍被全系统永久闲置。完整模型目录文件及其他生命周期控制合计45/45；没有修改生产恢复或模型目录策略。正式交付只包含transport JS及map，原失败证据、回滚文件、会话和配置保护均已封存。

