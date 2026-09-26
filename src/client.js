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

    function emptyProjection() {
      return { currentWorkflowId: null, plan: null, activeReview: null, reviews: [] };
    }

    function useProjection(face) {
      return useSyncExternalStore(
        face?.subscribe ?? (() => () => {}),
        face?.getSnapshot ?? emptyProjection,
        face?.getSnapshot ?? emptyProjection,
      );
    }

    function LiveLog({ entries }) {
      if (!Array.isArray(entries) || entries.length === 0) return null;
      const labels = { message: "Codex", plan: "计划", reasoning: "思路摘要", tool: "工具" };
      return h("div", { "aria-label": "Codex 实时输出", style: { display: "grid", gap: 10, margin: "12px 0" } },
        ...entries.map((entry, index) => h("div", { key: `${entry.kind}:${entry.itemId}:${index}`,
          style: { borderLeft: "2px solid var(--border-color, #4a5568)", paddingLeft: 12, minWidth: 0 } },
          h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, labels[entry.kind] || "Codex"),
          h("pre", { style: { margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13, lineHeight: 1.55 } }, entry.text),
        )),
      );
    }

    function ReviewBody({ projectionFace, useTabInfo }) {
      const projection = useProjection(projectionFace);
      const info = useTabInfo();
      const reviews = Array.isArray(projection.reviews) ? projection.reviews : [];
      return h("section", { className: "dsh-codex-review", "aria-label": "Codex Review" },
        h("header", { className: "dsh-codex-review-header" },
          h("h2", null, "Codex Review"),
          projection.activeReview
            ? h("span", { role: "status" }, projection.activeReview.message || "Codex 正在审查")
            : projection.plan?.status === "planning"
              ? h("span", { role: "status" }, "Codex 正在规划")
            : h("span", { role: "status" }, reviews.length ? "最近审查已完成" : "等待审查"),
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
          h("summary", null, `第 ${review.attempt || index + 1} 轮`, " · ", review.processState, review.verdict ? ` · ${review.verdict}` : ""),
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
      inject: ["slots", "sidebarRight", "sidebarRightTabs", "sessions"],
      apply(ctx) {
        const disposers = [];
        const projectionOf = (sessionId) => {
          const binding = sessionId ? ctx.sessions.binding(sessionId) : undefined;
          return binding?.session.projections.faceOf("codexWorkflow");
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

        let currentSessionId;
        let currentProjectionDisposer;
        const opened = new Set();
        const scan = () => {
          const sessionId = ctx.sidebarRight.mounted.getSnapshot();
          if (sessionId !== currentSessionId) {
            currentProjectionDisposer?.();
            currentSessionId = sessionId;
            const face = projectionOf(sessionId);
            currentProjectionDisposer = face?.subscribe(scan);
          }
          if (!sessionId) return;
          const projection = projectionOf(sessionId)?.getSnapshot();
          if (!projection) return;
          const active = projection.activeReview;
          const latest = active || projection.reviews?.at?.(-1);
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
          if (!opened.has(key)) {
            opened.add(key);
            try {
              ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true, params: target.params });
            } catch {
              // The current session surface can be between teardown and mount;
              // the next list/projection notification retries the open.
              opened.delete(key);
            }
          }
        };
        disposers.push(ctx.sidebarRight.mounted.subscribe(scan));
        scan();
        return () => {
          currentProjectionDisposer?.();
          for (const dispose of disposers.reverse()) dispose?.();
        };
      },
    };
  },
});
