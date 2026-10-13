# 第82轮：完整门禁与Reviewer正式加载

状态：第78轮修正及第76轮持久化验收增强已完成完整门禁和受控正式加载。持续优化目标保持active；未提交或发布。

## 原完整门禁终态

唯一runner43236/birthKey`win32:134359787058308250`于08:53:10结束exit0。使用原目录`final-gates-b22f7238-c570-4bd0-94d0-82d7205650f3`，未重开原进程。

| 检查 | 实际结果 |
| --- | --- |
| verify | 1468/1468，fail/cancelled/skipped/TODO0，1036.21秒 |
| release:check | 1468/1468，同样0异常计数，1035.83秒；doctor/pack通过，临时tarball清理 |
| host:check | exit0，4.10秒 |
| host:recovery:check | exit0，6.80秒；11场景均`persistedColdReplay: true` |
| diff | exit0 |

两份原完整日志的最终计数独立解析，所有门禁异步警告0。host恢复仍明确`modelGateway: scripted-local`及`browserUIVerified: false`，不把它等同于真实provider或UI故障验收。第76轮143ms初始化清理失败原日志保持；当前verify/release相应用例通过，不证明其历史原因已定位。

309份source manifest SHA256为`782C28F76B9018F04C8C6BE43907CDA28624C82723A4AA8F41A418A76715202E`；217份最终build manifest为`515092A286DFA676528A15DB76784CD11B67E888592EB1F940BFDC90893C5838`。source与build逐项hash偏差0。

## 加载守卫补齐

停止前复核原formal PID41660及birth。新实例在取得启动句柄后立即记录PID/birth；即使之后验证失败，已有receipt会阻止再次创建。加载后通过CIM出生身份匹配原启动回执，避免只凭数值PID认定同一进程。两份PowerShell脚本语法检查通过，原formal的.NET/CIM归一化birth一致。

只读检查同时读取宿主API与持久记录。111条workflow全部终态，其中1条保留waiting字段，不是当前可继续运行；真正非终态pending0、有效租约0。119条队列记录（含历史inbox/dead-letter）原字节字段整体hash纳入前后比较，没有把历史未处理队列伪称当前模型工作，也没有删除它。

## 正式受控重载

原formal捕获的11实例树确认退出后，仅启动一次新formal：PID57092，birth `2026-10-09T08:55:09.1459730+08:00`，birthKey`win32:134359809091459730`。旧实例退出、新PID/birth、Node路径、DSH入口、127.0.0.1:3080监听及认证HTTP200全部核对通过。

- 413个会话身份保持，原parent和历史corrupt child保持。
- 111条workflow完整记录及119条队列完整记录hash保持。
- 428份会话存储文件路径、字节数和hash保持。
- 217份build及27个关键模块hash偏差0；仅client相对第74轮变化。
- running/waiting、持久pending和有效租约均0；stderr fatal匹配0。

## 实际服务浏览器代码核对

使用新auth-state只读获取正式HTML和boot表中原插件的资源URL，没有打开浏览器或创建会话。正式boot注册`dsh-codex-workflow`；服务器响应包含冻结client原字节和`latest?.childSessionId`选择修正，旧选择表达式不存在。client SHA256为`c87fe88a3927bf7eb85457b7d2bf3e02290524b5cf850a3da7684b994d111530`，服务响应（含宿主包装）SHA256为`474b7ab7ca4977c2aae9751e2e5f68cdac5bb63b09411b4eb11da1b77f6df2df`。

首次诊断假定boot使用window点属性而解析失败；实际HTML以另一种合法全局属性形式注入。修改只读诊断的定位后通过，不是生产故障。未打印HTML、cookie或private stdout；未因诊断失败重启服务。

## 证据与未覆盖范围

仓库外第78轮目录保存原gate日志/终态、final-gates-audit、build冻结、reload receipt、formal前后比较、进程树及`served-client-boot-metadata.json`。原重载exec32262明确结束exit0。

本轮完成源码、完整门禁、实际服务版本和历史数据保护核对；隔离Planner/Reviewer UI证据见第77/78轮。正式provider自然故障、费用、完整AgentLoop组合及历史corrupt child恢复未验收；未伪造丢失的ephemeral线程。provider/profile/凭据保持，未commit/push/publish。
