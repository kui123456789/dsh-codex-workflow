# 发布检查清单

适用于独立的 `codex-workflow` Skill。旧 DSH 宿主加载、侧栏和插件市场流程见[历史资料](README.md#dsh-插件历史资料)。

## 1. 固定待发布源码

确认版本、变更日志、目标提交和 `git status`，保留已有用户修改。使用仓库要求的 Node 和固定 pnpm 版本，运行 `pnpm install --frozen-lockfile` 准备开发依赖。

## 2. 运行完整发布门禁

```sh
pnpm verify:isolated
```

该命令将源码复制到隔离目录，连续执行两轮 `release:check`。每轮包含 `pnpm verify`（类型检查、构建、完整测试）、离线 doctor、打包及复制包独立运行检查。日常开发可以单独运行 `pnpm verify`；单轮发布检查使用 `pnpm release:check`，无需在同一轮前重复执行其内含的检查。

收据位于仓库父目录的 `.codex-workflow-verification/isolated-*/`：

- 总 `summary.json` 必须为 `complete: true`，两次退出码均为 0，源码指纹前后一致。
- 两个子门禁的 `summary.json`、原始 `tests.jsonl` 和日志必须完整；核对全部测试文件，失败、跳过、取消及 todo 均为 0。
- 测试总数以该提交的原生收据为准。[v2.0.0 的 54/54](verification-2.0.0.md)是固定版本记录，不是未来版本的预设值。

失败时保留失败收据，查明原因后再验证。检查完成不以终端最后一条成功信息或旧版本的绿色 CI 代替。

## 3. 校验并交付实际通过验证的产物

使用本机 `skill-creator` 的 `quick_validate.py` 校验根目录与待交付目录的 `SKILL.md`，记录验证器路径和输出。核对 Skill、references、可选宿主元数据及自包含的 `scripts/workflow.mjs`。

从隔离门禁返回的 `stageDirectory` 取出该次通过验证的 `dist/codex-workflow/`、`dist/codex-workflow.zip` 和 `dist/artifacts.json`。核对逐文件哈希和 ZIP 完整性，为交付文件生成 `SHA256SUMS`。重新构建后须重新核对产物，不能把不同字节的包当作原验证产物。

分发目录须可复制到无源码、无 `node_modules` 的位置运行。历史文档、测试数据、状态数据库和转换备份不进入 Skill 包。

## 4. 分开记录平台与真实模型验证

核对待发布提交的 Windows、Linux、macOS × Node 22.19/24 六项 CI；需要验证隔离发布工作流时运行 `release-verification`。逐项记录来源提交、结果和原生收据。

凭据和环境可用时，在隔离示例项目执行最小真实 Codex 试跑，分别记录规划、读取证据、审查和清理结果。fake Codex 的子进程测试、doctor 或登录状态均不能代替真实模型功能验收。未运行的范围标为 `NOT RUN`，运行失败的范围按实际错误记录。

## 5. 发布与下载复核

已有用户授权时，提交并推送已验证源码，创建对应标签和 GitHub Release。说明不兼容变化、安装步骤、平台结果及真实模型限制。当前交付是 Skill ZIP，不是 npm 包。

上传已验证的 ZIP、文件清单和校验文件后，重新下载，核对字节、GitHub 摘要、标签指向及公开发布说明。版本验证记录应固定到该次提交；后续文档修订单独记录，保留已发布标签和附件的验证来源。
