# DSH 0.1.7-rc.2 宿主适配实测记录（2026-09-25）

记录 `dsh-codex-workflow` **1.1.3**（提交 `660c126`，npm `dsh-codex-workflow@1.1.3`）对 **DSH `0.1.7-rc.2`** / **cordis `4.0.4`** 的宿主适配。此前基线为 DSH `0.1.5-rc.1` / cordis `4.0.2`。

定位：**对齐已验证基线并采用新消息源契约**，不是「消除一个被宿主判定为不兼容的 peer 范围」——后者经实测并不成立，见第 3 节。

---

## 1. 唯一真实破坏点：`MessageSourceMap` 不再有兜底 `plugin` kind

DSH 0.1.7 把消息来源从「共享的 catch-all」改成**合并可扩展联合类型**：每个生产者在自己模块里扩展 `MessageSourceMap`。原文（`@deepseek-ai/dsh-llm/lib/types/message.d.ts`）：

> Merge-extensible sum type — each producer declares its own `kind` in its own module; **there is no shared catch-all `plugin` kind**.

两条轴刻意独立：`kind` 回答「**谁**产生的」，`form` 回答「**是什么形态**」。`form` 的取值是语义词汇（`instructions` / `catalog` / `snapshot` / `notice` / `relay` / `recall`），颜色与折叠默认值属于消费方，不得进入该联合。其中 `notice` 形态**必须**携带一行摘要：

```ts
export type ContextFormed = … | { readonly form: 'notice'; readonly summary: string } | …
```

### 第一方写法（范例）

`@deepseek-ai/dsh-agent-instructions/lib/types/state.d.ts`：

```ts
export interface AgentInstructionSource {
    kind: 'agent-instructions';
    form: 'instructions';
    baseline?: true;
    changes: AgentInstructionChange[];
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'agent-instructions': AgentInstructionSource;
    }
}
```

### 本仓库写法

[`src/message-source.ts`](../src/message-source.ts) 按同一模式声明本插件自己的 kind：

| 项 | 值 |
|---|---|
| `kind` | `"dsh-codex-workflow"` |
| `form` | `relay`（计划交接 / verdict / 提交通知）、`notice`（续跑通知，带 `summary`） |
| 构造器 | `relaySource()`、`noticeSource(summary)` |
| 注入点 | `src/bridge-runtime.ts` 三处（计划交接、verdict、提交通知）+ `src/workflow.ts` 一处（续跑 notice） |

旧写法 `{ kind: "plugin", plugin: "dsh-codex-workflow", … }` 只能用 `as any` 通过编译——**能编译不等于满足契约**：强转把契约从编译器眼前藏起来，也让宿主无法把这段上下文归属到一个已声明的生产者。

---

## 2. 前提修正：兼容性由宿主自己判定，且预发布参与范围匹配

适配开始时我按 npm 严格 semver 的预发布规则推断「旧范围 `^0.1.5-rc.1` 与运行时 `0.1.7-rc.2` 不兼容、需要用户豁免」。两条结论现在**都已实测**：npm 侧确实判不兼容（第 5 节的 `npx semver@7.7.3` 命令），而**宿主自己的**评估器判为兼容——决定实际行为的是宿主：

| 判定者 | 语义 | 对 `^0.1.5-rc.1` vs `0.1.7-rc.2` 的结论 |
|---|---|---|
| npm 严格 semver | 预发布版本仅在 `major.minor.patch` 相同且比较符带预发布时才参与 | **不兼容**（实测，见第 5 节命令：`npx --yes semver@7.7.3 0.1.7-rc.2 -r "^0.1.5-rc.1"` → 无输出、退出码 1） |
| 宿主 `evaluatePluginCompatibility` | **Prereleases participate in ranges** | **COMPATIBLE**（实测） |

宿主侧判定入口（`@deepseek-ai/dsh-app-boot`）：

```ts
getDshRuntimeVersion(): string
evaluatePluginCompatibility(manifest, exemptions?, runtimeVersion?): PluginCompatibility | undefined
pluginCompatibilityWarning(issue): string
```

- 它**只检查** `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` peer；`@deepseek-ai/cordis` 不在判定集合内（把 cordis 收窄到 `4.0.2` 时它不报未满足）。
- 未满足时的提示给出精确版本豁免通道：`dsh plugin allow-version`。
- 因此本次适配的定位是「对齐已验证基线 + 采用新契约」，文档与 CHANGELOG 均按此表述。

---

## 3. 门禁与负向证据

| 门禁 | 位置 | 行为 |
|---|---|---|
| 宿主兼容 | `scripts/host-compat-check.mjs` | 加载构建产物（隔离临时存储）后，用宿主评估器判定 peer 范围，输出 `peerCompatible` 与 `declaredPeers`；不满足即断言失败 |
| 宿主兼容（离线安全） | `scripts/doctor.mjs` | 同名检查；**无 DSH profile 时标记 SKIPPED，绝不当作通过**，故 `pnpm release:check` 继承该门禁 |
| 声明一致性 | `scripts/release-check.mjs` | 每个 `dsh` peer 范围必须等于其钉住的 devDependency 的 `^` 版本 |

**负向验证（证明门禁不是空转）**：在仓库外的临时 manifest 中把 `@deepseek-ai/dsh-tools` 收窄为 `^0.1.9-rc.1`，调用同一宿主评估器：

```
COMPATIBLE        = NO
unsatisfied peers = {"@deepseek-ai/dsh-tools":"^0.1.9-rc.1"}
exempted          = false
warning           = Plugin dsh-codex-workflow@1.1.3 is incompatible with dsh 0.1.7-rc.2: peerDependencies
                    {"@deepseek-ai/dsh-tools":"^0.1.9-rc.1"}. … grant the exact-version exemption … with
                    `dsh plugin allow-version` …
```

对照：用**旧清单所在的那个提交** `b280ea5`（`fix: support DSH 0.1.5 and persistent review-only tasks`）的 `package.json`（peer `^0.1.5-rc.1`）跑同一评估器得到 `COMPATIBLE = yes`——即第 2 节修正的原始证据。注意**不能用 `HEAD`**：1.1.3（`660c126`）起 `HEAD` 的该 peer 已是 `^0.1.7-rc.2`，那样取到的是新清单而非旧清单。

---

## 4. 依赖与类型声明事实

| 事实 | 证据 |
|---|---|
| `@deepseek-ai/dsh-code-runtime` 没有 `0.1.7-rc.2` 发布 | registry：latest `0.0.1-rc.1`、next `0.1.5-rc.3` |
| 该包在仓库内无任何引用，也无传递依赖需要 | `src/`、`test/`、`scripts/`、`tsconfig*` 全量搜索无命中；`@deepseek-ai/dsh-tools` 不依赖它 → 已从 devDependencies 移除 |
| 新版类型声明位置 | `lib/types/**/*.d.ts`；包根 `types` 指向 `lib/types/index.d.ts`（旧版按 `lib/*.d.ts` 找不到） |
| `MessageSourceMap` 定义处 | `@deepseek-ai/dsh-llm/lib/types/message.d.ts`（经桶文件 `export * from './message.ts'` 导出） |

---

## 5. 可复现命令

| 命令 | 实测结果 |
|---|---|
| `pnpm typecheck` | 通过（新类型下，且已无 `as any` 绕过） |
| `pnpm test` | **424 tests / 424 pass / 0 fail** |
| `pnpm verify` | typecheck + 测试通过 |
| `pnpm release:check` | `RELEASE_CHECK_OK` |
| `pnpm host:check` | `{"ok":true,"hostVersion":"0.1.7-rc.2","pluginVersion":"1.1.3","toolsRegistered":8,"unloaded":true,"storage":"isolated-temp","peerCompatible":true}` |
| `node scripts/doctor.mjs --offline --json` | `ok: true`；新增行 `plugin dsh peer range covers the installed runtime` = `skipped:false`、`detail: "dsh 0.1.7-rc.2"` |
| `npx --yes semver@7.7.3 0.1.7-rc.2 -r "^0.1.5-rc.1"` | **无输出、退出码 1** → npm 严格 semver 判定旧范围与运行时**不兼容**（第 2 节表格第一行的实测依据；`semver@7.7.3` 即 npm 随附版本） |
| `npx --yes semver@7.7.3 0.1.7-rc.2 -r "^0.1.7-rc.2"` | 正向对照：输出 `0.1.7-rc.2`、退出码 0 → 同一工具对**新范围**判定兼容 |
| 发布产物验证 | `npm install dsh-codex-workflow@1.1.3 --prefix <临时目录> --prefer-online`，再运行**该副本自带**的 `scripts/host-compat-check.mjs`：同样 `ok:true` / 8 工具 / `peerCompatible:true`；副本 `scripts/doctor.mjs --offline --json` 亦 `ok:true` |

registry 传播实测：`npm publish` 服务端只回 `PUT 202`（异步受理），带 cache-buster 轮询第 9 次（约 3 分钟）后 `dist-tags.latest` 变为 `1.1.3`；随后实装核对 88 文件、`lib/version.js`=1.1.3、`CHANGELOG` 含 `## [1.1.3]`、`cordis.patch.yml` 在、`lib/message-source.js` 随包发布、无 `test/` `docs/` `.git` 混入。

---

## 6. 边界说明

- 本文只记录**实际运行得到**的输出；源码静态检查不作为运行时证据。
- `pnpm lifecycle:accept` / `pnpm review-only:accept` 是需真实登录的手工脚本，且自 1.1.0 起未同步专用 Reviewer 布局，不作为证据。
- 其他 0.1.x 版本**未经本仓库验证**；声明的 peer 范围以 `^0.1.7-rc.2` 为准。
