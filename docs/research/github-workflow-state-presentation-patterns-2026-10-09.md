# 工作流状态展示与显式完成判断

## 本地问题

Reviewer的`review-end`会将activeReview置null，同时在reviews保存原记录。旧summary只要历史非空就显示“最近审查已完成”，因此waiting、failed、cancelled等状态被错误展示；活跃waiting还会沿用旧的“正在检查”消息。卡片使用attempt字段却标成“第N轮”，容易把恢复尝试当成新业务审查。

采用显式状态作为完成依据，保留过程历史作为记录。13项回归先在原源文件9失败/4控制通过，后在同一真实投影及渲染边界全部通过。只修改client展示，不增加状态机依赖，不改变模型恢复或reviewCycles。

## 固定参考与许可

通过agent-reach的GitHub CLI搜索workflow/state-machine项目，并核查XState的实际源码；Context7先resolve XState，再查询官方`/statelyai/docs`状态文档。

| 来源 | 固定提交 | 核对内容 |
| --- | --- | --- |
| [XState State.ts](https://github.com/statelyai/xstate/blob/da4c74efa441dd3a4c1d9835c42c3d1f87cdcaba/packages/core/src/State.ts) | `da4c74efa441dd3a4c1d9835c42c3d1f87cdcaba` | Active/Done/Error/Stopped快照类型分开声明status及output/error；存在历史不定义完成 |
| 同提交types.ts、core package、LICENSE | 同上 | 固定core版本5.33.2、MIT许可；未安装或复制实现 |
| [官方状态文档](https://github.com/statelyai/docs/blob/e488a6ef4f04d62894dcf018c77bec474bebddc7/content/docs/states.mdx) | `e488a6ef4f04d62894dcf018c77bec474bebddc7` | 顶层final才满足status done；文档仅参考，API未返回该仓库独立license，不推定其内容为MIT |

5份源码/许可/文档实际字节保存于仓库外第83轮sources，Git blob匹配，偏差0，manifest记录SHA256。没有引用大段文档或复制代码到产品。

## 本地采用

XState的actor生命周期与本项目processState不是同一个枚举；这里只采用“显式状态判断”原则。本地completed显示完成，waiting显示暂停，failed/cancelled分别显示失败/取消，stale显示“进度暂未更新”而不宣布进程已退出。running保留当前进度文字。Planner waiting_input、failed、ready分别展示等待回答、失败和规划完成。

当前stage优先于旧进度文字；attempt卡片改为“第N次尝试”。暂停提示不意味着continuation.available=true，重启后旧ephemeral线程的可恢复性仍由原运行态判断。

## 验证边界

相关29/29及typecheck通过。安装DSH的独立UI恢复原生summary标签，实际waiting显示暂停、继续成功后显示完成；两条卡片为两次尝试，但业务reviewCycles=1，原child/thread各1，3个可见回合，child释放1次。原verify/release各1481/1481、host/持久回放/diff通过，第83轮正式受控加载和实际服务字节核对通过。轻量Agent工厂及脚本网关不验证真实provider故障、费用或完整AgentLoop。Planner模型通用暂停的可选过程字段仅在第84轮独立候选，不属于本次已加载修正。
