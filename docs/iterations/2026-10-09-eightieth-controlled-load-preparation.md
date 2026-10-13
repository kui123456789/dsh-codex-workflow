# 第80轮：正式加载前的版本与进程守卫准备

状态：只读版本/链接核对及未完成门禁守卫通过；第78轮唯一完整门禁仍运行。正式DSH没有停止或重载。

## 保留原门禁

第78轮runner PID43236/birthKey`win32:134359787058308250`持续存活，verify测试推进。源manifest为`782C28F76B9018F04C8C6BE43907CDA28624C82723A4AA8F41A418A76715202E`，309份冻结输入hash偏差0；预期完整测试1468。未新建完整测试进程，未改冻结输入。

## 正式实例与依赖链

正式DSH仍为PID41660，birthKey`win32:134359716248843430`，birth `2026-10-09T06:20:24.8843430+08:00`。node可执行路径、入口和3080参数在准备阶段匹配；实际重载前会再次查询，准备材料不能代替当时身份和空闲状态。

正式web profile的package声明、pnpm lockfile specifier/version及Junction均指向D盘`dsh-codex-workflow`；Node按profile解析并实际import `lib/index.js`，插件name和apply出口有效。没有修改profile或依赖链接。

217份lib构建路径与第74轮正式基线相同；只有`lib/client.js`hash变化，且与实际`src/client.js`完全一致。该delta符合第78轮Reviewer选择修正；维护者host恢复脚本和5项新回归不增加生产lib模块。

## 受控加载脚本

仓库外第78轮证据目录已准备6份脚本：最终build冻结、受控重载、加载后比较、原formal身份退休、只读会话/workflow元数据和原进程树退出证明。更新其固定计数为309/217/1468，绑定第78轮gate目录及source SHA、原formal PID/birth；新日志和auth-state使用独立`dsh-seventyeighth-formal`名字。未运行停止/启动步骤，未打印private stdout或cookie。

加载要求verify、release、host、host-recovery、diff全部exit0且计数/异步警告合法，再核对source/build完整清单和哈希、原监听及实时running/waiting0。原树确认退出后才启动一次新formal实例，之后比较会话身份和workflow完整记录。重复调用发现已有reload receipt时拒绝，转而观察那个原实例。

## 实际负向守卫

调用实际`freeze-final-build.ps1`时第78轮门禁尚未结束：exit1，原因`Final gates are incomplete; no build freeze was written`。随后检查确认最终build manifest未写、reload receipt不存在、原formal出生身份仍活。该测试验证冻结屏障；受控重载脚本本身未调用，不能说已验证真实停止/启动路径。

`reload-preparation.json`、`incomplete-reload-guard-receipt.json`及`pre-reload-version-preflight.json`保存本轮结果。正式加载仍须等原门禁终态，不以准备通过或第76轮历史verify替代第78轮完整验收。第76轮初始化清理失败及第79轮未复现观察保持原边界。

08:30原verify日志确认error/invalid初始化拒绝两个自然用例均通过（764/765），但完整verify和release仍无终态，不能据此解释第76轮143ms失败。原runner43236保持出生身份且继续测试。正式PID41660的认证health为HTTP200，413会话身份、111完整workflow及原parent/corrupt child保持，running/waiting0；这是当前只读观察，正式停止前仍需再次查询。
