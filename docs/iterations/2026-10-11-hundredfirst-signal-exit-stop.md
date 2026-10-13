# 第101轮：已退出子进程避免重复清理

状态：完整验收与正式加载完成。原gate PID38860/birth `win32:134361424737861900`真实exit0；verify/release各1673/1673，176份原生文件摘要，host、11恢复场景及diff通过。正式DSH从PID51296受控切换至PID61132，健康HTTP200并认证正常。

## 问题与来源

真实子进程SIGTERM退出后，`exitCode=null`、`signalCode=SIGTERM`。旧stop只检查exitCode，继续对已结束的对象调用EOF和两次kill。等待函数本身已经正确识别信号，复现没有整段超时等待；本轮修复目标是退出后的重复清理请求。

借鉴Execa的双字段退出判断，并核对Node v24.14.0的事件及handle生命周期。固定源码和许可证共6份原字节核对，详见[研究记录](../research/github-signal-exit-cleanup-patterns-2026-10-11.md)。没有增加依赖或执行外部代码。

## 改动与证据

- `process-transport.ts`的stop/wait共用私有退出判断；EOF前及等待后核对真实退出。
- 六项边界回归覆盖数字/信号完成、grace内退出、有限升级和killed确认仍存活的情况。
- README和CHANGELOG记录直接子进程与原树证明的边界。
- 真实探针：旧EOF1次/信号2次，候选均0；模型请求0。
- 新回归：旧2/6，候选6/6；调用路径控制31/31，失败/取消/跳过/TODO及异步警告0；typecheck/diff通过。

修正后完整门禁1673项、176文件、332输入通过，正式217份产物受保护。生产源/测试/README/CHANGELOG及模型目录夹具五份有效文件已备份并采用。直接子进程的killed标记仍不能确认整个原树停止，模型恢复预算及原child/thread保持策略沿用现有约束。

原失败门禁绑定为PID58996/`win32:134361411705872460`，证据 `isolated-pACTq7`，命令会话86311，1670/1672失败证据保留。修正门禁绑定为PID38860/`win32:134361424737861900`，证据 `isolated-8le4t3`，真实exit0；332份输入和217份正式产物内容/metadata核对偏差0。

该原gate真实exit1，176份原生摘要显示仅模型目录文件的两项结束检查失败，release/host未执行。结束断言只检查历史数字PID；失败现场未保留出生时间，不能将原因直接认定为PID复用。保留的fixture wire日志及随后OS查询显示相关PID都已不存在。修正夹具保存真实ChildProcess并以exitCode/signalCode确认结束，避免数字PID状态误判。

受控旧PID存在探针在实际原进程停止后触发相同断言：旧0/1、修正1/1。夹具捕获并保留匹配protocol和wire路径的真实ChildProcess，以其实际exitCode/signalCode及逐次启动账本证明退出，并在finally恢复spawn观察器。模型缓存、初始化和旧线程禁止换进程的业务断言保持；加入该探针后相关控制45/45、typecheck/diff通过。新门禁为 `isolated-8le4t3`，命令会话37897，实际PID/出生时间见本轮corrected-gate-binding。

只交付 `lib/infrastructure/process-transport.js` 及 sourcemap；重载前后415会话、430文件、111workflow和119queue哈希一致，指定session、原parent、历史corrupt child、取消marker及休眠inbox保留。7份profile/provider/凭据文件字节未变，served client与已测产物一致，stderr无fatal。未commit/push/publish；浏览器交互、真实provider故障和费用未宣称验收，持续优化目标active。

