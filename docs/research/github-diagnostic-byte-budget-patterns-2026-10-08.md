# 第59轮研究：诊断摘要的字节预算

状态：缺陷已修复，32项局部控制及真实CLI控制通过；verify和release均1289/1289，host加载/恢复及diff通过。第59轮已正式加载，最终证据见[迭代记录](../iterations/2026-10-08-fiftyninth-diagnostic-byte-budget.md)。

## 直接证据

共享 `compactDiagnostic` 的上限叫maxBytes，但原实现按UTF-16长度判断和裁切。包含中文及emoji的5422字节诊断只有1808个UTF-16单元，设定2048上限仍返回全文。直接探针确定RED，新增5项边界及CLI调用回归在旧代码上全部失败。

本轮使用Agent Reach的GitHub/gh后端保存固定源码，Context7先resolve Node，再查询官方v24 Buffer文档：`Buffer.byteLength`和string.length的单位不同；错误裁切UTF-8后直接解码会产生replacement字符。

## 固定来源与采用

| 来源 | 固定提交 / 许可 | 核对机制 |
| --- | --- | --- |
| parshap/truncate-utf8-bytes 1.0.2 | `4212839ea184e74fb81f1e4e633e1db794ebe4f4` / WTFPL或MIT，本次保留MIT许可 | Node入口用Buffer.byteLength；实现把surrogate pair作为一个片段，超出预算前停止 |
| sindresorhus/execa 10.1.0 | `63ddae6aeb6934da06fdb3754647791e58cd87c3` / MIT | `lib/io/max-buffer.js`明确区分bytes、characters、lines、objects；没有把其所有slice路径当作UTF-8安全算法 |
| nodejs/node 24.14.0 | `f657bb8ed86365ff3fdbe32e27563e778b41486a` / 项目许可 | 固定 `doc/api/buffer.md`说明真实byteLength及无效UTF-8解码语义 |

[truncate实现](https://github.com/parshap/truncate-utf8-bytes/blob/4212839ea184e74fb81f1e4e633e1db794ebe4f4/lib/truncate.js)、[Node入口](https://github.com/parshap/truncate-utf8-bytes/blob/4212839ea184e74fb81f1e4e633e1db794ebe4f4/index.js)、[Execa单位](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/io/max-buffer.js)、[Node Buffer文档](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/buffer.md)。truncate的5份固定source与Git blob字节哈希全部匹配，SHA256和来源清单位于本轮仓库旁 `github-sources/source-receipt.json`；Node/Execa的固定字节与许可副本同目录保留。

本项目没有安装或复制truncate依赖。共享函数先计算真实UTF-8长度，需摘要时编码一次，预留完整省略标记，分别把头尾偏移调整到完整UTF-8字符边界。标记数字为裁切掉的原source字节数；source沿用已有trim语义。极小预算放不下标记时只保留完整前缀。

补充来源核验通过Agent Reach的GitHub/gh后端读取相同固定提交的文件blob身份；Node Buffer文档和Execa max-buffer的本地原始字节与远端Git blob一致。7份固定源码的仓库、提交、路径、blob、SHA256和许可路径汇总在本轮 `github-sources/fixed-source-index.json`，原独立receipt保留。该核验只证明参考来源及字节身份，不替代产品门禁或真实provider故障验收。

## 验证与边界

32项完整局部测试通过，CLI受控传输确认终止分类只启动一次。额外真实本地CLI进程输出10038字节诊断、实际exit2；摘要2046字节，原头尾保持、UTF-8回读一致，未触发新的模型请求。

这里保留的是完整Unicode code point，组合字符的grapheme cluster可能跨裁切点；未要求保存整句或全部诊断。摘要字节数不是Token和费用，App Server原16384 UTF-16单元尾部预算保持。另一处AppServerCallback局部字符摘要未冒称使用此新字节契约。完整分类仍读取原诊断，改动不调整重试预算或失败恢复资格。

最终门禁与正式状态见[第59轮记录](../iterations/2026-10-08-fiftyninth-diagnostic-byte-budget.md)。
