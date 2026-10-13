# 侧栏通知与插件退役机制

## 问题与选择

旧客户端只退订和清除定时器。宿主通知器先复制监听器列表，因此同一次通知中的较早监听器卸载插件后，已捕获的 `scan` 仍会执行：重新打开侧栏或订阅下一个会话。会话切换还保留旧退订函数，导致同一函数调用两次。

采用 VS Code 的退役标记和一次性资源释放思想：清理前设置 `disposed`，扫描和重试接纳检查该标记；释放投影时先取出并清空原句柄，再调用退订。改动落在现有 `src/client.js`，正常会话发现和原 child 选择保持原路径。

## GitHub 来源与取舍

使用 agent-reach 的 GitHub CLI 后端搜索编码 Agent/IDE 项目，并读取固定提交。初次过窄搜索返回空结果；后续 `coding agent IDE language:TypeScript` 返回 Cline 等候选。采用依据是生命周期边界与本地缺陷匹配，星数不作为正确性证明。

| 来源 | 固定提交与许可 | 实际阅读与采用判断 |
| --- | --- | --- |
| [VS Code lifecycle.ts](https://github.com/microsoft/vscode/blob/ed380adfe6e65ec56c354a49622b844af3938878/src/vs/base/common/lifecycle.ts#L432) | `ed380adfe6e65ec56c354a49622b844af3938878`，MIT | `DisposableStore.dispose()` 先检查/设置退役状态，再清理；`thenIfNotDisposed()` 在延迟回调中检查状态。采用机制，现有客户端直接实现。 |
| [DSH notifySubscribers](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/client/store/src/index.ts#L46) | `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，MIT | 复制观察者列表再逐个通知；同提交的 Notifier 与 ProjectionValueStore 提供原订阅/退订及稳定 face，说明仅退订不能撤回已捕获的回调。 |
| [Cline WebviewProvider](https://github.com/cline/cline/blob/fa840c741c3fc2eb49e7e0a4484895a99dae5cc5/apps/vscode/src/core/webview/WebviewProvider.ts#L22) | `fa840c741c3fc2eb49e7e0a4484895a99dae5cc5`，Apache-2.0 | provider 将 dispose 委托给 controller，再清除实例。该作用域比本次浏览器订阅清理更大；不迁移其执行层生命周期。 |

9 份源码、导出入口和许可的实际字节保存在 `%TEMP%/dsh-eightyeighth-github-c28e2410-2940-4143-8a24-a3170438c735`。manifest 记录提交、路径、Git blob 与 SHA256；全部 Git blob 匹配。参考资料仅在仓库外保存，项目中整理机制和证据。

Context7 先解析 DeepSeek Harness，再查询 `/deepseek-ai/deepseek-harness` 的卸载与订阅契约。返回 `ctx.effect()`、注册自带 effect 及卸载逆序说明；没有直接回答已捕获通知是否撤回，该细节依据固定源码和安装宿主的实际实现。

## 复现、验证与边界

`pnpm exec tsx --test test/sidebar-disposal.test.ts` 的初始 6 项结果为 5 失败、1 正常控制通过。首次夹具误将注册数量写为 5；实际为 4，已修正，原失败日志保留。随后增加两个正常定时重试控制，最终新增 8 项通过；相关侧栏套件共 50 项，typecheck 通过。

仓库外 `installed-notifier-probe.mjs` 隔离执行安装的 DSH 0.1.7-rc.2 的实际 `notifySubscribers`、Notifier、ProjectionValueStore 与插件源码：旧客户端的投影/挂载通知都会在卸载后第二次开栏，后者还留下新会话监听器；修正后两个场景均只开一次且无新监听器。RED exit1、GREEN exit0，源码哈希记录在回执中。

这是安装宿主源码的隔离执行，未在正式浏览器中卸载插件，也未调用模型。受控保留 timer callback 用于验证退役边界，不声称浏览器 `clearTimeout` 失效。本轮不取消工作流或恢复丢失的 ephemeral 线程。完整门禁及正式加载以[第88轮记录](../iterations/2026-10-09-eightyeighth-sidebar-disposal.md)为准。
