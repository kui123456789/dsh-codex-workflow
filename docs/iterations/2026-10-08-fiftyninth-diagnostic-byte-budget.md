# 第59轮：共享诊断摘要字节上限

状态：第59轮完整验收与正式加载完成。verify和release均1289/1289，host加载/恢复及diff通过；正式PID132660，412个会话身份与111条workflow完整记录保持。持续优化目标active。

## 当前基线与缺陷

本轮开始只读核对正式服务：412sessions/111workflows，完整会话身份及workflow记录哈希保持，原parent/历史child存在，running/waiting0。HEAD仍abb6174，既有dirty保留。第58轮SDK源码SHA256保持 `20491F33115A021C657746B18769FDDB7816E0555902E74E3E1CA5C047549AF8`。

直接运行 `node --import tsx ../.codex-workflow-verification/fiftyninth-20261008/compact-diagnostic-probe.mjs`，0.62秒exit1：2048字节上限返回5422字节原文，因为原实现比较1808个UTF-16单元。RED日志和JSON保留；5项新增完整回归同样全失败，`compact-tests-red.log`为5/5失败，未改断言放行。

## 改动与局部验证

生产仅改 `src/transient-retry.ts` 的共享compactDiagnostic：真实UTF-8长度、完整字符边界、包含marker的总预算及实际省略source字节数。短文本不变、trim语义不变、极小预算只保留完整前缀。CLI终止分类仍在摘要前使用原诊断；不修改App Server原字符尾部、模型继续、配置或重试策略。

`test/compact-diagnostic.test.ts`四项覆盖中文低UTF-16长度超字节预算、头尾和省略守恒、0到80字节边界、短Unicode精确阈值。既有CLI文件新增调用边界回归，确认单次终止请求及真实摘要上限。3个完整文件32/32、exit0，0.80秒，`compact-tests-green.log`；typecheck/diff通过。SDK源不变，shared retry源码SHA256 `317ED14CF6BB9627FB80C5F0884C3E989ECC8011BCC3ED8DA3637100800CF1F6`。

真实本地CLI探针使用原CodexCliAuditDispatcher和实际spawned Node backend，经stdin结束触发stderr输出、实际exit2：10038字节原诊断摘要2046字节，头尾及UTF-8回读保持，starts1。`cli-diagnostic-green.log/json`保留；未调用真实provider，不把此fixture的进程证据冒称通用后端整树退出验收。

[固定Node/Execa/truncate研究](../research/github-diagnostic-byte-budget-patterns-2026-10-08.md)记录SHA和许可，5份truncate源码原字节与Git blob对照通过，不增加依赖。README/CHANGELOG/发布清单说明新摘要契约与原字符尾部边界。

完整测试预期1289；verify、release、host/恢复、最终freeze及正式重载仍须独立证明。provider/profile/凭据及历史corrupt未改，未commit/push/publish。

## 完整验证链

冻结276份代码、测试、脚本与发布输入及同数原副本，未复制依赖；manifest SHA256 `3460D5FB36341944E335E2D5B02781562902DBDE67E2D5FB871F323BB6B50B66`。门禁前后核对完整文件集合及每项哈希，不在测试过程中修改发布README/CHANGELOG。

原exec53097，目录 `final-gates-d11f59b0-99ea-4e56-9f66-ed9245810a0b/`；本轮执行完整verify、一次release、host、host-recovery及diff。该纯摘要改动的分类、重试和流程控制沿用原完整回归，不增加模型请求或调整场景预算。独立文件并发1，完整预期1289；没有因观察等待到期另起任务。

helper引用同一原目录和276/1289输入，校验原正式PID130352/birth `2026-10-08T07:49:43.9657780+08:00` / `win32:134358905839657780`，已有重载receipt时拒绝重复启动；脚本解析0错误。原TEMP认证状态只由本地操作读取，不输出内容。完整链尚未结束，build-freeze.json未生成，受控重载未执行。

门禁等待期间补齐固定Node Buffer文档和Execa max-buffer源码的远端blob/本地字节对照；与既有5份truncate source一起，7项身份及SHA256清单保存到 `github-sources/fixed-source-index.json`。引用仍固定原提交，独立receipt和许可副本保留，276份冻结产品输入未改。原exec53097保持running，源码核验不作为完整测试通过或正式加载证明。

完整verify已明确exit0：1289/1289、fail/cancelled/skipped均0、异步警告0，1733.92秒；完整 `verify.log` 与 `summary.json`保留。原exec53097继续release，未重新开启验证任务；包审计、host/恢复及最终diff尚待结果，build清单与正式重载未执行。此前局部与真实CLI控制不替代这些剩余门禁。

## 最终门禁与正式加载

以上观察按时间顺序保留。原exec53097现已明确terminal exit0，完整结果保留于 `final-gates-d11f59b0-99ea-4e56-9f66-ed9245810a0b/summary.json` 及原日志。本轮纯摘要改动运行一次完整verify及一次完整release，原场景预算保持，独立文件并发1。

| 门禁 | 结果 | 秒数 |
| --- | --- | --- |
| verify | 1289/1289，fail/cancelled/skipped/异步警告均0 | 1733.92 |
| release | 1289/1289，RELEASE_CHECK_OK，异步警告0 | 1791.21 |
| host | ok=true，安装宿主0.1.7-rc.2，exit0 | 4.01 |
| host-recovery | ok=true，安装宿主0.1.7-rc.2，exit0 | 7.14 |
| diff-check | exit0 | — |

release通过typecheck/test/build、offline doctor（5项明确skipped）、pack audit及临时tarball清理。276份冻结代码和发布输入、完整目录集合保持一致；最终217份build清单在原链终态后生成，关联本轮唯一门禁目录。build manifest SHA256 `0A95F122392F48F599987CC4B30E24D5489A285C156701C7A2B166146AF2B52A`。

正式服务空闲且原PID130352/birth、启动命令与listener核对后，原受控reload exec83548明确exit0。捕获11个原实例并确认全部退出，只启动一次新PID **132660**，birth **2026-10-08T08:59:48.2582700+08:00**，监听 `127.0.0.1:3080`。认证交换303，健康HTTP200；认证state和formal stdout仅TEMP未输出内容。

`formal-verification.json` / `formal-plugin-provenance.json`核对：217份build、27个关键模块哈希0偏差，276份冻结输入0偏差；412个会话身份及111条workflow完整canonical记录不变，原parent/历史child存在，running/waiting0，stderr fatal扫描0。正式profile声明和插件Junction指向当前D盘仓库；实际改动模块 `lib/transient-retry.js` linked哈希匹配本轮构建。

- Session身份SHA256：`579e3efe69e5323d7b143b014f9995b87059d0cfc923474c8efdb8848d962145`。
- Workflow完整记录SHA256：`289c135e4d70d1959ec944c8c9ca28119b0bec0a8cdd0f4713296e89330ea39c`；recipe为 `SELECT id, revision, record_json, updated_at FROM workflows ORDER BY id` 后 `JSON.stringify(rows)`。
- 正式linked `lib/transient-retry.js` SHA256：`08C0B235A7A23125CF20D621E8A5BB580B99D18C18F2BEBDFE58B5CDB3C6EA45`。

本轮证明共享摘要UTF-8上限、字符边界、精确省略计数、CLI完整原错误先分类，以及本地完整门禁、正式加载与记录保护。不把摘要字节换算为Token或费用，不声称保护整个grapheme cluster、AppServerCallback局部摘要使用相同契约、全部历史消息逐字不变，或真实provider自然故障已验收。provider/profile/凭据及历史corrupt上下文未修改，未commit/push/publish；持续优化总体目标保持active。
