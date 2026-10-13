# 第51轮：意外 launcher 退出后仍持有后端责任

状态：本轮生产修复、最终完整门禁及正式重载完成。DSH PID73204已加载第51轮，412sessions/111workflows及完整canonical记录保持。下文保留真实失败和阶段性反馈，最终结果见末节。总体持续优化目标active，未commit/push/publish。

## 复现与修复

上一轮为已完成并正式加载的进展：PID44116、第50轮完整门禁通过，412sessions/111workflows保持。本轮只读再次确认其idle、原parent/历史corrupt child及完整canonical记录。

真实普通 launcher/backend，创建一个source、无fork/model，再先终止launcher。旧SDK `stop()`成功返回，原backend仍存活。先前辅助计数断言掩盖主失败；把树退出断言置前后，精确RED为 `false !== true`，日志 `D:/工作文件/projict/dsh-cc/.codex-workflow-verification/fiftyfirst-20261007/lost-launcher-exit-red.log`，现场 `%TEMP%/dsh-permanent-stop-tree-VfeZQv/stop-result.json`。fixture用独有marker最终清理自身原实例。

原因是退出回调丢弃child，普通原实例无初始化身份记录，stop以“无child”当作完成。实现保留成功初始化身份和意外丢失资源，清理前只从birth匹配的存活backend扩展晚建后代，确认退出后才允许明确独立启动。正常退休仍采新树，不能拿初始化快照代替退休census。未知原身份不能补造，PID重用不能借用后代，永久stop保持禁止启动。

[固定研究](../research/github-unexpected-launcher-exit-ownership-patterns-2026-10-07.md)核对Playwright/Execa版本、SHA及许可，并查询Context7 Node生命周期文档；不复制实现或增加依赖。373份baseline及所有日志、源文件保存在本轮持久目录，依赖目录0。

## 验证反馈

首轮14项原生/数据边界GREEN，34.63秒；包括真实晚建child，初始化快照明确未含该child，而退出后的扩展清理将其实际结束。之后增加原生metadata后继、拒绝终止和启动census缺失，独立3项GREEN，32.33秒，fork/model均0。只有明确metadata后继允许第二个进程，旧ephemeral owner仍拒绝模型请求。

首轮关联控制出现6个idle回归，原日志 `lost-launcher-controls.log`完整保留。根因是身份采集尚未结束时idle timer已认为初始化完成；`isIdle`加入未完成初始化屏障。原9项idle/clarification/pin场景GREEN，26.14秒，未改场景期限或断言。最终组合正在 `lost-launcher-final-controls.log` 结算。

typecheck/diff通过。认证state/formal stdout仍仅在TEMP，不输出内容；profile/provider/凭据、canonical记录及历史corrupt子会话保持。全量门禁、连续两次release、host、host-recovery及diff全部通过且正式idle、源/build freeze一致后才允许重载。没有commit/push/publish。

最终组合139/139、exit0，261.54秒，失败/取消/跳过0；原10个native模式和7个扩展边界全部通过，旧SDK/初始化/stdio/fork/回执/模型目录/线程owner控制保持。258份源/测试/脚本freeze，每项完整门禁前后校验，文件并发2，场景期限不变。连续门禁仍按verify、两次release、host、host-recovery和diff顺序执行，原句柄观测超时不代表失败或许可重启。

## 首次完整门禁的实际失败

原exec75406结算exit1，verify1234/1236、2失败，928.97秒，取消/跳过/异步警告0。原目录 `final-gates-23e5b9a3-98d7-4dd9-85a5-a08e465e9542/` 完整保留，release未运行，正式服务仍为第50轮。

两个stderr场景的actor假设 `start()`会同步spawn后继，但清理屏障需要先等待原实例，actor在观察不存在的child时提前退出，外层看到缺失artifact。fixture改为等待真正的新child，并在清理屏障期间保留实际旧Readable缓冲，直到后继实际拥有transport才释放。原15秒场景期限、旧close/晚到OS字节/当前错误prefix及旧marker隔离断言均保持；另把actor exit0检查提前到读artifact之前，避免ENOENT掩盖主失败。

修复fixture后stderr3/3、exit0，16.14秒。两种current stderr模式都真实收到65536字节旧OS管道数据、late chunk1，public current prefix保持且旧marker=false；生产源码未改，typecheck/diff通过。更新原freeze中的两个fixture哈希后，从新门禁目录重跑完整链；这次重跑因已确认失败和修复，而非观测超时。

## 修复后的完整链

新目录 `final-gates-d0b5439f-1494-4f45-b5d4-c1d1aba03e56/`，原exec17090持续结算。verify1236/1236、exit0，942.61秒，失败/取消/跳过/异步警告0；release和host门禁尚在执行。SDK源码SHA256 `5625F1595E980F51A756D3AE7051D96A0B218C9246F57E3B2D7A1C2FFA8EFAEC`，process transport源码SHA256 `B61D7C597A793C9CF7F2A53764A1B7108D407871847FD09CBDAD408A0FA34711`。

失败stderr fixture的两个原树、共4个捕获实例已独立确认退出，不需再次终止；结果保存 `failed-stderr-original-exit.json`。正式状态再次只读确认412sessions/111workflows、available0/running0/waiting0和原完整hash保持，当前仍为第50轮PID44116。受控重载helper已更新为新完整链，绝不使用失败链放行。

release第一次1236/1236、exit0，948.94秒，失败/取消/跳过/异步警告0；离线doctor与pack audit通过。第二次release继续在原exec17090中运行，尚未正式重载。

## 最终结果与正式加载

| 检查 | 结果 | 用时 |
| --- | --- | --- |
| `pnpm verify` | 1236/1236，exit0 | 942.61秒 |
| `pnpm release:check` 第一次 | 1236/1236，exit0 | 948.94秒 |
| `pnpm release:check` 第二次 | 1236/1236，exit0 | 947.43秒 |
| `pnpm host:check` | exit0 | 4.99秒 |
| `pnpm host:recovery:check` | exit0 | 8.02秒 |
| `git diff --check` | exit0 | 已记录 |

最终三个全量运行失败/取消/跳过/异步警告0；两次release离线doctor明确跳过5项真实连接检查，pack audit通过，临时tarball清理完成。首轮失败目录保留，最终门禁在原exec17090 terminal exit0之后才重载。258份源freeze一致，217份最终build冻结；未放宽场景预算或业务断言。

受控reload重新核对六项完整门禁、原PID44116及birth `2026-10-07T15:05:27.5306550+08:00`、唯一listener、源/build freeze和正式idle。现场412sessions、available0/running0/waiting0、111workflows；先用原handle/birth安全清理捕获原树11个实例，独立证明退出后仅启动一次PID73204。

新birth `2026-10-07T16:40:08.9685320+08:00`；入口、工作目录和参数保持 `web --host 127.0.0.1 --port 3080 --no-open`。认证exchange303/authenticated=true，health200，唯一listener 127.0.0.1:3080匹配；217份build和receipt中的26个关键模块hash0偏差，stderr fatal0。

412sessions的排序身份hash `579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`保持。111workflow完整SQL配方 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id; JSON.stringify(rows)` hash仍 `289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`。原parent及历史corrupt child保持，running0/waiting0。

`lib/app-server.js` SHA256 `27108D2FB87516443E499F7532F51E413B91E977F5252E50FF8F336FD35B437E`；`lib/infrastructure/process-transport.js` SHA256 `C773B9751C0A58C4A9F001E7152C2045AB98C4C41202416E9AA2FD227B638936`。formal-before/after、原树证据、reload-receipt及formal-verification保存本轮持久目录；认证state/formal stdout仅在TEMP，未输出内容。

没有修改profile/provider/凭据或复建丢失ephemeral线程；没有commit/push/publish。host验收为已安装DSH服务、实际SDK/stdIO和本地合成上游。Windows原生launcher/backend和晚建child已实测；没有声称任意未来后代穷尽、真实provider故障、Token计费、浏览器或Linux pidfd实机验收。本轮完成，总体持续优化目标保持active。
