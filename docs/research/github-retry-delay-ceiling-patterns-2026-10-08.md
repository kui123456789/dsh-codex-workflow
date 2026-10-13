# 第61轮研究：抖动后的真实等待上限

状态：第61轮已验收加载。7项定向、169项完整相关控制、typecheck及真实本地CLI验证通过；完整verify/release各1310/1310、0异步警告，包审计、host加载/恢复与diff通过。正式DSH为PID139496，会话身份与完整workflow记录保持。

## 为什么继续这一轮

README将 `transientRetryMaxMs` 定义为每次等待上限，但原实现先裁切指数增长，再乘 ±抖动。配置base/max60000、budget65000、jitter0.25时，接近上界的随机值产生75000毫秒，导致共享控制、可读Planner/Reviewer和CLI提前返回预算耗尽。直接探针0.71秒exit1；7项新增控制旧实现6失败、1个保留行为控制通过。

## 固定源码与不同契约

通过agent-reach的GitHub/gh后端搜索、读取固定提交；Context7先resolve再查询Coveo的maxDelay/full jitter文档。实际结论以固定源码为准。

| 项目 / 固定提交 | 许可 | 核对机制与采用边界 |
| --- | --- | --- |
| sindresorhus/p-retry `1472907affe8d6107aba5884abc36d6361b3042e` | MIT | `calculateDelay`先随机化和round，再min(maxTimeout)；采用最终等待值裁切原则，保留本项目现有 ±抖动 |
| coveooss/exponential-backoff `5622170828bd91dc149585bfa3d82c8972a75ac5` | Apache-2.0 | 指数值先min(maxDelay)，full jitter只在该值以内采样；未迁移full jitter或允许零等待 |
| cenkalti/backoff `b1a30d947ca896d37518610255281904b439c619` | MIT | 明确声明MaxInterval只裁切基础间隔，不裁切randomized interval；这是另一种公开契约，不能据此证明本项目“最终等待上限”已成立 |

[p-retry实际计算](https://github.com/sindresorhus/p-retry/blob/1472907affe8d6107aba5884abc36d6361b3042e/index.js)、[Coveo等待计算](https://github.com/coveooss/exponential-backoff/blob/5622170828bd91dc149585bfa3d82c8972a75ac5/src/delay/delay.base.ts)、[full jitter](https://github.com/coveooss/exponential-backoff/blob/5622170828bd91dc149585bfa3d82c8972a75ac5/src/jitter/full/full.jitter.ts)、[cenkalti原契约](https://github.com/cenkalti/backoff/blob/b1a30d947ca896d37518610255281904b439c619/exponential.go)。10份原始文件含许可均通过Git blob字节核对；SHA256与路径保存在本轮证据目录 `github-sources/fixed-source-index.json`。

## 本项目如何采用

仅修改共享 `backoffDelayMs`：有效毫秒上限取max(1, floor(maxMs))；指数基础按该有效上限裁切；抖动与round之后再裁切最终值。保留 ±抖动机制、负向采样、最低1毫秒及关闭抖动；小数上限先量化到整数毫秒。正向值在上限处被裁切，分布会在上限聚集；没有改变随机比例、总重试预算、同线程归属或一次自动continuation权限。

以base/max60000、budget65000为例，原实现计划等待75000并只执行首次失败操作；新实现计划等待60000并允许原操作第二次成功。允许的重试数可能因此增加，不把这项修复描述为真实Token节省。定时器真实唤醒可能晚于计划值，仍由第60轮的post-sleep截止检查阻止超预算接纳；本轮不保证实际墙钟等待硬上限，也没有增加依赖。

## 证据到改动

- Evidence：`retry-delay-ceiling-probe-red.json`、RED日志和7项旧实现控制；Finding：最终等待超过文档上限，预算被提前耗尽；Path：共享计算末尾裁切，原调用者继续使用同一结果。
- GREEN：7/7、5个完整文件169/169（95.15秒）、typecheck通过。原直接探针变为delay60000、attempts2、原结果成功。
- 真实本地CLI：原dispatcher实际spawn三个Node进程，退出码[1,0,0]；两次可读请求均为 `resume original-local-reviewer`，随后执行既有normalization，返回verdict。使用注入时钟及受控本地响应，不调用正式provider。

完整验收与最终加载见[第61轮记录](../iterations/2026-10-08-sixtyfirst-retry-delay-ceiling.md)。
