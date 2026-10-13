# 原进程退役前的有界清单补读

状态：第106轮完整验收并正式加载。checkout外三个边界RED1/3、GREEN3/3，修正相关31/31、callback/清单28/28，verify/release各1683/1683、host/11恢复/diff通过；DSH PID46240认证HTTP200。第一次完整门禁1680项中1679通过、1个callback测试清理未确认；原输入、日志、native收据和实际exit1保留。

## 实际机制与受控证据

原`processRetirement()`只读取一次清单。该读取不可用时缓存只有PID的evidence，随后关闭原native child；即使原child已正常exit0，缺失的原树不能在关闭后重建，因此后续stop继续拒绝确认。

在原`app-server-callback.test.ts`的两轮Reviewer/转换场景上preload actor，只让永久stop的第一次清单读取不可用。观测到原SDK实际拥有的child在第一份真实快照中存在、birth可读；丢弃此次观察后，保留的tree只含PID，native测试exit1并报告同类异常。第一次探针使用Windows路径而非ESM file URL导致加载失败；另一次过早拦截了模型阶段的清单，未进入退役路径。两个不充分探针日志独立保留，修正为永久stop作用域后才形成RED。

同一原ChildProcess仍处于当前SDK且exit/signal尚未出现时，候选在不可用后补一次真实清单读取，然后仍按原owner条件校验。三个Windows边界由实际原callback场景驱动：

| 场景 | 观察次数 | 结果与约束 |
| --- | --- | --- |
| 第一次不可用 | 2 | 完整树和birth在关闭前取得，原child确认退出，stop成功 |
| 两次均不可用 | 2 | 原未知tree继续保留，原错误及native exit1保持 |
| 第一次期间原owner被退役 | 1 | 不再读取，不用另一时刻的清单补旧身份，继续拒绝 |

全部场景要求原PID/ChildProcess身份固定、补读前同一child仍live/owned、清理期间额外模型请求0、永久stop后的start仍拒绝。原场景正常路径另由完整callback套件覆盖。

```powershell
pnpm exec tsx --test test/retirement-census.test.ts
```

## 来源和取舍

沿用本仓库已固定的[原进程出生身份研究](github-original-process-birth-identity-patterns-2026-10-06.md)与本轮[p-retry/Node计时对照](github-process-cleanup-monotonic-grace-2026-10-11.md)：观察失败不能等同原进程消失，新的观察只在原owner仍有效时接纳；重试次数有界，不增加模型继续额度。未复制外部实现，未新增依赖。

修改只位于SDK的原child退役捕获，不扩展通用PID查询或fork/start恢复。每次清单查询仍最多4秒；两次失败仍返回原清理拒绝诊断，child退出本身不证明未知后代也退出。

## 验收边界

受控机制已验证，但首次自然callback失败没有保存CIM原返回，因此不能认定其一定来自同一观测故障。修正门禁`isolated-IIomJm`取得实际exit0和两轮1683/1683、178份独立native摘要；没有引用第一次1679/1680放行。只交付四份App Server/cleanup产物，217份哈希一致，336输入保持；provider/profile未改。最新416会话、431会话文件、111 workflow、119 queue保持，全部失败与回滚证据独立保留。
