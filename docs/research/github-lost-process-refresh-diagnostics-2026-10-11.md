# 原进程丢失后的后代刷新诊断

日期：2026-10-11；第109轮。源码与定向回归已完成，完整门禁和正式加载结果另记于[迭代记录](../iterations/2026-10-11-hundredninth-lost-process-refresh-diagnostics.md)。

## 判断清理为什么被拒绝

原 launcher 退出后，SDK 只从出生身份仍匹配的已捕获后代刷新树。原实现正确拒绝未知身份，但多个 `undefined` 返回丢失原因；`cleanupLostProcesses()`也没有附加结构化诊断。刷新回归 RED 为2/10，真实 SDK 三场景 RED 为0/3；新增诊断后分别10/10、3/3。

| 刷新结果 | 固定诊断码 | 清理边界 |
| --- | --- | --- |
| 原证据不完整 | `original_identity_incomplete` | 禁止按当前 PID 补造旧出生身份 |
| 捕获不可用，且未独立证明原实例不存在 | `capture_unavailable` | 保留原记录；底层查询的脱敏原因一并保留 |
| 当前树缺少完整身份 | `current_identity_incomplete` | 不接纳部分后代证据 |
| 当前与原出生域不一致 | `birth_domain_mismatch` | 不推断原实例已退出 |
| 后代与已保留身份冲突 | `identity_conflict` | 不替换原身份 |
| 刷新完成 | `refreshed` | 仅生成新证据；仍独立检查原树退出 |

观察仅含验证过的 PID、固定码和单调时长；底层查询额外保留既有预算、数字退出码和白名单 errno/signal。出生值、异常文本、命令、环境及 stdio 不进入观察。数组、条目与错误属性不可变；同步抛错或异步拒绝的观察者不能改变证据。SDK仅保存本次清理尝试的诊断，重复清理不累积历史观察。

```powershell
pnpm exec tsx --test test/process-tree-refresh.test.ts test/permanent-stop-process-exit.test.ts
```

## 固定 GitHub 来源

通过 agent-reach 的 GitHub/gh 后端读取 [psutil](https://github.com/giampaolo/psutil/tree/8dab8e999877f177b4768700fe9a8e5bfac97188)，固定提交 `8dab8e999877f177b4768700fe9a8e5bfac97188`，BSD 3-Clause。源码与许可证保存于checkout外第109轮证据目录；Git blob SHA1、SHA256及字节长度已核对。未执行外部源码或新增依赖。

- [`_cmp_idents`:545–557](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L545-L557)区分 `same`、`different`、`unknown`。缺少创建时间不是复用证据；本项目用不同固定诊断保留拒绝原因。
- [`is_running`:763–787](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L763-L787)重新比较实例身份，未知身份仍不能证明退出。没有照抄其布尔值作为本项目退出凭证。
- [`children`:1125–1197](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L1125-L1197)说明中间父进程消失会丢失后代关系；空的新清单不能替代已保存的原树。

Context7按 resolve→query 核对 Node24 `execFile` 错误、退出与 stdio 关闭契约。底层 `query_terminated`继续只表示终止观察；未把它当作超时或原进程树退出证明。采用机制是“保留未知的具体原因”，没有移植 psutil 的进程管理实现。

## 验证与限制

真实 SDK 回归覆盖启动时缺失原清单、丢失 launcher 后查询失败、刷新成功后终止被拒绝。三者均保留同一 lost record；恢复查询后只清理原树，永久 stop 后仍拒绝启动，新增 model/fork 请求为0。独立缺失证明与 PID 复用测试保留原规则。

本轮不恢复已损坏的历史子会话，不推断历史自然 CIM 故障的原因；不更改模型 continuation、owner、WorkflowRecord、超时预算或替代进程准入。真实 provider、浏览器交互及 Token 账单不在本地故障注入的验证范围。
