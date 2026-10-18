import { scenarios } from "./scenarios.js";

const $ = (id) => document.getElementById(id);
const roles = {
  planner: { name: "Codex Planner", letter: "P", label: "只读规划" },
  executor: { name: "DSH Executor", letter: "D", label: "执行修改" },
  reviewer: { name: "Codex Reviewer", letter: "R", label: "独立审查" },
  system: { name: "Workflow", letter: "◇", label: "状态记录" },
};
const stageOrder = ["planner", "executor", "reviewer", "done"];
const scenarioIcons = ["→", "↻", "⌁"];
let selected = scenarios[0];
let cursor = -1;
let playing = false;
let timer;
let activeTab = "conversation";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stopPlayback() {
  clearTimeout(timer);
  timer = undefined;
  playing = false;
}

function isWaiting() {
  return selected.steps[cursor]?.action === "resume";
}

function reset(scenario = selected) {
  stopPlayback();
  selected = scenario;
  cursor = -1;
  render();
  $("announcement").textContent = `已选择${selected.title}，准备就绪。`;
}

function schedule() {
  clearTimeout(timer);
  if (playing) timer = setTimeout(advance, Number($("speed").value));
}

function advance() {
  if (cursor >= selected.steps.length - 1) return;
  cursor += 1;
  if (isWaiting() || cursor === selected.steps.length - 1) stopPlayback();
  render(true);
  const step = selected.steps[cursor];
  $("announcement").textContent = `${cursor + 1} / ${selected.steps.length}，${step.title}${isWaiting() ? "。等待点击继续原线程。" : ""}`;
  schedule();
}

function play() {
  if (playing) {
    stopPlayback();
    renderControls();
    return;
  }
  if (cursor === selected.steps.length - 1) reset();
  playing = true;
  // User confirmation is the only way automatic playback leaves a recovery pause.
  if (cursor < 0 || isWaiting()) advance();
  else {
    renderControls();
    schedule();
  }
}

function renderNavigation() {
  document.querySelectorAll(".scenario-button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.scenario === selected.id));
  });
}

function renderControls() {
  const complete = cursor === selected.steps.length - 1;
  const waiting = isWaiting();
  const text = playing ? "Ⅱ 暂停演示" : waiting ? "↻ 继续原线程" : complete ? "↺ 再演示一次" : cursor < 0 ? "▶ 开始演示" : "▶ 继续播放";
  $("play-button").textContent = text;
  $("next-button").disabled = complete || waiting;
  $("reset-button").disabled = cursor < 0;
  $("resume-notice").hidden = !waiting;
  $("step-label").textContent = `${cursor + 1} / ${selected.steps.length}`;
  $("playback-label").textContent = waiting ? "等待原线程继续" : complete ? "演示完成" : playing ? "正在播放模拟事件" : cursor < 0 ? "准备就绪" : "已暂停 · 可单步查看";
  const progress = Math.round((cursor + 1) / selected.steps.length * 100);
  $("progress-fill").style.width = `${progress}%`;
  $("progress-track").setAttribute("aria-valuenow", String(progress));
}

function renderInspector() {
  const step = selected.steps[cursor];
  $("task-title").textContent = selected.task;
  $("task-detail").textContent = selected.taskDetail;
  $("scenario-description").textContent = selected.description;
  $("workflow-id").textContent = `demo-${selected.id}-001`;
  $("review-round").textContent = step?.round ? `第 ${step.round} 轮` : "尚未开始";
  $("test-result").textContent = step?.tests || "尚未演示";
  $("thread-id").textContent = step?.thread || (step ? "此阶段无模型线程" : "尚未创建");
  $("thread-hint").textContent = isWaiting() ? "原进程仍可用 · 允许同线程继续" : step?.thread ? "模拟线程标识 · 不创建真实线程" : step ? "当前由 DSH 执行" : "演示开始后显示线程身份";
  $("queue-state").textContent = step?.queue || "DSH 直接调用";
  $("receipt-state").textContent = step?.receipt || "等待任务开始";
  $("current-explanation").textContent = step?.body[0] || "选择左侧场景，点击开始演示。也可以使用“下一步”逐步查看。";
  const phase = $("phase-badge");
  phase.textContent = step?.phaseLabel || "待开始";
  phase.className = `phase-badge ${isWaiting() ? "waiting" : step?.outcome === "passed" ? "passed" : step ? "running" : ""}`;
  const activeStage = stageOrder.indexOf(step?.stage);
  document.querySelectorAll(".pipeline li").forEach((item, index) => {
    item.classList.toggle("active", activeStage === index);
    item.classList.toggle("complete", index < activeStage);
    if (activeStage === index) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
}

function emptyState(title, body, showRoles = false) {
  const node = element("div", "empty-state");
  if (showRoles) {
    const orbit = element("div", "empty-orbit");
    orbit.setAttribute("aria-hidden", "true");
    ["P", "D", "R"].forEach((label, index) => {
      if (index) orbit.append(element("i"));
      orbit.append(element("span", "", label));
    });
    node.append(orbit);
  }
  node.append(element("h3", "", title), element("p", "", body));
  if (showRoles) {
    const pills = element("div", "empty-pills");
    ["只读规划", "执行与验证", "独立审查"].forEach((text) => pills.append(element("span", "", text)));
    node.append(pills);
  }
  return node;
}

function message(step, index, fresh) {
  const role = roles[step.role];
  const item = element("article", `message ${step.role}${fresh ? " new" : ""}`);
  item.dataset.step = String(index);
  const avatar = element("span", "message-avatar", role.letter);
  avatar.setAttribute("aria-hidden", "true");
  const content = element("div", "message-content");
  const meta = element("div", "message-meta");
  meta.append(element("strong", "", role.name), element("em", "", role.label), element("span", "", `STEP ${String(index + 1).padStart(2, "0")}`));
  const body = element("div", step.outcome === "passed" ? "success-message" : "");
  body.append(element("h3", "", step.title));
  step.body.forEach((text) => body.append(element("p", "", text)));
  if (step.checks?.length) {
    const list = element("ul");
    step.checks.forEach((check) => list.append(element("li", "", check)));
    body.append(list);
  }
  if (step.code) {
    body.append(element("div", "code-caption", `${step.language || "code"} / 示例片段`));
    const pre = element("pre");
    pre.append(element("code", "", step.code));
    body.append(pre);
  }
  if (step.finding) {
    const finding = element("div", "finding");
    finding.append(element("strong", "", `${step.finding.severity} · ${step.finding.title}`), element("p", "", step.finding.detail));
    body.append(finding);
  }
  content.append(meta, body);
  item.append(avatar, content);
  return item;
}

function renderContent(fresh = false) {
  const panel = $("content-panel");
  const previousScroll = panel.scrollTop;
  panel.replaceChildren();
  const steps = selected.steps.slice(0, cursor + 1);
  $("message-count").textContent = String(steps.length);
  if (activeTab === "conversation") {
    if (!steps.length) panel.append(emptyState("准备好，看一次完整协作", selected.description + " 点击开始演示，或者逐步查看每一次交接。", true));
    else {
      const list = element("div", "message-list");
      steps.forEach((step, index) => list.append(message(step, index, fresh && index === cursor)));
      panel.append(list);
    }
  } else if (activeTab === "diff") {
    const codeSteps = steps.filter((step) => step.code);
    if (!codeSteps.length) panel.append(emptyState("还没有代码片段", "推进演示到执行阶段，DSH 的示例代码会出现在这里。"));
    else {
      const container = element("div", "code-panel");
      container.append(element("h3", "", "本次演示中的代码"), element("p", "", "以下为预设示例片段，未读取或修改你的项目文件。"));
      codeSteps.forEach((step) => {
        container.append(element("div", "code-caption", `${step.title} · ${step.language || "code"}`));
        const pre = element("pre");
        pre.append(element("code", "", step.code));
        container.append(pre);
      });
      panel.append(container);
    }
  } else {
    if (!steps.length) panel.append(emptyState("等待第一条事件", "开始演示后，这里会按顺序记录阶段切换与线程身份。"));
    else {
      const container = element("div", "events-panel");
      container.append(element("h3", "", "模拟事件时间线"), element("p", "", "事件来自预设场景，用于解释工作流状态变化。"));
      steps.forEach((step, index) => {
        const row = element("div", "event");
        const detail = element("div");
        detail.append(element("strong", "", step.event), element("p", "", `${step.phase} · ${step.thread || "DSH session"}`));
        row.append(element("span", "", String(index + 1).padStart(2, "0")), detail);
        container.append(row);
      });
      panel.append(container);
    }
  }
  if (fresh) {
    const lastMessage = panel.querySelector(".message:last-child");
    if (activeTab === "conversation" && lastMessage) {
      panel.scrollTop = Math.max(0, lastMessage.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 18);
    } else panel.scrollTop = panel.scrollHeight;
  } else panel.scrollTop = cursor < 0 ? 0 : previousScroll;
}

function render(fresh = false) {
  renderNavigation();
  renderInspector();
  renderControls();
  renderContent(fresh);
}

scenarios.forEach((scenario, index) => {
  const button = element("button", "scenario-button");
  button.dataset.scenario = scenario.id;
  button.setAttribute("aria-pressed", "false");
  const icon = element("span", "scenario-icon", scenarioIcons[index]);
  icon.setAttribute("aria-hidden", "true");
  const text = element("span");
  text.append(element("strong", "", scenario.title), element("small", "", scenario.subtitle));
  button.append(icon, text);
  button.addEventListener("click", () => reset(scenario));
  $("scenarios").append(button);
});

const tabs = [...document.querySelectorAll("[role=tab]")];
function selectTab(tab) {
  activeTab = tab.dataset.tab;
  tabs.forEach((item) => {
    item.setAttribute("aria-selected", String(item === tab));
    item.tabIndex = item === tab ? 0 : -1;
  });
  $("content-panel").setAttribute("aria-labelledby", tab.id);
  renderContent();
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let target;
    if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") target = (index + tabs.length - 1) % tabs.length;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = tabs.length - 1;
    if (target === undefined) return;
    event.preventDefault();
    selectTab(tabs[target]);
    tabs[target].focus();
  });
});

$("play-button").addEventListener("click", play);
$("next-button").addEventListener("click", () => {
  if (isWaiting()) return;
  stopPlayback();
  advance();
});
$("reset-button").addEventListener("click", () => reset());
$("speed").addEventListener("change", schedule);
$("about-button").addEventListener("click", () => {
  stopPlayback();
  renderControls();
  $("about-dialog").showModal();
});
$("close-about").addEventListener("click", () => $("about-dialog").close());
window.addEventListener("pagehide", stopPlayback);
window.addEventListener("pageshow", renderControls);
render();
