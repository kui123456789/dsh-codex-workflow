# 第100轮：恢复checkpoint校验

状态：完整验收与正式加载完成。原gate PID47604/birth `win32:134361382007482750` 真实exit0，verify/release各1666/1666，175份原生文件摘要、host、11恢复场景及diff通过。正式DSH已从PID29964受控切换至PID51296，HTTP200及认证正常。

## 问题与来源

恢复记录的stage、attempt、布尔标记和checkpoint step此前缺少形状校验。存储坏数据时，旧status仍可能把原handle报告为可继续。Microsoft Agent Framework的checkpoint解码边界和OpenAI Agents的版本化RunState提供了存取前校验的设计参考；LangGraph明确区分task/thread与每次attempt。固定源码及许可证共9份字节核对，详见[研究记录](../research/github-checkpoint-resume-validation-patterns-2026-10-11.md)。

## 改动

- `workflow-schema.ts`校验已存在的恢复字段，保留旧版interruption-only记录。
- 拒绝数组等非字符串selector，已是v2的迁移也重新校验。
- 真实SQLite存取回归覆盖坏记录、update事务回滚、status拒绝及原handle保留。
- 新审查轮次夹具使用PID和出生时间验证/清理原实例，保持原后台存活时禁止新Reviewer的断言。
- README和CHANGELOG说明恢复记录的存取边界。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| 旧实现/首次候选/严格候选 | 3/6、4/6、6/6 |
| status存取探针 | 旧实现误报available，候选拒绝坏记录；记录及handle保留，模型请求0 |
| 相关控制 | 61/61，失败/取消/跳过/TODO和异步警告0 |
| typecheck、diff | 通过 |
| 首次完整gate | `isolated-XBS4Ht`：1663/1664，原PID46564真实exit1，175份原生文件摘要；release/host未执行 |
| 修正完整gate | `isolated-oxdyLi`：verify/release各1666/1666、175份原生文件摘要；host/11恢复/diff通过，原进程真实exit0 |
| 正式数据 | 415会话、111workflow、119queue，哈希与第99轮保持一致 |
| 已存数据兼容 | 候选schema只读检查111条正式workflow，111条均兼容，数据哈希保持，模型请求0 |

首次失败指向夹具的数字PID断言，未覆盖或改写该失败。严格候选和原gate快照分离；原gate实际结束后才采用修正源码并开启新门禁。新gate的原OS handle退出收据、完整原生摘要、331份输入和217份产物均已独立核对。

只交付 `lib/state/workflow-schema.js` 及sourcemap两份已测产物，原217份构建保存在回滚目录。旧正式进程树11实例确认退出后，只启动一个后继；新身份 `win32:134361396830022610`。重载前后415会话、430文件、111workflow和119queue哈希一致，指定session-f1477774-e562-4a9c-8240-9bda7cf65646、原parent、历史corrupt child、取消marker及休眠inbox保留。7份profile/provider/凭据文件字节保持，未记录凭据值。

served client/boot核对通过，217份产物偏差0，stderr无fatal。最后空diff日志导致观察器对null取正则的错误已修正，未重跑或改写gate。恢复网关为scripted-local；浏览器交互、真实provider故障和费用未宣称验收。未commit/push/publish，持续优化目标active。
