# 第103轮：schema 迁移备份失败时 fail-closed

状态：完整验收与正式加载完成。verify/release 各1675/1675，176份原生文件摘要；host、11个恢复场景和diff通过。正式DSH从PID60728切换到PID63232，HTTP200并认证正常。

## 改动与来源

`WorkflowStore` 在打开已有 coordination 数据库前创建 `.pre-schema-v2.bak`。旧实现吞掉 `copyFile` 错误，可能在没有回滚副本时继续初始化。现在备份读取或写入失败会直接终止初始化，原数据库保持可恢复。

设计参考 Microsoft Agent Framework 的 checkpoint 持久化边界：保存前完成编码/恢复校验，原子写入失败不能伪装成成功。生产默认仍使用 `fs.copyFile`，只增加了测试注入 seam。

## 验证与部署

- store/schema 回归18/18，typecheck通过。
- verify/release：1675/1675，176文件；host/11恢复/diff通过。
- 受保护的415会话、430文件、111 workflow、119 queue及profile/provider/凭据字节保持。
- 只部署 `lib/store.d.ts`、`lib/store.js` 和 sourcemap。
- 首次失败证据及第102轮回滚记录保留；未 commit、push、publish。

真实 provider、浏览器交互和费用未宣称验收，持续优化目标保持 active。
