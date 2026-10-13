# 第57轮研究：跨OS分片的UTF-8诊断

## 结论

真实stderr chunk不保证落在字符边界。每块独立String(Buffer)会把完整源文本变为乱码；每个原child需要独立的增量decoder，退出时只结算本owner已经观察的残余字节。诊断尾部裁切还需避免把UTF-16 surrogate pair切成半个emoji。

## 固定来源

通过Agent Reach GitHub/`gh`后端核对当前SHA并读取固定source、文档与许可，保存于仓库旁 `.codex-workflow-verification/fiftyseventh-20261008/github-sources/`；没有复制实现或增加依赖。

| 来源 | 固定提交 | 版本 / 许可 | 机制 |
| --- | --- | --- | --- |
| nodejs/node | `f657bb8ed86365ff3fdbe32e27563e778b41486a` | 本机24.14.0 / MIT及文件内许可 | StringDecoder缓存未完成字节，end结算真正不完整输入 |
| sindresorhus/execa | `63ddae6aeb6934da06fdb3754647791e58cd87c3` | 10.1.0 / MIT | encoding generator保存decoder，transform与final分离 |

Context7先resolve Node，再查 `/nodejs/node` 的StringDecoder write/end：不完整多字节先保留，下一write或end处理；真正不完整UTF-8字节在end替换。固定[Node文档](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/doc/api/string_decoder.md)与[实现](https://github.com/nodejs/node/blob/f657bb8ed86365ff3fdbe32e27563e778b41486a/lib/string_decoder.js)核对该边界。

[Execa encoding transform](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/lib/transform/encoding-transform.js#L17-L56)为编码流持有StringDecoder，字节chunk调用write，string chunk直接通过，final调用end。本项目借鉴decoder寿命，不迁移Execa stream pipeline、不缓冲全部stderr。

项目原有 `src/codex-callback.ts` 和 `src/codex-cli-audit.ts` 已用StringDecoder；本轮补齐stdio App Server原stderr接缝，没有改这两条原CLI路径。

## 实际RED与采用

本地protocol先写首字“模”的前两个UTF-8字节。测试等父端真实data到达、确认实际buffer为 `e6a8` 后，才发送其余字节及原backend exit42。旧error变为 `��型连接中断，保留原会话继续处理。`，RED日志 `stderr-utf8-red.log`，现场 `%TEMP%/dsh-stderr-utf8-kvA9wF/utf8-result.json`。没有伪造data事件或改SDK方法。

增量decoder在startProcess原child闭包内持有，先校验当前owner再write；原exit生成error前end并按原tail预算拼入。未观察的旧OS字节不借机进入后继。补充边界RED证明 `.slice(-16384)`会保留独立低surrogate；只丢这个半字符，仍保留最多16384 UTF-16单元，未扩大输出或模型预算。

5个真实pipe场景通过：chinese、emoji、incomplete、bounded、bounded-surrogate。完整中文/emoji没有replacement，真正不完整源字节只有一个replacement；长输出仅原budget尾部，截断边界不发布半字符。原退出prefix和诊断不可用/retired-owner规则保持。

第一次多文件组合未显式指定concurrency，发生多个birth查询缺失和清理未知，原日志保留；不能把那些结果写成UTF-8回归通过。按上一轮已采用的独立文件并发1，原stderr组合与新中文场景9/9通过，46.63秒；最终5项9.18秒，typecheck/diff通过，原场景期限和proof规则不变。

完整门禁与正式加载见[第57轮记录](../iterations/2026-10-08-fiftyseventh-stderr-utf8.md)。此处证明本地真实pipe分片及字符边界，不证明所有晚到stderr都被收集、provider自然故障、Token费用、浏览器或Linux pidfd实机验收。

## 展示测试事件屏障的补充源码核对

这次核对发生在本地展示测试修复及完整verify通过之后，为已复现的选择提供独立源码对照。仍固定Execa `63ddae6aeb6934da06fdb3754647791e58cd87c3`，MIT许可和本地原始字节副本保留；没有更新依赖或改变正在运行的release输入。

[test/pipe/streaming.js:104–123](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/test/pipe/streaming.js#L104-L123) 的单项测试先写 `foo`，等待destination stdout的实际 `data` 并断言内容，随后接入第二个source、结束原PassThrough输入，再等待子进程结果。[stdin fixture](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/test/fixtures/stdin.js) 把真实stdin接到stdout；输入端的释放决定后续结束顺序。

本项目Reviewer测试采用同样的事件顺序：原回合输出完整delta → 断言消息及回合仍未完成 → fixture专用RPC释放同一回合completion → 等待原结果。原5秒回合预算、500毫秒完成延迟及文本断言保持；200毫秒控制RPC延迟使旧150毫秒采样确定失败。真实事件等待受原turn promise约束。

Execa的[IPC pending测试](https://github.com/sindresorhus/execa/blob/63ddae6aeb6934da06fdb3754647791e58cd87c3/test/ipc/pending.js) 部分场景仍使用1秒或2秒等待；本次参考范围是上面管道测试的实际事件观察与输入端释放。source读取还核对了 `test/helpers/stream.js`，它提供基础Readable/Writable构造，不承担这个同步屏障。

4份新增固定source全部通过Git `blob`字节哈希对照，SHA256、tree SHA及路径清单位于本轮 `github-sources/execa-test-synchronization-sources.json`；管道测试SHA256 `C7B6814358C6A6159B3E1BE01934589C46FC9347AD836BCFAA2D36E61AA099C6`，stdin fixture为 `D8E417459BDF1A14216CEBC139C9145E4A0133145E955910E6B4D3E03F9FE1EE`。该参考不能证明此前Windows原进程身份查询失败的具体原因；完整verify已1280/1280通过，连续release及正式加载状态继续由迭代记录说明。
