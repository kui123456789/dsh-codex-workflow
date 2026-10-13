# 第58轮研究：进程退出与诊断流收尾

状态：真实管道缺陷已修复，17项诊断与71项生命周期控制通过，完整verify及连续release两次均1284/1284、host加载/恢复及diff通过。第58轮已正式加载；证据和未覆盖边界见[最终迭代记录](../iterations/2026-10-08-fiftyeighth-exit-stderr-drain.md)。

## 问题与直接证据

本地真实backend写入60字节完整中文诊断，回调后实际exit42；父端暂缓消费stderr，观察实际进程退出与随后到达的管道数据。修复前SDK返回 `codex app-server exited 42 (no signal): `，遗漏完整原诊断。原出生身份采集完整，原树已退出；没有注入虚假的exit/data事件或替换SDK方法。

同步记录顺序为 `process/exit → stderr/data → request/rejected`。退出时观察字节0，错误被调用者接收时字节60，真实pipe文本完整。初次记录exit采用Promise回调，顺序受微任务影响；初版结果另存，第二次采用同步exit监听明确校正，并再次RED。日志与原始证据位于仓库旁 `fiftyeighth-20261008/late-stderr-ordered-red.log` 和 `late-stderr-result.json`。

## 固定源码

使用Agent Reach的GitHub/gh后端，保存原始字节与许可到本轮 `github-sources/`。

| 来源 | 固定提交 / 路径 | 确认的机制 |
| --- | --- | --- |
| Node24.14.0 | `f657bb8ed86365ff3fdbe32e27563e778b41486a`，`lib/internal/child_process.js` | emit exit之后以nextTick安排flushStdio；close等待stdio关闭计数 |
| Execa10.1.0 | `63ddae6aeb6934da06fdb3754647791e58cd87c3`，`lib/resolve/exit-async.js` | 原进程spawn/error/exit观察与退出码获取分开 |
| Execa10.1.0 | 同提交，`lib/resolve/wait-subprocess.js` | 最终结果等待原退出与stdio，并结合超时、取消和内部错误路径 |

Context7先resolve Node，选择官方v24文档 `/websites/nodejs_latest-v24_x_api`，再查询exit/close：exit时stdio仍可能打开，close表示原进程结束且stdio关闭；继承同一stdio的其他进程会影响关闭时间。

[Node固定源码](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/internal/child_process.js#L294-L308)、[Execa退出观察](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/exit-async.js)、[Execa最终结果等待](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/resolve/wait-subprocess.js)。Node源码SHA256 `CF35DC992DCBE28866B80B34B1F6DE4FE47BDB474E74E7057CFA9CB1FD6EAD59`；Execa两个文件分别为 `0B966211C9A6780DB62816689682944E3EB91906A8CE1835E241CCC007B27A52`、`65F9661DC14B09D2C514C82EED6724BADC01C4ACE2ECDBAA4171C93B664D153B`。Node及Execa许可副本保留。

## 本项目的采用条件

修复前原exit先清空child，原stderr回调随即因owner guard返回，诊断构造又先于原数据读取。当前实现同时保证：实际退出立即使原线程不可用；原诊断在stderr结束或100毫秒期限后定稿；原失效通知与清理完成之前，后继启动等待原结算。原16384字符预算、UTF-8 decoder及出生身份清理证明继续保持。

继承stderr仍存活的后端可以让close长期不到达，有界收尾须有单独明确的结束条件。修复需覆盖原完整尾部、未关闭管道的失败及时结算、停止/取消与后继身份隔离。源码参考提供机制，最终实现及完整验收见[第58轮记录](../iterations/2026-10-08-fiftyeighth-exit-stderr-drain.md)。
