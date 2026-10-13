# 第111轮：Reviewer绑定失败后的同线程恢复

状态：完整隔离门禁通过，已按已有用户授权正式加载。

## 修改

`RetainedReviewer`增加 `bindingPending`。ephemeral Reviewer的`onThread`失败会保留原订阅和同一线程；下一次同请求先重试绑定，成功后才开始模型。重复失败不累积观察、不创建替代线程。非ephemeral绑定失败保持既有终止行为。

## 证据

- 旧行为RED：首轮绑定失败后，第二次请求跳过绑定回调并启动模型；外部日志保留于`../.codex-workflow-verification/hundredeleventh-20261011/callback-binding-persistence-red-d7027fa2dc284e2f958b88aa86c3f84e.log`。
- 修复GREEN：`callback-binding-persistence-green-final.log`为1/1，`thread/start=1`、`turn/start=2`、`thread/unsubscribe=1`、`thread/fork=0`、unhandled0，原fixture进程退出。
- callback相关组合75/75通过，typecheck通过。完整门禁前不宣称正式加载；正式DSH PID81424保持运行。

本轮没有引入新依赖、没有创建替代Planner/Reviewer；门禁仅生成并部署`lib/app-server-callback.js`及map。

## 完整验收与加载

- 门禁PID50044、`win32:134361788848633190`，工具会话63149实际exit0；隔离目录`isolated-9WVTBP`。verify/release各1701/1701，179份原生摘要；host、11个恢复/冷回放场景、diff、离线doctor（5项跳过）及包审计通过。
- 冻结输入339份、构建217份逐项核对；实际变化仅`lib/app-server-callback.js`及map。完整备份217份后只应用这2份产物，部署哈希匹配。
- 原PID81424的11个实例确认退出；新PID87604、`win32:134361807836294820`，认证HTTP200、监听与启动路径匹配，fatal stderr匹配0。
- 416会话身份、431会话文件、111workflow、119queue和7份配置/凭据完全保持；会话文件增删改均0，workflow/queue哈希不变。历史corrupt child、空白会话及取消marker保持。
- 重载后运行态无running/waiting workflow、活跃租约或可用Agent，休眠inbox仍按既有规则保留；没有静默创建替代Reviewer。

第111轮完成；持续优化目标保持active。
