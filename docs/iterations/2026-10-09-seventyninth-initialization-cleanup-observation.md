# 第79轮：初始化拒绝清理异常的有界观察

状态：第78轮原门禁仍运行，冻结输入保持；第76轮release的初始化清理异常未在本次8样本观察复现，原因仍未知。没有修改生产清理规则。

## 现场与观察范围

第76轮release1463项中1项失败：`error initialization rejection cannot leave an accepted child or poison subsequent metadata`，耗时143.59ms，外露错误为原idle进程树清理未确认。原错误路径及完成回执已保存。第78轮定向复查1/1通过，但不能替代整轮结果。

本次核查三种候选原因：原process退出早于证据采集、系统身份查询暂时不完整、以及测试finally中的清理错误覆盖最初错误。仅使用独立临时目录和本地fake-model-catalog App Server协议，不修改正式provider、配置或真实workflow。

`initialization-cleanup-probe.mts`实例级观察原`processRetirement`返回的证据Promise；不插入新的执行屏障，不替换证据，不放宽身份规则。每个样本分别保存首次/再次initialize错误、后续目录读取和stop结果，避免诊断脚本的finally覆盖先前记录。后续目录读取属于该独立测试的明确新操作；没有丢失ephemeral workflow或替代模型线程。

## 实际结果

8样本均保留`fixture initialization rejected`作为两次initialize拒绝结果；后续模型目录为catalog-C，最终清理确认，retirement不残留，模型回合0。24次retirement均取得完整原身份，每树2实例（原Node和console host）；独立按原birth核对48实例全部退出，unknownTrees0。

这些数据未支持任何一个候选原因，也未复现原143ms失败。保留原整轮失败，不把8次成功描述为该异常已修复；不修改等待期限、不伪造缺席/清理确认，不将未知原线程替换为新线程。

## 证据与清理

仓库外目录`../.codex-workflow-verification/seventyninth-20261009/`保存观察脚本、8样本完整回执、8份wire日志及`probe-cleanup-receipt.json`。原探针exec句柄18659明确完成exit0，无后台探针仍运行。

原进程树已确认退出；临时目录删除命令被自动审批审查以`blocked by policy`拒绝，未执行。日志随后单独复制保存，8个`%TEMP%/dsh-init-cleanup-observation-*`目录保持为诊断材料，没有绕过拒绝重试删除，不能报告目录已清理。

## 并行门禁边界

第78轮唯一runner PID43236/birthKey`win32:134359787058308250`持续存活，verify测试推进。它持有309份冻结输入，包含已合入的Reviewer UI修正和5项回归，测试预期1468。本轮只写仓库外探针和非冻结迭代文档，没有改其代码、测试、README或CHANGELOG，也没有重复启动完整门禁。
