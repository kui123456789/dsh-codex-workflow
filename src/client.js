/* Browser half of dsh-codex-workflow.  It deliberately uses only the public
 * right-sidebar/session faces so the Host workflow package remains reusable by
 * headless DSH profiles. */
window.__ModuleLoader__.load({
  id: "dsh-codex-workflow",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const { useSyncExternalStore } = React;
    const TAB_ID = "dsh-codex-workflow-review";
    const TAB_KIND = "codex-review";
    const SETTINGS_TAB_ID = "dsh-codex-workflow-settings";
    const MODEL_OPTIONS = [["", "自动（跟随 App Server 默认模型）"]];
    const EFFORT_OPTIONS = [
      ["low", "低 · 更省额度"],
      ["medium", "中 · 平衡"],
      ["high", "高 · 更完整"],
      ["xhigh", "极高 · 更深推理"],
      ["max", "最大 · 高消耗"],
      ["ultra", "Ultra · 最高消耗"],
    ];
    const CONVERSION_TRANSPORT_OPTIONS = [
      ["app-server", "App Server 同线程（推荐）"],
      ["cli", "CLI 冷启动（较慢）"],
    ];
    const CONVERSION_FALLBACK_OPTIONS = [
      ["cli", "失败时使用 CLI 兜底"],
      ["fail", "失败即报告错误"],
    ];
    const codexSubagentAddress = (parentSessionId, childSessionId) =>
      `dsh-resource://subagentchat/session/${encodeURIComponent(childSessionId)}?parent=${encodeURIComponent(parentSessionId)}&mode=one-shot`;

    const LOADING_PROJECTION = Object.freeze({ currentWorkflowId: null, plan: null, activeReview: null, reviews: Object.freeze([]) });
    const EMPTY_PROJECTION = Object.freeze({ currentWorkflowId: null, plan: null, activeReview: null, reviews: Object.freeze([]) });
    const subscribeToNothing = () => () => {};

    function useProjection(face) {
      const read = () => face?.getSnapshot?.() ?? LOADING_PROJECTION;
      return useSyncExternalStore(face?.subscribe ?? subscribeToNothing, read, read);
    }

    function LiveLog({ entries }) {
      const scrollRef = React.useRef(null);
      const followRef = React.useRef(true);
      const [toolGroupsOpen, setToolGroupsOpen] = React.useState(false);
      React.useEffect(() => {
        const node = scrollRef.current;
        if (node && followRef.current) node.scrollTop = node.scrollHeight;
      }, [entries]);
      if (!Array.isArray(entries) || entries.length === 0) return null;
      const labels = { message: "Codex", plan: "计划", reasoning: "思路摘要", tool: "工具" };
      const groups = [];
      for (const entry of entries) {
        const previous = groups[groups.length - 1];
        if (entry.kind === "tool" && previous?.kind === "tool") previous.entries.push(entry);
        else groups.push({ kind: entry.kind, entries: [entry] });
      }
      const renderEntry = (entry, index) => h("div", { key: `${entry.kind}:${entry.itemId}:${index}`,
        style: { borderLeft: "2px solid var(--border-color, #4a5568)", paddingLeft: 12, minWidth: 0 } },
        h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, labels[entry.kind] || "Codex"),
        entry.kind === "tool" && (entry.command || entry.cwd || entry.exitCode !== undefined || entry.files?.length)
          ? h("div", { style: { fontSize: 12, opacity: 0.8, whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginBottom: 4 } },
              entry.command ? `命令：${entry.command}` : "",
              entry.cwd ? `\n目录：${entry.cwd}` : "",
              entry.exitCode !== undefined ? `\n退出码：${entry.exitCode}` : "",
              entry.files?.length ? `\n文件：${entry.files.join(", ")}` : "")
          : null,
        h("pre", { style: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 } }, entry.text),
      );
      return h("div", { "aria-label": "Codex 实时输出", ref: scrollRef,
        onScroll: (event) => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; },
        style: { display: "grid", gap: 10, margin: "12px 0", maxHeight: "min(70vh, 760px)", overflowY: "auto", paddingRight: 6 } },
        ...groups.map((group, groupIndex) => group.kind === "tool"
          ? h("details", { key: `tools:${groupIndex}`, open: toolGroupsOpen, onToggle: (event) => setToolGroupsOpen(event.currentTarget.open),
              style: { border: "1px solid var(--border-color, #374151)", borderRadius: 8, padding: "6px 10px" } },
            h("summary", { style: { cursor: "pointer", fontSize: 12, opacity: 0.8 } }, `工具使用流程 · ${group.entries.length} 条（可展开查看完整内容）`),
            h("div", { style: { display: "grid", gap: 10, marginTop: 10 } }, ...group.entries.map(renderEntry)),
          )
          : group.entries.map(renderEntry)),
      );
    }

    const UNAVAILABLE_CONFIG_SNAPSHOT = Object.freeze({ status: "unavailable", value: undefined, writable: false });

    function readConfigSnapshot(form) {
      try {
        const snapshot = form?.getSnapshot?.();
        return snapshot && typeof snapshot === "object"
          ? snapshot
          : UNAVAILABLE_CONFIG_SNAPSHOT;
      } catch {
        return UNAVAILABLE_CONFIG_SNAPSHOT;
      }
    }

    function SettingsBody({ configForm, connection }) {
      // Keep this page deliberately independent from the live projection
      // hooks. The settings host may mount the tab before its ConfigForm has
      // answered; a synchronous, guarded read keeps the page visible then.
      const subscribe = typeof configForm?.subscribe === "function"
        ? configForm.subscribe.bind(configForm)
        : () => () => {};
      const snapshot = React.useSyncExternalStore(subscribe, () => readConfigSnapshot(configForm));
      const value = snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
      const [modelOptions, setModelOptions] = React.useState(MODEL_OPTIONS);
      const [catalogState, setCatalogState] = React.useState("loading");
      React.useEffect(() => {
        let active = true;
        const rpc = connection?.rpc;
        if (typeof rpc?.call !== "function") { setCatalogState("unavailable"); return; }
        void rpc.call("/dsh-codex-workflow", "models", { args: {} })
          .then((result) => result?.ok ? result.value : Promise.reject(new Error(result?.error?.message || "model catalog RPC failed")))
          .then((payload) => {
            if (!active || !Array.isArray(payload?.models)) return;
            const dynamic = [["", "自动（跟随 App Server 默认模型）"], ...payload.models
              .filter((model) => model && typeof model.id === "string" && model.id.length > 0)
              .map((model) => [model.id, typeof model.name === "string" && model.name ? model.name : model.id])];
            if (dynamic.length > 1) { setModelOptions(dynamic); setCatalogState("ready"); }
            else setCatalogState("unavailable");
          }).catch(() => { if (active) setCatalogState("unavailable"); });
        return () => { active = false; };
      }, [connection]);
      const setField = (field, next, event) => {
        if (!configForm || !snapshot.writable || typeof configForm.set !== "function") return;
        const section = event?.currentTarget?.closest?.("section");
        const status = section?.querySelector?.("[data-settings-status]");
        if (status) status.textContent = "正在保存…";
        try {
          const result = configForm.set(field, next);
          const done = result && typeof result.then === "function" ? result : Promise.resolve(result);
          void done.then((accepted) => {
            if (status) status.textContent = accepted === false ? "保存被宿主拒绝" : "已写入当前 DSH profile；可点击‘打开配置文件’核对";
          }).catch((error) => {
            if (status) status.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`;
            if (typeof console !== "undefined" && typeof console.error === "function") console.error("[dsh-codex-workflow] settings save failed", error);
          });
        } catch {
          if (status) status.textContent = "保存失败：ConfigForm.set 抛出异常";
        }
      };
      const select = (field, label, description, options) => {
        const current = typeof value[field] === "string" ? value[field] : options[0][0];
        const choices = options.some(([id]) => id === current) ? options : [[current, `${current}（当前配置）`], ...options];
        return h("label", { key: field, style: { display: "grid", gap: 6, marginBottom: 16 } },
          h("span", { style: { fontWeight: 600 } }, label),
          h("small", { style: { opacity: 0.7, lineHeight: 1.45 } }, description),
          h("select", { value: current, disabled: !snapshot.writable, onChange: (event) => setField(field, event.target.value, event),
            style: { width: "100%", padding: "9px 10px", borderRadius: 8, background: "#27272a", color: "#f4f4f5", colorScheme: "dark" } },
            ...choices.map(([id, text]) => h("option", { key: id, value: id, style: { backgroundColor: "#27272a", color: "#f4f4f5" } }, text)),
          ),
        );
      };
      return h("section", { className: "dsh-codex-settings", "aria-label": "Codex 工作流设置", style: { maxWidth: 760 } },
        h("h2", null, "Codex 工作流"),
        h("p", { style: { opacity: 0.75, lineHeight: 1.5 } }, "选择 Planner 和 Reviewer 使用的模型与推理程度。留空表示跟随当前 Codex App Server 默认模型。"),
        snapshot.status === "loading" && h("p", { role: "status" }, "正在读取配置…"),
        snapshot.status === "unavailable" && h("p", { role: "alert" }, "当前宿主没有开放可写的插件设置。"),
        catalogState === "loading" && h("p", { role: "status" }, "正在读取 Codex 模型目录…"),
        catalogState === "unavailable" && h("p", { role: "alert" }, "Codex 模型目录暂不可用；当前配置仍会显示，其他模型暂不能选择。"),
        h("p", { "data-settings-status": true, role: "status", style: { minHeight: 20, opacity: 0.85 } }, snapshot.writable ? "选择后自动保存到 DSH profile 配置" : "等待 DSH 配置表单就绪"),
        select("plannerModel", "Planner 模型", "负责制定计划；模型选择会在下一次规划时生效。", modelOptions),
        select("plannerEffort", "Planner 推理程度", "推理程度越高通常越完整，也会消耗更多额度。", EFFORT_OPTIONS),
        select("reviewerModel", "Reviewer 模型", "负责审查和复审；每一轮新审查读取当前配置。", modelOptions),
        select("reviewerEffort", "Reviewer 推理程度", "只影响可见 Reviewer 回合；内部结构化转换仍使用低推理档。", EFFORT_OPTIONS),
        select("conversionTransport", "结构化转换通道", "归一和权威对齐默认复用 App Server；CLI 冷启动可作为兼容选项。", CONVERSION_TRANSPORT_OPTIONS),
        select("conversionFallback", "转换失败处理", "选择是否允许从 App Server 转换降级到 CLI；降级会在审查状态中显示。", CONVERSION_FALLBACK_OPTIONS),
      );
    }

    function ReviewBody({ projectionFace, useTabInfo }) {
      const projection = useProjection(projectionFace);
      const info = useTabInfo();
      if (projection === LOADING_PROJECTION) {
        return h("section", { className: "dsh-codex-review", "aria-label": "Codex Review" },
          h("h2", null, "Codex Review"), h("p", { role: "status" }, "正在加载工作流状态"));
      }
      const reviews = Array.isArray(projection.reviews) ? projection.reviews : [];
      const latest = projection.activeReview || reviews.at(-1);
      let status = latest
        ? latest.processState === "running"
          ? latest.message || "Codex 正在审查"
          : ({ waiting: "审查已暂停", completed: "最近审查已完成", failed: "审查失败",
              cancelled: "审查已取消", stale: "审查进度暂未更新" })[latest.processState] || "审查状态未知"
        : "等待审查";
      if (!projection.activeReview && projection.plan) {
        if (projection.plan.status === "planning") status = projection.plan.processState === "waiting" ? "规划已暂停" : "Codex 正在规划";
        else if (projection.plan.status === "waiting_input") status = "规划等待用户回答";
        else if (!latest) status = ({ failed: "规划失败", ready: "规划已完成" })[projection.plan.status] || status;
      }
      return h("section", { className: "dsh-codex-review", "aria-label": "Codex Review" },
        h("header", { className: "dsh-codex-review-header" },
          h("h2", null, "Codex Review"),
          h("span", { role: "status" }, status),
        ),
        projection.plan && h("details", { open: true },
          h("summary", null, "Planner", " · ", projection.plan.status),
          h(LiveLog, { entries: projection.plan.live }),
          projection.plan.planMarkdown && h("pre", { className: "dsh-codex-review-plan",
            style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 } }, projection.plan.planMarkdown),
          projection.plan.questions?.length > 0 && h("div", null,
            h("h3", null, "待回答问题"),
            ...projection.plan.questions.map((question, index) => h("p", { key: question.id || index }, `${index + 1}. ${question.question}`)),
          ),
          projection.plan.assumptions?.length > 0 && h("div", null,
            h("h3", null, "假设"),
            h("ul", null, ...projection.plan.assumptions.map((assumption, index) => h("li", { key: index }, assumption))),
          ),
          projection.plan.status === "failed" && projection.plan.message && h("p", { role: "alert" }, projection.plan.message),
        ),
        reviews.length === 0 && h("p", null, "暂无审查结果"),
        ...reviews.map((review, index) => h("details", {
          key: review.reviewId || index,
          open: review.reviewId === projection.activeReview?.reviewId || index === reviews.length - 1,
        },
          h("summary", null, `第 ${review.attempt || index + 1} 次尝试`, " · ", review.processState, review.verdict ? ` · ${review.verdict}` : ""),
          h("p", null, review.message || ""),
          h(LiveLog, { entries: review.live }),
          review.visibleText && h("pre", { className: "dsh-codex-review-text",
            style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 } }, review.visibleText),
          review.result && h("div", { className: "dsh-codex-review-result" },
            h("h3", null, "VERDICT"), h("p", null, review.result.verdict),
            h("h3", null, "FINDINGS"),
            review.result.findings?.length
              ? h("ul", null, ...review.result.findings.map((finding, findingIndex) => h("li", { key: findingIndex }, `[${finding.severity}] ${finding.title}: ${finding.body}`)))
              : h("p", null, "none"),
            h("h3", null, "TEST GAPS"),
            review.result.testGaps?.length
              ? h("ul", null, ...review.result.testGaps.map((gap, gapIndex) => h("li", { key: gapIndex }, gap)))
              : h("p", null, "none"),
            h("h3", null, "SUMMARY"), h("p", null, review.result.summary),
          ),
          review.error && h("p", { role: "alert" }, review.error),
        )),
        info?.tab?.visible === false && h("span", { hidden: true }, "Codex Review"),
      );
    }

    return {
      name: "dsh-codex-workflow-ui",
      inject: ["slots", "sidebarRight", "sidebarRightTabs", "sessions", "configForms", "connection"],
      apply(ctx) {
        const disposers = [];
        let disposed = false;
        const workflowFaces = new Map();
        const projectionOf = (sessionId) => {
          const binding = sessionId ? ctx.sessions.binding(sessionId) : undefined;
          const legacy = binding?.session.projections.faceOf("codexWorkflow");
          if (!sessionId || typeof ctx.connection?.rpc?.call !== "function") return legacy;
          let face = workflowFaces.get(sessionId);
          if (!face) {
            const listeners = new Set();
            let legacyFace;
            let legacyDisposer;
            let externalState = false;
            let externalProjection;
            let projectionJson;
            let timer;
            let request;
            let generation = 0;
            let closed = false;
            const publish = () => { for (const listener of [...listeners]) listener(); };
            const stop = () => {
              generation += 1;
              if (timer !== undefined) clearTimeout(timer);
              timer = undefined;
              request?.abort();
              request = undefined;
              legacyDisposer?.();
              legacyDisposer = undefined;
              if (workflowFaces.get(sessionId) === face) workflowFaces.delete(sessionId);
            };
            const poll = async () => {
              if (closed || disposed || listeners.size === 0 || request) return;
              const epoch = generation;
              const controller = new AbortController();
              request = controller;
              try {
                const result = await ctx.connection.rpc.call("/dsh-codex-workflow", "workflow-state", { args: { sessionId } }, controller.signal);
                if (epoch !== generation || closed || disposed || controller.signal.aborted) return;
                const value = result?.ok ? result.value : undefined;
                if (typeof value?.externalState !== "boolean") return;
                if (value.externalState && value.projection !== null && (!value.projection || !Array.isArray(value.projection.reviews))) return;
                const previous = face.getSnapshot();
                externalState = value.externalState;
                if (externalState) {
                  const serialized = JSON.stringify(value.projection);
                  if (serialized !== projectionJson) {
                    projectionJson = serialized;
                    externalProjection = value.projection ?? EMPTY_PROJECTION;
                  }
                }
                if (face.getSnapshot() !== previous) publish();
              } catch {
                // A reconnect must not erase the last durable sidebar value.
              } finally {
                if (epoch === generation && request === controller) {
                  request = undefined;
                  if (!closed && !disposed && listeners.size > 0) timer = setTimeout(poll, 1_000);
                }
              }
            };
            face = {
              getSnapshot: () => externalState ? externalProjection : legacyFace?.getSnapshot?.(),
              setLegacy: (next) => {
                if (legacyFace === next) return;
                legacyDisposer?.();
                legacyDisposer = undefined;
                legacyFace = next;
                if (listeners.size > 0) legacyDisposer = legacyFace?.subscribe(publish);
              },
              subscribe: (listener) => {
                if (closed || disposed) return subscribeToNothing();
                listeners.add(listener);
                if (listeners.size === 1) {
                  workflowFaces.set(sessionId, face);
                  legacyDisposer = legacyFace?.subscribe(publish);
                  void poll();
                }
                let subscribed = true;
                return () => {
                  if (!subscribed) return;
                  subscribed = false;
                  listeners.delete(listener);
                  if (listeners.size === 0) stop();
                };
              },
              dispose: () => { closed = true; listeners.clear(); stop(); },
            };
            workflowFaces.set(sessionId, face);
          }
          face.setLegacy(legacy);
          return face;
        };
        const tabDefinition = {
          id: TAB_ID,
          kind: TAB_KIND,
          multiple: false,
          priority: "extension",
          title: () => "Codex Review",
        };
        disposers.push(ctx.sidebarRightTabs.register(tabDefinition));
        disposers.push(ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: TAB_ID,
          inject: (sessionId) => ({
            projectionFace: projectionOf(sessionId),
          }),
        }, ReviewBody)));
        disposers.push(ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
          name: "sidebar.right.pane.tab.title",
          key: TAB_ID,
        }, () => h("span", null, "Codex Review"))));

        // Register the tab even while the Host form is still loading. The
        // component renders an explicit unavailable/loading state instead of
        // leaving the selected tab blank, and resolves the form at render time
        // so late config-form publication is observed after a settings refresh.
        disposers.push(ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
          name: "settings.plugins.tab",
          id: SETTINGS_TAB_ID,
          order: 40,
          label: "Codex 工作流",
          inject: () => {
            try {
              return { configForm: ctx.configForms?.get?.("dsh-codex-workflow"), connection: ctx.connection };
            } catch {
              return { configForm: undefined, connection: ctx.connection };
            }
          },
        }, SettingsBody)));

        let currentSessionId;
        let currentProjectionFace;
        let currentProjectionDisposer;
        const releaseProjection = () => {
          const dispose = currentProjectionDisposer;
          currentProjectionDisposer = undefined;
          dispose?.();
        };
        const opened = new Set();
        const opening = new Set();
        const openRetries = new Map();
        const retryTimers = new Map();
        const exhaustedOpenRetries = new Set();
        const MAX_OPEN_RETRIES = 8;
        const OPEN_RETRY_WINDOW_MS = 15_000;
        const RETRY_DELAY_MS = 150;
        let faceRetryTimer;
        let faceRetryAttempts = 0;
        const warn = (message, error) => {
          if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`[dsh-codex-workflow] ${message}`, error || "");
        };
        const clearRetryTimer = (key) => {
          const timer = retryTimers.get(key);
          if (timer) clearTimeout(timer);
          retryTimers.delete(key);
        };
        const scheduleOpenRetry = (key, reason) => {
          if (disposed) return;
          const now = Date.now();
          const previous = openRetries.get(key) || { attempts: 0, firstAt: now };
          if (now - previous.firstAt >= OPEN_RETRY_WINDOW_MS || previous.attempts >= MAX_OPEN_RETRIES) {
            openRetries.delete(key);
            exhaustedOpenRetries.add(key);
            clearRetryTimer(key);
            warn(`giving up sidebar open after ${previous.attempts} attempts (${reason})`);
            return;
          }
          const next = { attempts: previous.attempts + 1, firstAt: previous.firstAt };
          openRetries.set(key, next);
          if (retryTimers.has(key)) return;
          const timer = setTimeout(() => {
            retryTimers.delete(key);
            scan();
          }, RETRY_DELAY_MS);
          retryTimers.set(key, timer);
        };
        const mayOpen = (key) => {
          if (exhaustedOpenRetries.has(key)) return false;
          const retry = openRetries.get(key);
          if (retry && Date.now() - retry.firstAt >= OPEN_RETRY_WINDOW_MS) {
            scheduleOpenRetry(key, "original retry window expired");
            return false;
          }
          return true;
        };
        const scheduleFaceRetry = () => {
          if (disposed) return;
          if (faceRetryTimer || faceRetryAttempts >= 40) return;
          faceRetryAttempts += 1;
          faceRetryTimer = setTimeout(() => {
            faceRetryTimer = undefined;
            scan();
          }, RETRY_DELAY_MS);
        };
        const scan = () => {
          // A Host notifier may already have captured this callback before
          // unsubscribe. Retired clients must not reacquire sidebar resources.
          if (disposed) return;
          const sessionId = ctx.sidebarRight.mounted.getSnapshot();
          if (sessionId !== currentSessionId) {
            releaseProjection();
            currentSessionId = sessionId;
            currentProjectionFace = undefined;
            faceRetryAttempts = 0;
          }
          if (!sessionId) {
            scheduleFaceRetry();
            return;
          }
          let face;
          try {
            face = projectionOf(sessionId);
          } catch (error) {
            warn(`failed to resolve workflow projection for ${sessionId}`, error);
            scheduleFaceRetry();
            return;
          }
          if (face !== currentProjectionFace) {
            releaseProjection();
            currentProjectionFace = face;
            currentProjectionDisposer = face?.subscribe(scan);
          }
          if (!face) {
            scheduleFaceRetry();
            return;
          }
          if (faceRetryTimer) {
            clearTimeout(faceRetryTimer);
            faceRetryTimer = undefined;
          }
          const projection = face.getSnapshot();
          if (!projection) {
            scheduleFaceRetry();
            return;
          }
          faceRetryAttempts = 0;
          const active = projection.activeReview;
          const latest = active || projection.reviews?.at?.(-1);
          // Waiting and completed reviews retain their child in the history.
          // Keep that native conversation visible after activeReview is cleared.
          const childSessionId = latest?.childSessionId || projection.plan?.childSessionId;
          if (childSessionId && typeof ctx.sidebarRight.openResource === "function") {
            const key = `${sessionId}:subagent:${childSessionId}`;
            const address = codexSubagentAddress(sessionId, childSessionId);
            if (!opened.has(key) && !opening.has(key) && mayOpen(key)) {
              if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) {
                scheduleOpenRetry(key, "session seat changed before native open");
                return;
              }
              opening.add(key);
              try {
                ctx.sidebarRight.openResource(address, { kind: "subagentchat" });
                opened.add(key);
                openRetries.delete(key);
                clearRetryTimer(key);
                const activeTab = typeof ctx.sidebarRight.active === "function" ? ctx.sidebarRight.active() : undefined;
                if (activeTab?.contentId && activeTab.contentId !== address) {
                  warn(`native sidebar open was not immediately active for ${childSessionId}`);
                }
              } catch (error) {
                warn(`native sidebar open failed for ${childSessionId}`, error);
                scheduleOpenRetry(key, "openResource threw");
              } finally {
                opening.delete(key);
              }
            }
            return;
          }
          const target = latest
            ? {
                key: `${sessionId}:review:${latest.reviewId}`,
                params: { workflowId: latest.workflowId, reviewId: latest.reviewId },
              }
            : projection.plan && projection.currentWorkflowId
              ? {
                  key: `${sessionId}:plan:${projection.currentWorkflowId}`,
                  params: { workflowId: projection.currentWorkflowId },
                }
              : undefined;
          if (!target) return;
          const key = target.key;
          if (!opened.has(key) && !opening.has(key) && mayOpen(key)) {
            if (ctx.sidebarRight.mounted.getSnapshot() !== sessionId) {
              scheduleOpenRetry(key, "session seat changed before fallback open");
              return;
            }
            opening.add(key);
            try {
              ctx.sidebarRight.openTab(TAB_KIND, { revealIfOpened: true, params: target.params });
              if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) {
                opened.add(key);
                openRetries.delete(key);
                clearRetryTimer(key);
              } else {
                scheduleOpenRetry(key, "session seat changed after fallback open");
              }
            } catch (error) {
              warn(`fallback sidebar open failed for ${key}`, error);
              scheduleOpenRetry(key, "openTab threw");
            } finally {
              opening.delete(key);
            }
          }
        };
        disposers.push(ctx.sidebarRight.mounted.subscribe(scan));
        scan();
        return () => {
          if (disposed) return;
          disposed = true;
          if (faceRetryTimer) clearTimeout(faceRetryTimer);
          faceRetryTimer = undefined;
          for (const timer of retryTimers.values()) clearTimeout(timer);
          retryTimers.clear();
          openRetries.clear();
          exhaustedOpenRetries.clear();
          opening.clear();
          releaseProjection();
          for (const face of [...workflowFaces.values()]) face.dispose();
          workflowFaces.clear();
          for (const dispose of disposers.reverse()) dispose?.();
        };
      },
    };
  },
});
