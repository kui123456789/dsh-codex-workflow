# 外部Store的稳定加载快照

## 本地缺陷与采用

第86轮冷读历史时，summary在projection未到达前读取reviews抛错；face缺失时emptyProjection每次生成新对象，违反React快照契约。采用同一个不可变加载快照，区分未就绪和已加载空workflow，继续通过原face订阅数据，不改变业务状态或模型请求。

## 固定源码与许可

通过agent-reach的GitHub CLI核查React源码；Context7先resolve React，再查询官方`/reactjs/react.dev`的useSyncExternalStore缓存及订阅要求。

| 来源 | 固定提交 | 机制 |
| --- | --- | --- |
| [ReactFiberHooks](https://github.com/facebook/react/blob/b618bbb4422693bbb8d387180687b3f510300f42/packages/react-reconciler/src/ReactFiberHooks.js) | `b618bbb4422693bbb8d387180687b3f510300f42` | 重复读取getSnapshot并比较引用，未缓存会警告；订阅后检查变更 |
| [客户端shim](https://github.com/facebook/react/blob/b618bbb4422693bbb8d387180687b3f510300f42/packages/use-sync-external-store/src/useSyncExternalStoreShimClient.js)及LICENSE | 同上，MIT | unchanged快照引用一致，通知触发读取 |
| [官方Hook文档](https://github.com/reactjs/react.dev/blob/046f17d04295ba047bb5739026b4ac3110f17028/src/content/reference/react/useSyncExternalStore.md) | `046f17d04295ba047bb5739026b4ac3110f17028` | Object.is、不可变cached snapshot、server/client一致性及稳定subscribe |

四份实际字节保存在仓库外第87轮react-sources，Git blob匹配0偏差，manifest记录SHA256。文档仅参考，不推定许可与React源码相同；固定上游实现不冒称安装宿主bundle使用同一SHA。没有复制shim、增加依赖或升级React。

## 实施与验证

默认subscribe使用稳定函数，pending/null返回一个LOADING_PROJECTION，getter保留face receiver。loading不再冒充完成或空审查；loaded空快照显示等待审查。原通知推动pause→running→completed，不重复订阅。

6项回归原5失败/1控制，合入后相关44项和typecheck通过。隔离v2宿主只读回放原v1测试日志及受控旧cache，summary显示原完成计划，刷新后仍可读；2日志hash保持，Agent创建0，未安装模型网关/WorkflowManager。临时导航在目录ready后调用公开openSession，并恢复原生summary布局，不作为产品导航修正或入口验收。

第84轮1490项结果不覆盖新冷renderer边界。本次原verify/release各1496/1496、异步警告0，host/11恢复/diff及受控正式加载通过；实际服务字节包含guard，414会话和429当前文件前后保持。边界见[第87轮](../iterations/2026-10-09-eightyseventh-cold-projection-snapshot.md)，不扩大为正式provider或完整AgentLoop验收。
