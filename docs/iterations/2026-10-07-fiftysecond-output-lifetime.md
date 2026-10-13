# 第52轮：原stdout失效后禁用RPC并保留清理责任

状态：本轮生产修复、完整门禁及正式重载完成。正式DSH PID110780已加载第52轮，412sessions/111workflows与完整canonical记录保持。下文保留真实反馈，最终结果见末节。总体持续优化目标active，未commit/push/publish。

## 现场与反馈

上一轮为已落地并通过正式验证的进展；本轮再读正式PID73204，第51轮412sessions/111workflows、available0/running0/waiting0，完整canonical/session identity hash及原parent/历史corrupt child保持。仓库HEAD仍abb6174，既有dirty工作保留。

先尝试fixture输出端stdout.end/fd1/native handle关闭，没有观测到Windows父端EOF，不算缺陷复现。首个等待探针核对唯一fixture command、已打开process handle及CIM birth后终止自身进程，后续等待采用原15秒有界观测并正常清理自身；各日志保留。

有效RED通过SDK已持有的原Socket `.destroy()`，backend实际持有RPC且仍存活，未伪造事件或替换SDK方法。原观察者未结算、pending1、available=true。日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftysecond-20261007/output-socket-close-red.log`，现场 `%TEMP%/dsh-output-close-OKNhBm/output-result.json`。

原因候选是未监听读关闭、可用性只看OS存活和缺少首个通道错误归属，代码及真实Socket反馈均支持。新增原process outputFailure、读取/Interface错误和end/close观测，结算原观察者、禁用RPC但保留物理child给stop。通道失败不能匹配暂时性stream错误去继续模型。模型回合和待定receipt保持原清理类型。

## 研究与验证

[固定VS Code/MCP研究](../research/github-stdio-output-lifetime-patterns-2026-10-07.md)记录源SHA、manifest、许可与机制限制，Context7查询Node事件边界。没有复制实现或增加依赖；376份baseline和所有日志位于本轮持久目录，依赖目录0。

首个即时处理版本触发stderr exit-prefix回归；新增无错误关闭100ms原exit事件顺序窗口，真实exit保留原错误。显式读取错误直接处理，旧stderr断言和场景预算不变。4项Socket/stderr组合GREEN，16.44秒，真实旧pipe65536字节/late1/current prefix保持、old marker=false。

五个新场景GREEN，19.35秒，closed/read-error/active-turn/pending-start/retired-error。首因保持；模型/receipt只清理不续跑，不bootstrap；已知回合保留未确认的原pair，未知receipt不造turn。原进程在传输失败时仍活，stop后才证明退出。typecheck/diff已通过，关联控制在原句柄中执行。

完整verify、连续两次release、host、host-recovery和diff通过、源/build freeze一致且正式idle后才重载。profile/provider/凭据、canonical与历史corrupt保持，认证state/formal stdout仅TEMP，不输出内容。没有commit/push/publish；当前证据不是provider自然EOF/真实Token费用/浏览器/Linux实机验收。

关联控制101/101、exit0，213.53秒，失败/取消/跳过0，原stderr/protocol/stdio/未知回执/初始化/停止/模型超时/恢复资格通过。259份源码/测试/脚本冻结，每项完整门禁前后校验；文件并发2，原场景预算保持。完整链按verify、连续release两次、host、host-recovery、diff执行，观测超时不重新启动运行中的句柄。

## 完整门禁进行中

目录 `final-gates-6f35611e-c5d5-4b91-ab53-34784d94d592/`，原exec98837持续结算。verify1241/1241、exit0，958.53秒，失败/取消/跳过/异步警告0；release两次及host尚在执行。SDK源码SHA256 `8014D4FBC6131574B3B3EDDB0359EF1D53B9CD02CCBB77F5CA8B239D56A6C5AC`，transient源码SHA256 `EFD2BD4ACED87AE2FBEF1CBDA63047B5DD9A7A6B48157353656B5581658130DE`。

重载helper核对六项最终门禁、原PID73204及birth `2026-10-07T16:40:08.9685320+08:00`、源/build freeze和现场idle，当前尚未正式重载。

release第一次1241/1241、exit0，971.74秒，失败/取消/跳过/异步警告0；offline doctor明确跳过5项真实连接检查、pack audit通过、临时tarball清理。第二次仍在原exec98837运行。

## 最终完整门禁和正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1241/1241，exit0 | 958.53秒 |
| `pnpm release:check` 第一次 | 1241/1241，exit0 | 971.74秒 |
| `pnpm release:check` 第二次 | 1241/1241，exit0 | 972.18秒 |
| `pnpm host:check` | exit0 | 4.83秒 |
| `pnpm host:recovery:check` | exit0 | 8.05秒 |
| `git diff --check` | exit0 | 已记录 |

最终三个全量运行失败/取消/跳过/异步警告0；两次release离线doctor明确跳过5项真实连接检查，pack audit通过，临时tarball已清理。原exec98837确认terminal exit0后才重载，没有因观测超时重启门禁。259份源freeze前后匹配，217份最终build冻结，场景预算和已有业务断言保持。

受控reload核对原PID73204及已知birth、六项完整门禁、源/build freeze及唯一listener，现场412sessions、available0/running0/waiting0、111workflows。以原handle/birth安全清理捕获原树11个实例并独立确认退出后，只启动一次PID110780。

新birth `2026-10-07T17:47:49.5038630+08:00`；入口、工作目录和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303/authenticated=true，health200，唯一127.0.0.1:3080 listener匹配；217份build、receipt中27个关键模块hash0偏差，stderr fatal0。

412sessions排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持，111workflow完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent与历史corrupt child保持，running0/waiting0。

`lib/app-server.js` SHA256 `48F23EBF09F6C64CAF353B3291CBFD6A6D409AA612068F466E7E2F983189E43E`，`lib/transient-retry.js` SHA256 `119B33CE46A366BBE18FFC85DE7566CA2B8894F58DD4AC7D611C8295E8B9E169`。formal-before/after、原树证据、reload-receipt和formal-verification位于本轮持久目录；认证state/formal stdout仅TEMP，未输出内容。

没有修改profile/provider/凭据、复建丢失的ephemeral线程或替换历史corrupt子会话，没有commit/push/publish。host为已安装DSH服务、真实SDK/stdIO和本地合成上游；Windows原Socket读取关闭/错误实测，不声称输出端自然EOF探针成功或真实provider故障/Token计费/浏览器/Linux pidfd验收。本轮落地，总体持续优化目标保持active。

## 失败fixture的附加只读核查

即时输出处理版本失败的三个stderr目录保存了10个原实例身份。复查时当前CIM无这10个PID，`.NET GetProcessById`均报告不存在，记录 `failed-stderr-native-exit.json`。未向别的实例发信号。原SDK辅助proof曾报告unconfirmed；后续单独Node probe显示9个ESRCH、PID68600为EPERM，结果 `failed-stderr-kill-zero.mjs` 可重读。EPERM不是SDK退出证据，保留其未知判定，没有修改probe或放宽证明规则；这与正式原树11实例已独立确认退出的结果分开记录。
