# 第85轮：当前会话文件基线与加载守卫

状态：第84轮完整门禁仍在原runner执行；本轮仅改仓库外加载/审计脚本并保存诊断，冻结产品输入不变。正式DSH保持PID36424，未重载。

## 需要补齐的证据

第83轮重载前后414会话身份一致，但旧长期文件基线为428份，当前已429份。原428份hash全一致；新会话文件创建/修改均早于重载，可证明不是重载后新建，不能证明其重载前后字节未变。旧基线不应被覆盖，也不应删新增会话来让比较通过。

本轮在实际受控重载链里增加当前全量文件基线：门禁、source/build及原formal身份通过后，先观察真实工作状态，再采集所有现存会话文件，之后复查会话身份/workflow/queue及running/waiting/lease。采集期间发生变化则停止加载，保留原实例和证据。

## 实现和真实预检

仓库外`formal-session-files.mjs`对文件路径、字节数及SHA256连续采集两次；两份不一致时拒绝基线。capture通过wx写入明确命名的不可覆盖文件，verify比较该文件完整清单并输出新增/缺失/修改数量。每份基线拥有独立comparison文件，不用样本覆盖实际重载结果。

当前样本429份，两次读取匹配；capture和verify均exit0，新增/缺失/修改0，manifest SHA256`3f64bebf8cf8bd8e896a102ca2cd4039abd0f736b3955549a67f2750741ad9b9`。再次capture同一目标exit1，原基线hash保持，覆盖守卫通过。没有打印聊天正文或凭据。

样本路径为`session-files-preparation-sample.json`，仅证明采集器当前可用；真正加载时会新建`formal-session-files-before.json`，随后比较`formal-session-files-before-comparison.json`。实际基线未写，不能将10:50样本当作后来停止前证据。连续读取与状态复查也是观测守卫，不声称已取得数据库/会话全局事务或阻止未来用户写入。

## 原加载链准备

第84轮证据目录准备8份审计/加载脚本，绑定311/217/1490、原gate目录及source SHA；formal绑定PID36424/birthKey`win32:134359863173341550`。PowerShell三份语法解析错误0，新file helper语法有效。

实际controlled-reload在原门禁未结束时exit1：缺完整summary。随后确认reload receipt、实际文件baseline、原tree文件均未生成，原formal出生身份匹配；没有停止或创建正式实例。该负向测试在采集/停止前拒绝，不证明未来真实重载已成功。

原runner49424/birthKey`win32:134359875955879220`继续执行第84轮门禁，verify日志推进。当前311冻结输入hash偏差0，正式服务健康和历史身份仍由只读核对保证；放行要等待这个原runner全部门禁终态。

## 证据

仓库外第84轮目录保存file helper、样本、overwrite guard、reload-preparation、current-file-baseline-preflight及incomplete-reload guard。没有改正式profile/provider、历史文件或旧基线，没有新建模型线程、commit/push/publish。
