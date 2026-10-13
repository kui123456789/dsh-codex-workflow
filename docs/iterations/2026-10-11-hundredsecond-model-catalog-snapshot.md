# 第102轮：模型目录缓存快照不可变

状态：完整验收与正式加载完成。原 gate PID49796，verify/release 各1674/1674，176份原生文件摘要；host、11个恢复场景和diff通过。正式 DSH 从 PID61132 受控切换到 PID60728，HTTP200且认证正常。

## 改动与来源

`ModelSelectionGateway` 已经用 generation fencing 阻止旧 App Server 的迟到响应回填新缓存。本轮进一步冻结缓存内部的模型条目，并让 `listVisibleModels()` 返回 detached snapshot，调用方修改、排序或追加条目都不会污染当前进程的模型/default/effort选择。

设计参考了 OpenAI Agents JS 固定 commit 中对 `Readonly` 请求和 detached/frozen snapshot 的处理；许可证与源码字节核对记录在[研究文档](../research/github-model-catalog-snapshot-immutability-2026-10-11.md)。

## 验证与部署

- 模型目录回归 14/14；typecheck、diff通过。
- verify/release：1674/1674，176个测试文件，无失败、取消、跳过或异步警告。
- host兼容、11个恢复场景和正式 served client检查通过。
- 只部署 `lib/application/app-server/model-selection-gateway.js` 及 sourcemap。
- 受控重载前后：415会话、430 session文件、111 workflow、119 queue哈希一致；原 parent、历史 corrupt child、指定会话和7份 profile/provider/凭据文件保持。

浏览器交互、真实 provider 故障和费用仍未宣称验收。未 commit、push、publish，持续优化目标保持 active。
