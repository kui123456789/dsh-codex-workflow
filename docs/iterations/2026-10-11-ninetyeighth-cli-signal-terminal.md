# 第98轮：CLI信号退出保留终止诊断

状态：完整验收与正式加载完成。原38296真实exit0；verify/release各1658/1658，174份原生文件摘要、宿主加载、11恢复场景及diff通过。正式DSH PID37280健康HTTP200，采用`lib/codex-cli-audit.js`及map两份产物，415会话/430文件、111 workflow和119 queue保持。

## 缺陷

CLI子进程通过`close(null, signal)`结束时，旧`throwProcess()`把`code === null`直接分类为busy；权限、Schema、显示契约和非法线程诊断即使完整到达也被降为可重试。Node child_process文档明确null只代表没有数字退出码，signal才表示终止方式。

## 修复与来源

候选在busy分支前增加`!isTerminalModelFailure(diagnostic)`，复用现有共享终止分类；未知signal退出和无诊断的暂时行为保持，caller取消、原始错误和单次准入保持。固定Node v24.14.0 child_process文档/LICENSE与p-retry固定提交index/license通过Git blob/SHA256核对；不增加依赖。

有效RED/GREEN为7项旧实现3通过/4失败、候选7/7；相关CLI生命周期控制91/91，typecheck通过。初次测试字段误写导致的失败已单独保留并修正，不计入最终GREEN。没有真实provider进程或Token账单调用。

## 完整验收与部署

330输入副本、174测试文件、217产物完整保护；verify/release均1658/1658，失败/取消/跳过/TODO和异步警告0，offline doctor、包审计、host和11恢复场景通过。正式重载前双查415会话、430文件、111 workflow/119 queue和无运行/等待/lease；首个后继异常退出证据来自第97轮并保留，当前PID37280为受控恢复后唯一健康后继。

正式 served client/boot注册检查通过，产物hash偏差0；浏览器UI和真实provider仍未宣称验收。未commit/push/publish，历史失败门禁和corrupt child保留，持续优化目标active。
