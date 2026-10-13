# 第99轮：SDK callback 信号退出保留终止诊断

状态：完整验收与正式加载完成。第99轮 gate 原39256/birthKey `win32:134361320996524160` 正常退出；verify/release 各1663/1663，175份原生文件摘要，host、11个恢复场景及diff均通过。正式 DSH 从 PID37280 受控切换到 PID29964，健康检查 HTTP200。

## 缺陷与修复

SDK callback 子进程也会以 `close(null, signal)` 结束。旧 `src/codex-callback.ts` 在 signal 分支先生成可恢复错误，已知权限、Schema、显示契约或非法线程诊断因此被误判为可重试。候选复用共享 `isTerminalModelFailure()`，让完整终止诊断优先；没有终止诊断的未知 signal 继续保持原有暂时性路径。

回归探针覆盖四种终止诊断和一个未知 signal 对照：旧实现1/5通过、4项失败，候选5/5通过；typecheck通过。未启动真实 provider，也没有把模拟故障当作真实服务或 Token 账单证据。

## 完整验收与部署

331份输入、217份产物和175个测试文件均受保护；canonical 只有 `lib/codex-callback.js` 及 sourcemap 两项变更。正式重载前后415个会话、430个session文件、111条workflow和119条queue记录哈希一致；原 parent、历史 corrupt child、取消 marker 和休眠 inbox 保留。旧进程树11个实例全部退出，新的唯一实例身份为 `win32:134361359079497270`；served client 与已测产物一致，stderr 无 fatal。

未 commit、push 或 publish。浏览器交互和真实 provider 故障仍未宣称验收，持续优化目标保持 active。
