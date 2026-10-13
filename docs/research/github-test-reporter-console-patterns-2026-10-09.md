# Windows后台测试输出与Node TAP机制

日期：2026-10-09。第72轮原release的1447通过/1取消失败记录保留；TAP入口随后连同第73轮测试清理改进，经完整verify/release各1455/1455及host/diff验收通过，数字汇总直接解析。217份生产build与正式版本一致，保留PID4448，维护者脚本通过原Junction生效。未新增依赖、未更换Node或tsx。

## 实际问题与采用范围

第71轮隐藏pwsh把spec的Unicode汇总符号转为乱码：实际release exit0、1435/1435，却使外围计数门误报。仓库release-check本身按实际退出码判断，没有这一误判；本轮改进测试入口，为verify/release共用环境变量选择TAP，避免每个外层脚本单独修复乱码。

旧入口忽略DSH_WORKFLOW_TEST_REPORTER。隔离项目通过真实已安装tsx/Node执行：初始12项7失败5控制通过，后增多reporter控制，总计13。最初夹具受NODE_TEST_CONTEXT影响没有独立执行，日志保留且未当作有效RED；清理该测试内部变量后验证真实流程。不是把fixture计数当成本项目完整计数。

## 固定源码比较

| 来源及固定提交 | 实际机制 | 采用 |
| --- | --- | --- |
| [Node v24.14.0](https://github.com/nodejs/node/tree/f657bb8ed86365ff3fdbe32e27563e778b41486a)，核心MIT，完整许可见LICENSE | lib/internal/test_runner/reporter/tap.js消费真实test事件，输出TAP及ASCII诊断；doc/api/test.md说明内置reporter及CLI多reporter/destination | 使用原生--test-reporter=tap，保留Node执行及退出判定，不写自定义reporter或估算计数。 |
| [tsx](https://github.com/privatenumber/tsx/tree/4473971f4b3261de253209b148d8fdc43269fcc4)，MIT | src/cli.ts及src/run.ts传递Node参数、配置TS执行，并保留子进程结算 | 通过现有已安装tsx入口传入Node reporter参数；参考提交不是依赖升级。 |

使用agent-reach GitHub/gh后端搜索、固定读取；6份源码/文档/许可原字节已核对Git blob SHA1及SHA256，保存本轮github-sources/fixed-source-index.json。Context7查询Node22/24内置TAP及多reporter契约。Node22默认报告会随TTY变化，未强制默认格式；Node官方说明reporter文本可能随版本变动，专用程序协议宜使用TestsStream事件。

## 实现和证据

scripts/run-tests.mjs接受可选spec|tap环境设置；未设置/空值保持Node默认，显式单个或多个reporter优先，非法设置退出2且不启动CLI。原文件发现/排序、1–4并发、名称过滤和真实失败退出码保持。

13/13通过，typecheck通过。隐藏pwsh代码页936下，旧入口没有所选TAP汇总，新入口完整输出tests2/pass1/fail0/cancelled0/skipped1/todo0，二者实际exit0；原字节及SHA256保存。TAP仅保证这些ASCII计数避免字符转换问题，不声称输出全文永远不变或自动证明测试完成。

完整1448项验收及部署见[第72轮记录](../iterations/2026-10-09-seventysecond-test-reporter-console.md)。本轮只改维护者测试入口，不调用正式模型、不更改provider/profile、不重建历史ephemeral线程。
