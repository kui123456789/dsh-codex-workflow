# 持久化 checkpoint 备份失败时 fail-closed

状态：第103轮已完整验收并正式加载。18项 store/schema 回归、verify/release各1675/1675、host/11恢复/diff通过；正式PID63232健康HTTP200。

## GitHub 参考

Microsoft Agent Framework 的 [`_checkpoint.py`](https://github.com/microsoft/agent-framework/blob/fd52de71579162a888fb2dd7510c57c6014dcdfc/python/packages/core/agent_framework/_workflows/_checkpoint.py) 将 checkpoint 编码、可恢复解码和原子临时文件替换放在保存边界；编码或恢复校验失败会拒绝保存。该固定 commit 的许可证为 MIT，源码和 license 字节在第100轮研究中已核对。

## 本项目采用

`WorkflowStore` 在打开已有 SQLite coordination 文件前创建 `.pre-schema-v2.bak`。旧实现吞掉 `copyFile` 异常，可能在没有回滚副本时继续初始化。现在 source/backup 路径的非 `ENOENT` 错误和实际 copy 错误都会向上传递，初始化停止，原数据库不会被继续迁移或覆盖。

为保持可测试性，`WorkflowStore` 增加了仅用于测试的 `copyFile` 注入 seam；生产默认仍使用 `node:fs/promises.copyFile`。新增回归模拟备份目标不可用，确认错误可见、第二个 store 关闭且原数据仍可保留。正常备份、旧记录导入、SQLite revision-CAS 和 retryState schema 回归继续通过。

这项修复只保护 schema 迁移备份，不改变 workflow 运行时、线程恢复或队列重试策略。
