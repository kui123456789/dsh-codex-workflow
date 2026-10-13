# 第54轮：握手ACK后stdin故障不能发布ready

状态：本轮修复、最终完整门禁和正式重载完成。DSH PID106280已加载第54轮，412sessions/111workflows与完整canonical保持。下文保留阶段反馈，最终结果见末节。总体持续优化目标active，未commit/push/publish。

## 当前现场与实际反馈

上一轮已完成、完整验收并正式加载，是实际进展。再读第53轮PID112192、birth `2026-10-07T19:27:33.2946030+08:00`，412sessions/111workflows、available0/running0/waiting0和完整canonical/session hash保持，原parent及历史corrupt child存在。HEAD仍abb6174，既有dirty修改保留。

真实stdin Socket在initialize ACK之后、初始process census尚未结束时destroy(error)，旧SDK返回ready，没有错误。RED为 `Broken original stdin must reject the shared startup instead of reporting ready`，日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftyfourth-20261007/initialization-input-red.log`，现场 `%TEMP%/dsh-initialize-input-failure-kXkTPi/input-result.json`。fixture backend保持运行，未伪造事件或修改SDK方法，thread/model均0；最后stop证明原实例退出。

候选为stdin仅结算RPC、此时无pending和缺少首因记录；代码及native反馈支持这些条件。把stdout的故障记录扩展为共享transportFailures，原child首因只登记一次。stdin保存terminal prefix及真实cause；就绪前检查通道故障，初始化拒绝使用既有原树退休，资源退出与错误保存分离。

## 研究与控制

[固定Execa/MCP研究](../research/github-initialization-transport-failure-patterns-2026-10-07.md)保存当前SHA、manifest、许可与边界，Context7查询Node Writable/child生命周期。不复制实现、不加依赖。382份baseline和日志/固定源文件在本轮持久目录，依赖目录0；认证state/formal stdout仅TEMP，不输出内容。

首轮原stdout/stdio/stderr及新initialize组合12/12通过，23.38秒，原4MiB真实队列与65536字节旧pipe/current prefix控制保持。补充六模式native通过，15.01秒：initializing、joined、caller-abort、ready、first-cause、active-turn。后续stdout fault保留先前stdin cause；活跃原模型只接受一次，保留原pair及未确认process evidence，不能把本地failure作为远端结束证明。

初始化窗口由真实完成的本机census callback delivery gate固定，保证ACK已到但ready未发布；没有虚构birth或替换SDK方法。单个观察者取消保留其reason，另一个得到原physical cause；ready后health/thread拒绝同一首因，不bootstrap。typecheck/diff通过，关联控制正在原句柄中执行。

verify、连续两次release、host、host-recovery和diff全部通过，源/build freeze一致且正式idle后才重载。profile/provider/凭据、canonical/历史corrupt保持；未commit/push/publish。本地Socket/native服务证明，不声称真实provider故障、Token计费、浏览器或Linux实机验收。

相关104/104、exit0，188.89秒，失败/取消/跳过0，日志 `input-failure-controls.log`。261份源码/测试/脚本冻结，完整verify/连续release/host链每项前后检查；文件并发2，原场景期限及业务断言保持。门禁原句柄观测超时不重启运行中的检查。

## 完整门禁进行中

目录 `final-gates-eb20986d-b0a7-4e59-b513-430ee1e7ae2e/`，原exec98010持续结算，预期完整1260项。SDK源码SHA256 `044694D331D06FC4AF793E912EC5E373FE0C9703F576BB1D914E87AFDBEC85B9`。受控reload已准备核对原PID112192/birth、六项最终门禁、源/build freeze及正式idle，当前没有重载。

verify1260/1260、exit0，1030.60秒，失败/取消/跳过/异步警告0；连续release和host仍在原exec98010执行。源码freeze前后保持，正式仍为第53轮，尚未重载。

release第一次1260/1260、exit0，1077.40秒，失败/取消/跳过/异步警告0；offline doctor明确跳过5项真实连接检查，pack audit与临时包清理通过。第二次继续原exec98010，未正式重载。

## 最终完整門禁及正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1260/1260，exit0 | 1030.60秒 |
| `pnpm release:check` 第一次 | 1260/1260，exit0 | 1077.40秒 |
| `pnpm release:check` 第二次 | 1260/1260，exit0 | 1108.33秒 |
| `pnpm host:check` | exit0 | 4.75秒 |
| `pnpm host:recovery:check` | exit0 | 7.92秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告0；两次release offline doctor明确跳过5项真实连接检查，pack audit通过，临时tarball清理。原exec98010明确terminal exit0后才放行，未因观测超时重复门禁。261份源freeze前后保持，217份build冻结；原业务断言和场景期限未放宽。

受控reload核对六项最终门禁、原PID112192及已知birth、源/build freeze与正式idle。现场412sessions、available0/running0/waiting0、111workflows。以已打开原handle和birth安全清理捕获原树11实例并独立确认退出后，只启动一次PID106280。新实例启动期间等待同一reload exec89031完成，不重复启动。

新birth `2026-10-07T20:53:52.2110370+08:00`，入口、工作目录和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`；认证exchange303/authenticated=true、health200，唯一127.0.0.1:3080 listener匹配。217份build与receipt的27个关键模块hash0偏差，stderr fatal0。

412sessions排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持。111workflow完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent及历史corrupt child存在，running0/waiting0。

`lib/app-server.js` SHA256 `45CC811FF924511D4572D5218097CE8B5CCE0D132D9A54613DC7D5F7E1B6666F`。formal-before/after、原树证据、reload-receipt和formal-verification保存本轮持久目录，认证state/formal stdout仅TEMP，未输出内容。未修改profile/provider/凭据，未复建丢失ephemeral或替换历史corrupt，未commit/push/publish。

host采用已安装DSH服务、实际SDK/stdIO与本地合成上游。实际stdin Socket错误、真实native census回调交付和原树退休在Windows实测；没有声称provider自然EPIPE/真实Token费用/浏览器/Linux pidfd实机验收。原回合的本地waiter失败仍未冒称远端结束；物理清理仅由原树证明。本轮落地，总体持续优化目标保持active。
