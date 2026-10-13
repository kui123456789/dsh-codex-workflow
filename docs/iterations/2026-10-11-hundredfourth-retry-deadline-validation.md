# 第104轮：Bridge retry deadline 与模型目录 single-flight

状态：完整隔离验收和正式加载完成。verify/release各1677/1677、176份原生文件摘要；host、11个恢复场景和diff通过。正式DSH从PID63232切换到PID47864，认证HTTP200。

## 缺陷与改动

`BridgeStore.retry()` 原先把非法日期解析得到的 NaN 直接绑定到 SQLite。探针确认旧构建返回 true，把原 processing 行改成 retry、增加 attempts 并清空 owner，但 NULL deadline 让后续领取跳过该行。

现在在 fenced SQL 更新前拒绝非有限解析结果，返回明确的 `invalid bridge retry deadline`。原 claim、attempts、lease、owner 和 deadline 保持；合法重试与现有 epoch/owner fencing 不变。未修补或重写已有正式队列数据。

本轮冻结源码还包含模型目录的 single-flight 候选：同一 App Server generation 共享一个 `model/list` 请求，各观察者独立取消；reset 后新 generation 不加入旧 flight，旧响应不能回填新缓存。第102轮正式加载的是 detached/frozen snapshot，本轮补齐并发共享与 reset 回归。

## 来源与验证

- [固定 GitHub 源码研究](../research/github-queue-claim-fencing-audit-2026-10-11.md)：参考 OpenObserve 的 claim generation 和 SQL 前参数校验；未复制外部代码。
- 同一真实队列边界探针：原构建 RED 0/1，候选 GREEN 1/1。
- BridgeStore 26/26、typecheck 通过；heartbeat 仍使用 200ms TTL，通过 Date mock 避免依赖磁盘调度。
- 模型目录 generation 文件14/14，与目录基本回归合计15/15。
- 当前 gate：`isolated-q7X0V5`，PID64904/`win32:134361517349580680`；测试根 PID65412/`win32:134361517437584120`，并发2。
- 原 gate 已实际 exit0；verify/release各1677/1677、176份原生文件摘要，失败/取消/跳过/TODO及异步警告均0，host/11恢复/diff通过。数量核对：上轮1675，deadline增加1，catalog reset增加1。交接预计1676的记录保留，并追加修正；验证开始后输入未变。
- 332输入与正式217产物及metadata保护核对通过；111条正式 workflow schema 兼容。

## 失败与部署边界

首次 `isolated-ufp0Ju` 基线未包含本轮新输入，记录一次 foreground 清理未确认并留下挂起夹具；保留原日志、原binding和实际异常退出证据。误启动的 `isolated-8oO58c` 已中止，当前仅跟踪同一条修正门禁。尚未确认首次清理故障的自然触发原因。

完整门禁通过后按既有授权受控重载。冻结候选与上轮共6份输入不同：2份源码、2份测试及已写入的README/CHANGELOG。实际交付包含 `lib/bridge-store.js`/map 和 `lib/application/app-server/model-selection-gateway.d.ts`/JS/map，共5份产物；217份产物哈希均与已测构建匹配。

旧PID63232的11个原进程实例确认退出；新PID47864/`win32:134361539107257510`认证HTTP200。415会话、430会话文件、111 workflow、119 queue和7份配置/凭据字节保持；指定会话、原parent、历史corrupt child、取消诊断marker与休眠inbox均保留。正式队列没有retry/NULL-deadline遗留行，未执行数据迁移。

回滚副本及全部门禁、授权、进程/会话清单与原生收据保存在checkout外 `../.codex-workflow-verification/hundredfourth-20261011/`。正式加载封存后只追加README/CHANGELOG和研究记录说明，单独记录文档差异并复核源码、测试和构建哈希；没有重写已完成门禁的输入清单。

持续优化目标保持 active，未 commit、push、publish；真实 provider、浏览器交互和Token账单不作为此门禁的验收范围。
