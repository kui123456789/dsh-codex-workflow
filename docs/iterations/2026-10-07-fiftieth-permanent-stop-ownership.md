# 第50轮：普通永久停止保留原后端责任

状态：本轮修复、全部门禁及正式重载完成。正式DSH PID44116已加载第50轮；412 sessions/111 workflows及完整canonical记录保持。下文保留阶段性反馈，最终结果见末节。总体持续优化目标 active，未commit/push/publish。

## 复现与修复

普通 SDK stop 只等待 launcher，没有 fork 时忽略 backend。真实 SDK/stdIO 回归首先 RED：process1/fork0/model0，stop 返回后原捕获树仍存活。日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftieth-20261007/permanent-stop-tree-red.log`；现场 `%TEMP%/dsh-permanent-stop-tree-6QLl2y/stop-result.json`。fixture 通过独有 marker 清理自己的残留并确认原实例退出。

候选是遗漏普通树、提前丢弃 child、仅等待 launcher。代码及现场支持这三项；握手、线程和模型均不是触发因素。[固定研究](../research/github-permanent-stop-ownership-patterns-2026-10-07.md)参考 Playwright/Execa 生命周期机制以及 Context7 Node 文档，没有引入实现或依赖。

`src/app-server.ts` 在丢弃 child 前登记普通树，退休专用 WeakMap 与 idle/初始化共用同一证据及关闭标记。stop 同步保持永久禁止启动，观察者仍及时结算；失败只重试原实例清理。已经永久停止接管的 initializer 不制造第二个未知退休记录。

## 验证与保护

五个原生 case GREEN，21.15秒：initialized、denied-then-retry、initializing、idle-collision、missing-census。断言一次启动/采集/EOF，fork/model 均0；丢失 census 保持未知，不在 launcher 退出后补造证据。Windows 原生执行；Linux pidfd 未实测。

typecheck/diff 已通过，既有场景预算和业务断言保持。368份 baseline 保存于同一持久目录 `baseline/`，依赖目录0。日志、研究、freeze 和最终门禁保存持久目录；认证 state/formal stdout 只在 TEMP，不输出内容。

修复期间正式 DSH PID101100仍为第49轮。只读核查412 sessions、available0/running0/waiting0、111 workflows，原parent/历史corrupt child存在；session hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`，workflow完整canonical hash `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。profile/provider/凭据和丢失的 ephemeral 原会话保持。

完整链要求 verify、连续两次 release、host、host-recovery 和 diff；只有源/build freeze 一致且正式服务没有运行/等待工作后才重载。没有 commit/push/publish。

## 完整门禁进行中

关联控制92/92通过，124.68秒，日志 `permanent-stop-controls.log`。257份源码/测试/脚本冻结到 `source-freeze.json`，SDK源码SHA256 `8B5B97BC8A8CCC40B79F986C4F7AD31AE602BDB16D07DFBA745E956A8F7BFD17`。每项检查前后核对同一freeze，文件并发2，原场景预算不变。

门禁保存在持久目录 `final-gates-a3a5300c-8226-4036-895d-71fe51f4efc6/`。verify1224/1224通过，exit0，712.15秒，失败/取消/跳过/异步警告0。连续release及host检查继续在原exec66265中结算；不得因为观测超时重新发起已在运行的检查。

release第一次1224/1224、exit0，715.95秒，失败/取消/跳过/异步警告0；第二次已经在原句柄中运行。第50轮还未正式重载，PID101100仍为第49轮运行实例。

## 最终门禁及正式运行

| 检查 | 最终结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1224/1224，exit0 | 712.15秒 |
| `pnpm release:check` 第一次 | 1224/1224，exit0 | 715.95秒 |
| `pnpm release:check` 第二次 | 1224/1224，exit0 | 719.50秒 |
| `pnpm host:check` | exit0 | 4.90秒 |
| `pnpm host:recovery:check` | exit0 | 7.76秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告均0；两个release离线doctor明确跳过5项真实连接检查，pack audit通过，临时tarball已清理。原exec66265确认terminal exit0之后才重载，没有因观测超时重新运行门禁。257份源freeze及217份最终build保持，源码SHA256见上文。

受控重载重新核对六项完整门禁、原PID101100及已知birth、唯一127.0.0.1:3080 listener、源/build freeze及现场idle。重载前412sessions、available0/running0/waiting0、111workflows；原parent与historical child均存在。以已打开handle和birth验证清理原树11个捕获实例，独立确认退出后只启动一次PID44116。

新birth `2026-10-07T15:05:27.5306550+08:00`，入口和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`；认证exchange303/authenticated=true，health200，唯一listener匹配。217份build及receipt的25个关键模块hash匹配，stderr fatal0。

重载后412sessions及session identity hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持；111workflows的完整SQL配方hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，原parent/历史child保持，running0/waiting0。`lib/app-server.js` SHA256 `0533C89728B901D199A01A5063CF07F350839E1B7CAE6F3B467EF4FF8DDC2DF4`。

formal-before/after、原树证据、reload-receipt和formal-verification保存在本轮持久目录；认证state/formal stdout仅在TEMP，未输出或复制内容。未修改profile/provider/凭据；未恢复丢失的ephemeral线程或替换历史corrupt子会话。

host验收采用已安装DSH服务、真实SDK/stdIO和本地合成上游；Windows普通launcher/backend回归实际执行。没有声称真实provider故障、Token费用、浏览器交互或Linux pidfd的实机验收。missing-census仍报告清理未知，fixture仅用独有marker最终清理自身backend。第50轮落地，总体持续优化目标保持active。
