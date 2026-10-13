# 第60轮研究：重试等待后的截止检查

状态：第60轮已验收加载。真实逻辑RED已修复，14项定向及163项完整局部控制、真实CLI通过；首轮完整verify1301/1303失败证据保留，修正原配置下的时间模拟后2/2及64项控制通过。最终verify/release各1303/1303、0异步警告，包审计、host加载/恢复与diff通过；正式DSH受控重载为PID129228，数据身份与完整记录保持。

## 缺陷与参考范围

共享控制重试、App Server可读回合和CLI重试原来只检查预计等待是否超预算。50毫秒预算，10毫秒等待实际唤醒到210毫秒时，仍启动第二次操作。直接可控时钟探针确定RED；完整14项新增控制旧代码9失败5通过，原同一截止时间与取消原因语义未获保护。

Node定时器不是准确唤醒保证。Context7先resolve Node，查询官方v24 timers：callback可能晚于指定delay，精确时刻和顺序没有保证。通过Agent Reach的GitHub/gh后端另存固定源码及许可：

| 来源 | 固定提交 / 许可 | 核对机制与限制 |
| --- | --- | --- |
| sindresorhus/p-retry 8.0.1 | `1472907affe8d6107aba5884abc36d6361b3042e` / MIT | 单调performance时钟、异步失败策略回调后重算剩余时间、取消优先；该固定版本的delay后没有时间检查，不把它当完整等待后实现 |
| nodejs/node 24.14.0 | `f657bb8ed86365ff3fdbe32e27563e778b41486a` / 项目许可 | `doc/api/timers.md`的setTimeout明确不保证准确唤醒时间 |

[p-retry固定实现](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js)、[固定测试](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/test.js)、[Node timers](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/timers.md)。5份固定source的Git blob与本地原始字节全部一致，SHA256、仓库、提交及路径清单位于本轮 `github-sources/fixed-source-index.json`；许可副本保留。

## 本项目采用

采用异步边界后重新接纳的原则，并明确补齐本项目实际等待后的检查。先抛原caller取消，再比较同一deadline：共享控制抛原TransientRetryExhaustedError，attempts只计已执行操作、lastError保留原对象；可读回合及CLI直接返回最后一个真实transient结果，由原调用者保持retryable语义。预算内下次操作仍沿用原线程。

本次沿用现有now注入和Date.now默认，没有把p-retry的整个调度器或单调时钟迁移过来；没有增加依赖。初始操作允许budget0，已开始操作由原timeout机制管理，workflow一次自动continuation保持独立权限。这里不宣称全任务总时长硬截止、系统时钟回拨保护或真实Token费用节省。

## 实际验证

14项新控制修复后全通过，5个完整文件163/163、86.60秒。首次typecheck指出测试少传必需detached参数，原日志保留；补齐后typecheck/diff及14项定向再次通过。真实CLI使用原dispatcher和实际Node backend：实际exit1、503原诊断保持，50毫秒预算在clock210时只启动1个进程，仍是retryable。

可控时钟复现逻辑，不冒称人工耗尽正式事件循环；真实CLI也仅本地受控provider替身。最终完整门禁与加载状态见[第60轮记录](../iterations/2026-10-08-sixtieth-retry-wakeup-deadline.md)。
