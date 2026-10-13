# 原进程出生身份与 Windows HANDLE：退出确认研究

日期：2026-10-06。范围：iteration 39，一手源码与官方文档研究；为后续本地验证提供依据，不表示生产代码已采用这些模式。

## 结论与证据范围

数值 PID 只能定位查询当时占用该编号的进程，不能单独标识先前启动的实例。可以借鉴 psutil 的 `(pid, creationTime)` 比较，但出生时间缺失、查询被拒绝或采样不一致必须保留 `unknown`，不能直接认定原实例已退出，也不能把当前进程认作原实例。

Windows 创建进程得到的 `hProcess` 对应创建时的进程对象。持有该原始 HANDLE 可在有效生命周期内针对该对象查询或等待。稍后按 PID 调用 `OpenProcess` 得到的 HANDLE，需要与启动时捕获的出生身份比较；持久化一个数值 HANDLE 或裸 PID 都不能在插件重启后恢复这种对象身份。

这些是设计与验证依据，**不是 iteration 38 失败由 PID 复用造成的证据**。本研究不证明历史 `corrupt` DSH 子会话可恢复，不引入依赖、不实施原生 HANDLE 迁移，不修改 provider/profile/凭据或正式 DSH PID 86052。

## 来源与许可证

实际研究仅使用以下两组一手来源，均固定到提交；源码与官方测试已读取，外部测试未执行。

| 来源 | 固定版本 | 用途与许可证 |
| --- | --- | --- |
| [giampaolo/psutil](https://github.com/giampaolo/psutil/tree/8dab8e999877f177b4768700fe9a8e5bfac97188) | `8dab8e999877f177b4768700fe9a8e5bfac97188`；2026-10-06T06:38:40Z；`Doc: fix usability styles` | PID/出生身份、存活查询、父子遍历与测试；[BSD 3-Clause](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/LICENSE) |
| [MicrosoftDocs/sdk-api](https://github.com/MicrosoftDocs/sdk-api/tree/c12073e417d5780fe796278ada21b90cef1b0568) | `c12073e417d5780fe796278ada21b90cef1b0568`；2026-09-30T17:32:04Z；`fix link inconsistency (#2159)` | Windows 官方 API 文档；[CC-BY-4.0](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/LICENSE)，不是 MIT |

TEMP 保存原文文件与两份 LICENSE。Context7 已按 resolve → query 查询 psutil 与 Win32 API；Win32 检索对具体函数覆盖不足，因此下述 API 结论以固定的 Microsoft 官方原文为依据。未扩展到第三方文章或另一个实际研究的仓库。

## psutil：实例身份与保守边界

- [`_get_ident`, `psutil/__init__.py:468–511`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L468-L511) 使用 PID 加创建时间。Windows 用 `create_time(fast_only=True)`；权限拒绝时可能无法取得时间。Linux/NetBSD/macOS 用启动以来的单调时间；部分平台因时钟稳定性不可靠停用出生身份检查。源码明确 Linux 约 0.01 秒精度存在竞态，不能宣称该方法绝对无碰撞。
- [`_cmp_idents`, `:545–564`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L545-L564) 将缺失/零创建时间返回为 `unknown`。psutil 的相等比较仅排除 `different`，所以它的 `True` 不能直接作为本项目“出生身份已确认相同”的依据。
- [`is_running`, `:763–790`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L763-L790) 构造新的 `Process(pid)` 比较身份；确定出生时间不同则标记复用并返回 `False`，出生未知仍可返回 `True`。`pid_exists` 只说明数字存在；遍历缓存也不替代显式实例校验。
- [`children`, `:1125–1197`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/__init__.py#L1125-L1197) 先检查根实例，再读取 PPID 图与新的根创建时间，并排除早于根创建的候选后代。递归遍历有 `seen` 防止采样期间复用形成环；这里对照的是根创建时间，不是每条父子边都完成原子身份验证。
- 同一文档明确：中间进程消失会失去通往其后代的关系。当前扫描结果为空，不等价于先前捕获的所有原实例后代已退出。

### 官方测试提供了什么证据

| 测试 | 证据 | 局限 |
| --- | --- | --- |
| [`test_reused_pid`, `tests/test_process.py:1561–1600`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/tests/test_process.py#L1561-L1600) | 存活判断返回 False，缓存刷新，修改/终止与亲属查询拒绝旧身份 | 启动真实子进程，但通过改写 `_ident` 模拟出生不匹配，不是操作系统真实复用 PID |
| [`test_reused_pid_with_null_ctime`, `:1602–1621`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/tests/test_process.py#L1602-L1621) | 原或新出生缺失/零不被算作复用，仍可能 `is_running=True` | 支持“未知不能伪装成退出/相同”的本项目边界；不能照抄布尔值作为身份确认 |
| [`test_parent_mocked_ctime`, `:1087–1097`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/tests/test_process.py#L1087-L1097) 与 [`test_children_mocked_ctime`, `:1129–1151`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/tests/test_process.py#L1129-L1151) | 修改缓存创建时间后，亲属查询使用新时间 | 缓存刷新证据，不保证整个树快照原子一致 |
| [`test_children_recursive`, `:1153–1164`](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/tests/test_process.py#L1153-L1164) | 真实子/孙进程；中间子进程退出后，根无法再枚举孙进程 | 空树不能独立证明全部原后代已退出 |

## Windows：原对象 HANDLE 与创建时间

以下链接均为 MicrosoftDocs 固定提交下的官方文档。

- [`PROCESS_INFORMATION:63–81`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/processthreadsapi/ns-processthreadsapi-process_information.md#L63-L81)：`hProcess` 指向新创建的进程对象；PID 有效到全部进程 HANDLE 关闭且对象释放，此后可以复用。不能把“进程退出”表述为“PID 立即可复用”。用完应关闭 HANDLE；关闭后数值本身不再是可用能力。
- [`GetProcessTimes:69–79`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-getprocesstimes.md#L69-L79)：对指定 HANDLE 查询，需要 `PROCESS_QUERY_INFORMATION` 或 `PROCESS_QUERY_LIMITED_INFORMATION`。[`103–105`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-getprocesstimes.md#L103-L105) 说明 FILETIME 是两个 32 位合成的 64 位 100ns 计数，起点为 1601 UTC。若选此路径，持久化表示必须保留精度，例如十进制字符串/BigInt；不能未经论证降为 JS Number 或毫秒后声称完全相同。
- [`WaitForSingleObject:67–81`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/synchapi/nf-synchapi-waitforsingleobject.md#L67-L81)：等待对象 HANDLE，需要 `SYNCHRONIZE`；超时 0 立即返回；等待期间关闭 HANDLE 属未定义行为。[`112–143`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/synchapi/nf-synchapi-waitforsingleobject.md#L112-L143) 区分对象已触发、超时未触发、失败需读 GetLastError；[`156–169`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/synchapi/nf-synchapi-waitforsingleobject.md#L156-L169) 将进程列为支持的对象。不能把 `WAIT_FAILED` 当作原对象已退出。
- [`OpenProcess:90–103`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-openprocess.md#L90-L103)：成功返回指定进程的 HANDLE，使用完应 CloseHandle。按裸 PID 重新打开只能获得当前实例，应与原捕获出生身份比较后再操作；失败/权限拒绝保留未知，不通过启用调试权限绕过。
- [`GetExitCodeProcess:91–102`](https://github.com/MicrosoftDocs/sdk-api/blob/c12073e417d5780fe796278ada21b90cef1b0568/sdk-api-src/content/processthreadsapi/nf-processthreadsapi-getexitcodeprocess.md#L91-L102)：成功时返回指定对象的状态；259 `STILL_ACTIVE` 也可能被程序当退出码，因此单看这个值可能循环误判，不能替代对象身份与等待结果。

仅有 launcher 原 HANDLE 的退出证据不能证明 native descendants 全部退出。原 HANDLE 的所有权、等待和关闭需协调；它也不能作为可跨插件进程重启持久化的句柄。

## 本地 RED/对照验证目标

下表是验证目标，不是本仓库用例已实现或已通过的声明；本研究未执行这些探针。实际本地观察和验证结果应由执行方另行记录。确定性身份替身应标注“模拟复用”，真实系统进程探针应另行报告实际是否发生 PID 复用。

| 场景 | 应验证的行为 |
| --- | --- |
| 原 A 已退出，同一数字 PID 对应无关 B，出生不同 | 不将 B 计作 A 存活；不终止、不修改 B；若原树证据完整则准入恢复；仍有未知原成员时保持 guard |
| A launcher 退出但已捕获的原后代还活着 | 原后代阻止退出确认与新轮准入；父 ChildProcess 的 exit/close 不能直接释放该证据 |
| 捕获或复查出生失败、零值、权限拒绝 | 三态结果 unknown；不产生“已退出”/“同实例”假阳性 |
| 旧持久化记录只有 PID，当前同号仍存在 | 不能补采当前出生时间回填为“旧原实例出生”；保留未知/guard。全部旧候选数字明确不存在可按已有保守规则处理 |
| 采样 PPID 图时父实例变化、重复边或循环 | 拒绝不一致候选/保留未知，有界遍历；根前后身份稳定仍不是全树原子快照证明 |
| 中间父退出，当前扫描丢失孙进程 | 继续复查之前捕获的原后代身份，不能以空的新树取代旧集合并宣告清理完毕 |
| 相同出生身份仍活着，随后原实例退出 | 正确保留再释放同一 guard；仅清理确属原树的实例，清理结算一次 |
| 冷启动读到持久化 guard，或插件已重启 | 无原内存 HANDLE；使用可验证的旧出生信息，否则保持未知，不伪造会话/进程可恢复 |

## 对本仓库的最小决策边界

生产修改应先取得对应本地 RED 或无需修改的对照证据，再讨论统一捕获不可变出生身份、查询仍可能存活的原候选，以及明确 unknown 的退出判定。评审应覆盖 terminal guard、foreground 新审查准入、后台 Reviewer、私有/终止清理四条路径，普通 status 不因研究而新增 CIM 查询。

本文只提供模式与边界，不提前认定生产实现应如何修改。它不要求新增 psutil 依赖、改写进程管理为原生层、过滤 conhost、增加超时或重启/清理正式 DSH。
