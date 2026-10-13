# 第53轮研究：Windows独立进程缺席证明

## 结论

`kill(pid, 0)`的权限失败不等于进程存在，也不等于进程退出。若已保存完整原birth身份且当前身份查询成功但缺少PID，可再用独立的系统存在性查询消解未知状态。身份列表漏项本身不能成为缺席证明；查询失败或仍有匹配原实例时保持原清理标记。

## 固定来源

通过Agent Reach的GitHub/`gh`后端只读获取，固定源文件、版本及许可保存于仓库旁 `.codex-workflow-verification/fiftythird-20261007/github-sources/`，不复制实现或增加依赖。

| 来源 | 固定SHA | 版本 / 许可 | 参考机制 |
| --- | --- | --- | --- |
| libuv/libuv v1.x | `954c1d1887bfdb223b2b0dc2201199f938902e68` | 1.53.1 / MIT及文件内许可 | kill探针需OpenProcess权限，失败不能独自判存在 |
| giampaolo/psutil | `8dab8e999877f177b4768700fe9a8e5bfac97188` | 8.0.0 / BSD-3-Clause | handle探测失败后独立检查PID列表 |
| dotnet/dotnet-api-docs | `a0d86f0cd1cc10d4649ab0d80a968330d63437c6` | 官方Process API XML / CC-BY-4.0，代码示例MIT | GetProcessById的不存在异常及HasExited查询错误边界 |

[libuv kill](https://github.com/libuv/libuv/blob/954c1d1887bfdb223b2b0dc2201199f938902e68/src/win/process.c#L1463-L1488)打开PROCESS_TERMINATE/QUERY_INFORMATION/SYNCHRONIZE handle，除invalid-parameter外翻译系统错误。这个探针权限比单纯存在性判定更强，不能把EPERM当作“存活”。实际Node v24.14.0内置uv1.51.0，v1.x来源用于机制比较，不能冒称与bundled版本一致。

进一步固定bundled uv1.51.0提交 `5152db2cbfeb5582e9c27c5ea1dba2cd9e10759b`，保存其process.c和version.h；该版本的uv_kill同样使用PROCESS_TERMINATE权限，确认本机运行时也具有这条探针边界。

[psutil存在性检查](https://github.com/giampaolo/psutil/blob/8dab8e999877f177b4768700fe9a8e5bfac97188/psutil/arch/windows/proc_utils.c#L123-L143)使用有限查询权限，在handle或运行状态未知时查PID列表。本项目参考“独立存在性证明”，不增加psutil、不复制C实现。

Context7先resolve .NET，再查 `/dotnet/docs` 和Microsoft .NET集合；本次没有返回所需精确异常契约，未把无关GetPublishedProcesses示例当证明。固定[官方Process XML](https://github.com/dotnet/dotnet-api-docs/blob/a0d86f0cd1cc10d4649ab0d80a968330d63437c6/xml/System.Diagnostics/Process.xml#L1231-L1234)明示GetProcessById的ArgumentException表示PID未运行；HasExited无法读取退出码时的Win32Exception保持未知。实际Windows API由本地native fixture验证。

## 真实反馈与采用

第52轮保存的PID68600和后代104692已不在CIM/.NET查询中，但Node探针现在仍为EPERM。新回归真实启动并停止SDK，先确认原捕获实例退出，再只把这些PID的signal-zero观察改成EPERM；旧producer返回false，首先RED，日志 `process-absence-red.log`。这不是伪造真实PID复用或终止回执。

新增可选confirmAbsent独立端口。只有完整原birth和成功的当前身份查询后才检查遗漏PID；Windows使用已有PowerShell/.NET、4秒helper上限和严格完整响应校验。不存在异常或已打开handle的HasExited=true提供独立缺席证明；访问拒绝、部分/畸形响应、外国或重复PID均不能授权退出。原模型、线程或持久workflow不被替换。

失去launcher后的descendant refresh同样只接受完整原证据，并在当前root不可采集时查独立缺席；原PID已复用则继续按birth隔离，不接管新实例后代。

后续收窄refresh的依赖：先批量取得独立缺席证明，只对尚未确定不存在的原root运行census；不要求已经确认缺席的root再提供后代列表。直接边界回归首先RED，修复后13项新case与7项refresh合计20/20通过。首次完整链的一次native refresh未知结果未能在有界8次重复中稳定复现，其具体原因仍未证实；日志与失败链完整保留，不宣称已制造真实PID复用。

新12项native/边界通过，补充SQLite原标记确认后12项再次通过；live和denied守卫保持，retired才确认。旧68项相关控制保持。真实历史PID68600现在仍EPERM，但源码的whole-tree proof和refresh成功且原身份未改，结果 `historical-native-absence.json`，没有信号或模型调用。

全量门禁与正式加载见[第53轮记录](../iterations/2026-10-07-fiftythird-native-absence-proof.md)。此证据不包括真实OS PID复用、provider/Token费用/浏览器或Linux实机验收；Linux没有这项Windows fallback。
