# 第83轮：暂停审查的准确状态展示

状态：代码修正、13项回归、相关29项、完整verify/release各1481/1481及宿主检查通过；隔离summary UI及正式受控加载通过，新PID36424。历史数据核对边界见最终交付段，持续优化目标active。

## 复现与修正

第77轮截图显示waiting的summary仍标“最近审查已完成”。13项新回归折叠真实review start/progress/end和Planner事件，再渲染实际src/client.js：原实现9失败/4控制通过，RED日志保留。确定性数据已表明真实processState保留，错误只在header选择；不引入额外时序或缓存修改。

header依据active或最新历史审查的明确状态，区分暂停、失败、取消、进度未更新和完成；running保留当前message。Planner等待回答、失败及ready有各自提示。attempt卡片改为“第N次尝试”，不把恢复当新业务轮次。暂停仅描述记录状态，不授权resume。

最终相关29/29、单独13/13及typecheck通过，fail/cancelled/skipped/TODO0。13项回归覆盖真实投影与renderer，不修改后端DTO、线程生命周期、继续资格、reviewCycles或模型提示词。外部[固定XState机制](../research/github-workflow-state-presentation-patterns-2026-10-09.md)核对5份字节及许可，未新增依赖。

## 原生UI现场

独立DSH_HOME、端口3102，原PID33320/birthKey`win32:134359825551542990`。真实宿主SessionStore/SubagentRuntime/ToolRuntime/JSONL和浏览器组件，轻量Agent工厂及本地ScriptedGateway；使用当前src client，只有模块注册ID换成临时包名。

- Parent：`ui-recovery-parent-8bc3a677-80eb-4cba-8d7b-f54bd820ff4e`。
- Workflow：`34410613-07e0-461c-83ff-e3ef58f6f8f0`。
- Child：`c91c7472-e710-4104-a759-b351d28ed39b`。
- Thread：`reviewing-1e32d552-40f0-4e7f-bfd6-198232c0a4b7`。

两次受控模型失败后进入waiting，reviewCycles0。宿主guide未列出扩展summary入口，因此恢复一个合法原生summary标签布局，再通过真实UI选中；未改workflow或重跑模型，不作为summary导航入口验收。

实际DOM/截图为“审查已暂停”和“第1次尝试 · waiting”，无错误完成提示。省略workflowId的resume在原线程继续，成功后header为“最近审查已完成”，卡片第1/第2次尝试。原thread/child身份保持，各创建1；3个可见回合start/end平衡，reviewCycles1，child释放1次。没有新增业务审查轮次。

## 证据与保护

安全截图和回执：`output/playwright/status-20261009/`（Git忽略）。仓库外`../.codex-workflow-verification/eightythird-20261009/`保存原RED、最终局部结果、源码manifest、脚本和UI审计。原隔离两实例树按birth确认退出，命名浏览器dsh-status83关闭。

正式DSH保持第82轮PID57092，不为局部结果重载。真实provider自然失败、费用、完整AgentLoop和旧corrupt child恢复未验收；Planner的通用模型暂停没有独立processState字段，本轮仅处理其现有明确status，不声称补齐该数据契约。

## 唯一完整门禁

310份输入及同数原字节副本冻结，manifest SHA256为`1274AA7606C4F2147850AEDF0C6CC80762EB1FE53C53699B7938C389BCF09D4B`。09:42启动原runner PID38920/birthKey`win32:134359837411831380`，gate目录`final-gates-8d93ea58-35bb-40a1-8cc2-415aa9a3ce7f`。依次verify、release、host、host-recovery、diff，完整测试预期1481（1468+13）。首轮观察原runner仍活、verify已进入测试，冻结输入偏差0，尚无完整终态。

## 正式加载准备与实际守卫

本轮已准备9份绑定当前原gate、310/217/1481计数与source SHA的审计和加载脚本；原formal绑定PID57092/birthKey`win32:134359809091459730`。3份PowerShell语法解析错误0。旧auth-state只用于加载前查询，新实例日志/state使用独立eightythird文件名，保留新实例birth、原树退出和重复启动保护；没有改正式profile。

09:50在原verify仍运行且完整summary不存在时，执行实际controlled-reload负向检查：exit1，原完整gate summary unavailable；reload receipt和old tree文件均未生成，正式57092出生身份仍匹配。缺失门禁文件只证明加载被拒绝，不能作为新正式实例已启动的证据。

原runner38920仍活、310输入偏差0。正式只读查询413会话身份、111完整workflow、119queue及428会话文件保持，durable pending/有效租约/running/waiting0；实际停止前还会重新查询。以上准备和局部UI结果不代替完整门禁，不代表本轮已加载。

## 完整门禁与正式加载终态

原runner38920于10:16:07结束exit0。verify1481/1481，1003.39秒；release1481/1481，1010.35秒；两者fail/cancelled/skipped/TODO及异步警告0。host4.02秒、host-recovery6.78秒、11场景persistedColdReplay、diff均通过，doctor/pack通过且tarball清理。原最终计数独立解析通过，没有重跑或替换原runner。

217份最终build manifest SHA256为`FF09D8773125F27D8B805D593DC21682262E3F6B587E31037DEA6B9EC59E4B37`，source SHA保持。真实空闲和原PID57092出生身份重新核对后，原11实例树退出确认，一次启动新formal PID36424/birthKey`win32:134359863173341550`，birth `2026-10-09T10:25:17.3341550+08:00`，认证HTTP200。exec88314真实exit0；217build及27关键模块偏差0，stderr fatal0，running/waiting/durable pending/有效租约0。

重载前后实际会话都是414，身份hash相同；111workflow及119queue完整字段hash保持，原parent和corrupt child保持。旧长期基线为413会话/428文件，当前新增1会话文件，创建10:00、修改10:01，均早于重载。旧baseline比较先exit1，诊断后证实原428文件无任何缺失/修改，新增429th文件保留。新增文件没有重载前字节清单，因此不能声称它的重载前后字节已证明一致；会话身份已证明前后不变。未删除用户新增会话或改写旧基线，原不匹配日志保留。

正式boot和资源响应包含冻结client原字节、明确Reviewer状态文字及“第N次尝试”；source client SHA256`b7cea46b75d5f5b5325415e40dc43a3dd635fcb287dd9efd32e8c7d2330580f7`，服务包装响应SHA256`a0816f0b4a04ceadcf769ae719900dc58b54882ebe58ee5d6c556b4fec2eff4a`。读取未创建模型或会话。以上只交付现有明确状态展示，不声称修复尚未发布的Planner通用暂停字段；候选诊断见第84轮。

## 完整verify终态

原verify日志及summary确认1481/1481通过，fail/cancelled/skipped/TODO及异步警告0、exit0，1003.39秒。原runner进入release，完整门禁未结束。第84轮在仓库外真实host路径复现Planner通用模型暂停状态未进入plan投影；这是本轮已注明的数据契约边界，另行诊断，未改本轮冻结输入或扩大1481项结论。
