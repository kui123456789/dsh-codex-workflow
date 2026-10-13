# 第49轮：被拒绝的初始化保留原进程清理责任

状态：修复、完整门禁及正式重载已完成。正式DSH已加载第49轮PID101100，412sessions/111workflow及完整canonical记录保持；总体持续优化目标active，未commit/push/publish。下文保留阶段性反馈，最终结果见末节。

## 真实反馈

旧初始化catch先丢掉child，再只停止launcher，忽略后代。真实SDK/stdIO、launcher/backend回归首先RED，原始“invalid Codex initialize response”返回后treeExited=false，process1/model0/thread0。证据`%TEMP%/dsh-initialization-stop-tree-tbE4A9`，RED日志在持久`D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fortyninth-20261007/initialization-tree-red.log`。fixture最终只通过独有marker清理自身backend并证明原实例退出。

候选为launcher-only停止、提前丢弃process导致归属丢失、握手错误判断错误；现场原握手错误正确，代码同时存在前两个缺口。修复复用第48轮树retirement，没有修改握手成功契约。

## 固定研究与实现

[Playwright/Execa及Node文档研究](../research/github-rejected-initialization-retirement-patterns-2026-10-07.md)记录固定SHA、许可、manifest与限制；不复制实现或安装依赖。

- 初始化拒绝在原child仍拥有时调用原树retirement，清理失败保留屏障但不替换原始握手错误。
- 未取得OS PID的真实spawn失败不制造process清理记录；launcher已丢失且无tree证据时保留未知，不允许后继bootstrap。
- 明确标记已rejected的initializer，后来的启动先等其清理及结算，不加入旧失败执行。
- 原有观察者继续收到其握手错误或取消原因，模型未被运行，清理不会重建旧ephemeral工作流。

并发race先RED，后来明确元数据请求收到旧“invalid initialize”错误；日志`initialization-race-red.log`保留。修正rejected标记后GREEN，全部五个原生场景通过。

## 验收与资料保留

native场景为拒绝、取消、实际终止helper拒绝后原树重试、launcher先丢失且不能补造树、新请求在拒绝清理期间竞争。所有模型请求为0；明确恢复成功后只创建一个新metadata源线程。launcher-lost场景保持未知并拒绝新启动，不冒称SDK已自动清掉未观察的backend；fixture只用独有marker作最终自身清理。

最终相关96/96通过，91.45秒，日志`initialization-final-target.log`；typecheck/diff通过。SDK源码SHA256 `FB2C97327C05D36292C7FE348D4A40CB063312F91D09C82CD2224643A11BCE5F`。原业务assertion、RPC及场景预算未放宽。

本轮baseline位于持久目录的`baseline/`，365份源码/测试/文档，依赖目录0；研究、日志、freeze及门禁均保存在同一持久目录，敏感认证state及formal stdout仍只在TEMP，不输出或复制。历史corrupt和canonical记录、profile/provider/凭据保持。当前证据没有覆盖真实provider/Token计费/浏览器，Linux pidfd没有在WSL运行。

完整链为verify、连续两次release、host、host-recovery及diff；原进程同句柄持续结算，最终freeze一致及正式idle后才重载。后续新增会话按现场快照保留，不使用旧数量覆盖。

## 完整门禁已启动

门禁目录位于上述持久目录的`final-gates-8d89f6a8-ac29-46c4-ad35-7289fa0df162/`。verify1219/1219、exit0通过，543.00秒；release1同样1219/1219、exit0通过，557.46秒。五个新初始化原生case均通过；原exec2288已确认terminal exit0，全部结果见末节。文件并发2；256份源码/测试/脚本冻结到`source-freeze.json`，每项门禁前后检查原freeze，场景assertion/期限保持。受控重载按六项完整门禁、源码/最终build freeze、原PID105628及已知birth/idle执行；语法检查0错误。未因观测等待到期重新启动检查。

## 最终门禁与正式运行

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1219/1219，exit0 | 543.00秒 |
| `pnpm release:check` 第一次 | 1219/1219，exit0 | 557.46秒 |
| `pnpm release:check` 第二次 | 1219/1219，exit0 | 546.51秒 |
| `pnpm host:check` | exit0 | 4.86秒 |
| `pnpm host:recovery:check` | exit0 | 7.82秒 |
| `git diff --check` | exit0 | 已记录 |

三个全量运行失败/取消/跳过/异步警告0；两个release离线doctor明确跳过5项真实连接检查，pack audit通过且临时tarball清理完成。所有完整日志及summary保存在本轮持久门禁目录，原exec2288结算exit0后才重载，未重复已完成检查。256份原freeze前后匹配0偏差；SDK源码仍`FB2C97327C05D36292C7FE348D4A40CB063312F91D09C82CD2224643A11BCE5F`。

重载前现场为412sessions、available0/running0/waiting0、111workflow，原parent及历史child存在。helper核对原PID105628与已知birth、六项完整门禁、217份最终build freeze及唯一listener后，以已打开handle/birth方式清理捕获原树11个实例，独立证明退出，再启动PID101100。新birth为`2026-10-07T13:46:37.6677690+08:00`；参数保持`web --host 127.0.0.1 --port 3080 --no-open`，认证exchange303/authenticated=true/health200，唯一listener为127.0.0.1:3080。

重载后412sessions及排序会话ID哈希`579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持；111workflow完整SQL新配方哈希仍`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`，原parent/child保持，running0/waiting0。217份冻结build及receipt中25个关键模块hash全部一致，stderr fatal0。`lib/app-server.js` SHA256 `C636B5800DDAEE516FBC27E34E57768B30FB46BF004353FB3D317040CA178ECB`；workflow模块保持第48轮build。

formal-before/after、完整SQL hash配方、会话ID hash、原树证据、reload-receipt及formal-verification均在持久本轮目录。认证state/formal stdout仍仅在TEMP，未输出或复制为证据。profile/provider/凭据未改，历史corrupt或丢失原进程的ephemeral会话未复建，未commit/push/publish。

host验收为已安装DSH服务、真实SDK/stdIO和本地合成上游，新增Windows launcher/backend场景实际运行；未声称真实provider故障、Token计费、浏览器交互或真实CLI writer锁验收，Linux pidfd未在WSL执行。launcher-lost无法取得tree的场景仍明确未知并拒绝新bootstrap，fixture只用独有marker作自身最终清理。第49轮落地，总体持续优化目标保持active。
