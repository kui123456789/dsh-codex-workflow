# Planner过程状态与原日志投影回放

## 本地采用范围

Planner原记录在模型失败后为planning/waiting，但初始plan事件只有planning业务status，等待提交未发布过程状态。客户端无法可靠区分运行和暂停。修正以事件发布、显式fold和实际渲染构成完整链条，保留原workflow/thread/child恢复规则。

参考[显式状态展示](github-workflow-state-presentation-patterns-2026-10-09.md)中的固定XState快照分类原则；不引入XState依赖，也不把本地processState等同其actor枚举。日志投影兼容参考DSH官方契约。

## 固定来源与核对

使用agent-reach的GitHub CLI查询宿主投影源码，Context7先resolve DeepSeek Harness，再查询官方SessionProjectionRegistry的检查点恢复规则。

| 源码 | 固定提交 | 采用机制 |
| --- | --- | --- |
| [SessionProjectionRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/session/session-projection/src/index.ts) | `5badb15009ae1756c3afe0ae0cef1faafc290ccc` | version不匹配的checkpoint不能提供旧state；完整日志从init折叠，非零残片拒绝并要求从seq0读 |
| 同提交session-projection README及LICENSE | 同上，MIT | 纯同步fold、声明schema及可见wire，stateVersion负责缓存失效 |

三份实际字节保存于仓库外第84轮projection-sources，Git blob匹配0偏差，manifest记录SHA256。再次核对安装宿主0.1.7-rc.2实际restore实现。没有复制上游代码、安装依赖或升级宿主。

## 采用与纠错

本地plan事件/View增加可选processState；旧日志可读。暂停和待回执在真实store提交后发布waiting，终态失败待清理使用failed业务status和waiting过程字段。开始/继续事件显式running，避免引用此前waiting record导致错误显示。ready事件明确completed，不能沿用旧运行标记。

原8项显示回归3失败/5控制，候选37项通过；真实host首次候选暴露旧record被继续事件引用，修正后11场景及31项生命周期通过。主工作区合入前3个实际receipt/terminal producer边界全失败，修正后相关70项通过。

Context7核对指出即使字段可选，serialized state/fold语义变化仍须版本递增。补齐stateVersion2及真实宿主checkpoint测试，v1候选RED后主v2共9项GREEN；旧日志不生成缺失状态。测试断言不是仅检查版本数字，而是旧checkpoint拒绝残片、原日志完整回放和新checkpoint结果。

原生UI候选使用独立profile、轻量Agent工厂和受控模型，在同child/thread展示暂停→完成，3回合且清理1次；summary以保存布局恢复，不证明扩展入口导航。暂停状态不授权模型续跑，ephemeral线程丢失仍须明确拒绝。完整门禁及正式加载见[第84轮](../iterations/2026-10-09-eightyfourth-planner-waiting-view-diagnosis.md)。
