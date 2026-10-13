# 第105轮：foreground 清理拒绝后的独立资源释放

状态：完整验收完成。聚焦13/13、verify/release各1678/1678、177份原生文件摘要；host、11个恢复场景和diff通过。生产DSH保持第104轮PID47864，认证HTTP200。

## 改动

原多manager恢复回归在finally中顺序调用多个stop/close，首个异常会跳过后续fixture。现在finally与native after共享一个清理Promise，尝试所有原资源后仍抛出首个错误。生产App Server、Planner/Reviewer恢复规则及现有场景时限保持。

新增回归启动真实原测试场景，注入相同清理异常；要求该native测试仍exit1，同时原ChildProcess结束、store关闭、native child清理。固定Node源码的hook早退机制与取舍见[研究记录](../research/github-foreground-cleanup-rejection-patterns-2026-10-11.md)。

## 已取得证据

- 原自然失败用例隔离重放1/1通过，未确认自然触发原因。
- 受控原场景RED：失败结果后原backend存活；探针只清理自身实例。
- 新边界回归RED0/1、修正后GREEN1/1；typecheck通过。首次探针API读取错误记录保留。
- 原12项业务场景及新回归的组合验证13/13；完整verify/release均再次取得原文件12/12和新回归1/1。

## 验收边界

checkout外唯一门禁`isolated-5QsNDT`绑定原PID59344/`win32:134361549934795450`，实际exit0；两轮各1678测试、177份原生摘要，失败/取消/跳过/TODO及异步警告均0。334输入无漂移，217生成产物与正式构建一致，正式内容及mtime/ctime全部保持。

本轮没有生产源码修改，无需重载。原正式PID47864/`win32:134361539107257510`保持且认证HTTP200，415会话、430会话文件、111 workflow、119 queue及7份配置/凭据字节保持，指定会话、原parent和历史corrupt child保留。

实际退出收据、独立完整审计、正式会话/构建保护记录和完成收据保存在`../.codex-workflow-verification/hundredfifth-20261011/`。只退休探针自己的进程；首次RED及探针API读取错误、原104轮失败和回滚证据保留。未commit、push、publish，持续优化目标active。
