# 第62轮研究：CLI流输出的字节预算与解码收尾

状态：第62轮已验收加载。10项定向、5个完整文件50/50及typecheck通过；完整verify/release各1320/1320、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID142580，会话身份与完整workflow记录保持。

## 实际缺陷

CLI audit的 `maxOutputBytes` 以Buffer.byteLength检测溢出，却用String.slice按UTF-16单元裁切stderr。真实本地Node子进程输出100个emoji、配置64字节，原实现实际保留128字节。奇数边界还能截出孤立代理项；零预算的slice(-0)会保留全文。原StringDecoder.end输出又直接追加，stderr可能再次超限，stdout最终替代字符也能绕过溢出检查。

直接探针exit1，原运行PID/exitCode确认，未调用正式provider；9项回归旧实现8失败、ASCII控制1通过。修复后这9项和原取消原因控制共10项全部通过。

## 固定来源与边界

使用agent-reach的GitHub/gh后端搜索并读取固定源码。Context7先resolve Node.js，再查询v24文档的StringDecoder.end和Buffer.byteLength；实际引用按固定Node24.14.0源码保存。

| 来源 / 固定提交 | 许可 | 核对机制与限制 |
| --- | --- | --- |
| sindresorhus/execa `63ddae6aeb6934da06fdb3754647791e58cd87c3` | MIT | encoding transform将StringDecoder.end作为final chunk继续送入数据流程；max-buffer明确区分bytes、characters、lines。采用统一处理最终输出的原则，不迁移其终止stderr流或按字符计数的策略 |
| nodejs/node24.14.0 `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 项目许可 | StringDecoder缓存不完整多字节，end可输出替代字符；Buffer.byteLength不同于String.length，裁切必须使用实际UTF-8边界 |

[Execa最终解码](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/transform/encoding-transform.js)、[其预算单位](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/io/max-buffer.js)、[Node StringDecoder](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/string_decoder.md)、[Buffer文档](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/buffer.md)。9份原始字节包含测试和许可，全部核对Git blob；SHA256和路径保存在本轮证据 `github-sources/fixed-source-index.json`。

## 本项目采用

只修改CLI dispatcher。stderr每次解码与最终flush都执行同一尾部裁切：使用实际UTF-8字节，从预算起点跳过continuation bytes，保留最新完整code point；零预算返回空尾部，不插入新的省略标记。stdout保持超限失败策略，最终flush后再检查一次，用pendingError的首次原因规则保留更早的取消或业务失败。

控制证明包含完整emoji、奇数/极小/零预算、逐字节分片、真正不完整输入替代字符、ASCII尾部、公有review的末尾权限诊断和先前取消原因。CLI超过stderr预算仍继续读取原进程，不转换为另一种模型失败，不改变线程身份、重试分类、fork阶段或清理入口。

这个预算约束的是保留字符串，不是OS管道缓冲、临时编码分配或整个进程的内存硬上限。截掉的旧诊断仍按既有尾部策略丢失，不能宣称完整stderr都进入分类；完整code point也不等于完整grapheme。没有新增依赖，App Server的字符尾部与compactDiagnostic共享摘要保持各自原契约。

## Evidence → Finding → Path

- Evidence：真实 `cli-stderr-byte-bound-red.log` 与JSON，max64/actual128；9项旧实现控制8失败1通过。Finding：CLI保留值违反自己的字节预算；Path：在原data与close解码收尾中落实预算。
- GREEN：10项定向、typecheck及5个完整文件50/50（17.56秒）。真实CLI输出emoji后max64/actual64，单个进程exit0；最终收尾探针stderr输出 `C�` 共4字节，stdout同样来源明确报原CodexNoVerdictError。
- 第三方可在仓库执行 `pnpm exec tsx --test --test-name-pattern='CLI stderr byte bound|CLI stdout byte bound' test/codex-cli-audit.test.ts`。完整门禁与正式加载见[第62轮记录](../iterations/2026-10-08-sixtysecond-cli-output-byte-bound.md)。
