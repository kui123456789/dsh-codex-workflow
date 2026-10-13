# 第109轮：原进程丢失后的刷新诊断

状态：完整隔离门禁通过，已按已有用户授权正式加载。

## 本轮修改

`refreshOriginalProcessTreeEvidence()`对原/当前身份缺失、捕获不可用、出生域不符及身份冲突发出固定脱敏诊断。SDK将它们附在原清理错误的冻结 `cleanupDiagnostics` 中，同时保留底层捕获观察。`refreshed`不代表原树已退出；旧身份、独立缺失证明、同线程继续及替代进程屏障保持。

## 证据

- 刷新回归：RED2/10，GREEN10/10；8项原失败均为诊断缺失。
- 真实SDK：RED0/3，GREEN3/3，原 launcher/后代真实创建；身份变化用确定性替身模拟，未声称操作系统实际复用PID。
- 相关刷新、捕获、独立缺失证明、永久停止及退役组合49/49通过，无取消、跳过或异步警告。
- 首次类型检查发现测试将Error传给接受string的分类器；修正测试为 `.message` 后通过，产品类型未放宽。失败日志保留。
- GitHub固定来源与采用边界见[研究记录](../research/github-lost-process-refresh-diagnostics-2026-10-11.md)。证据在 `../.codex-workflow-verification/hundredninth-20261011/`；保留所有历史失败、构建及回滚记录。

当前正式DSH原实例为PID72976、`win32:134361699135812890`。本轮开始时认证元数据读取成功：416会话、111workflow、119queue，已加载Agent为0，运行/等待/活跃租约为0。完整验收通过后按已有用户授权受控重启，保留全部持久化会话记录；最终数量与哈希以重载前后双查为准。

## 完整验收与加载

- 原门禁PID72328、`win32:134361722280409780`，tool session91132实际exit0；隔离目录`isolated-L1sSL2`。verify/release各1699/1699、179份原生文件摘要，无失败、取消、跳过、TODO及异步警告；host、11个恢复/冷回放场景、diff通过，离线doctor与包审计通过。
- 337份冻结输入及217份构建产物逐项核对；正式构建内容与metadata在门禁期间未变化。备份全部217份原产物，只部署实际变化的5份App Server/transport JavaScript、map及声明；不手改生成文件。
- 原正式PID72976的11个已捕获实例确认退出；新PID77536、`win32:134361738510130380`，认证HTTP200、监听与启动路径匹配。完整217份已部署产物哈希一致，fatal stderr匹配0。
- 416会话身份、431会话文件、111workflow、119queue及7份配置/凭据完全保持；会话文件增加、缺失和修改均0。原parent、历史corrupt child及新增空白会话保持；历史取消诊断marker和休眠inbox没有改写，未伪造旧ephemeral线程。
- 独立只读代码审查未发现身份屏障改变。核验helper原先按单行JSON解析宿主输出，检查实际pretty JSON格式后已修正；修正记录另存，未改变门禁输入或旧收据。

历史更正另记于`historical-gate-correction.json`：第107轮首次门禁`isolated-2OlXo9`实际通过，首次完整门禁失败属于第106轮；没有重写任何历史收据。本轮交付已完成，持续优化目标保持active。
