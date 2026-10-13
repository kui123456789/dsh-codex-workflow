import { appendFileSync } from "node:fs";
import { WorkflowManager } from "../../src/workflow.js";

const report = process.env.DSH_WORKFLOW_CLEANUP_PROBE_REPORT;
if (!report) throw new Error("Missing foreground cleanup probe report path");
const log = (value) => appendFileSync(report, JSON.stringify(value) + "\n", "utf8");
const originalReviewOnly = WorkflowManager.prototype.reviewOnly;

// Preload only the actual named foreground scenario. Its real protocol,
// native child, store and all ownership assertions stay in the test file.
WorkflowManager.prototype.reviewOnly = function (...args) {
  WorkflowManager.prototype.reviewOnly = originalReviewOnly;
  const owner = this;
  const originalStop = owner.stop.bind(owner);
  const client = owner.codex;
  const originalClientStop = client.stop.bind(client);
  const originalFailure = new Error("Original fork creation or App Server process tree cleanup is unconfirmed; no replacement process will be started");
  let child;
  let watchdog;
  let injectedStopCalls = 0;
  owner.stop = async () => {
    child ??= client.child;
    await originalStop();
    injectedStopCalls += 1;
    if (!watchdog) watchdog = setTimeout(() => {
      void (async () => {
        log({ kind: "cleanup-observed", originalPid: child?.pid, injectedStopCalls,
          originalProcessAlive: Boolean(child && child.exitCode === null && child.signalCode === null),
          originalStoreClosed: owner.store.isClosed(),
          originalNativeChildrenRemaining: owner.runtime.codexChildSessions.size });
        // A RED implementation still needs to retire this probe's own child.
        // This is not a production recovery or a replacement process.
        await originalClientStop();
        owner.store.close();
        log({ kind: "probe-finished", originalExited: Boolean(child && (child.exitCode !== null || child.signalCode !== null)) });
      })().catch(error => { console.error("Foreground cleanup probe teardown failed", error); process.exitCode = 1; });
    }, 5500);
    throw originalFailure;
  };
  return originalReviewOnly.apply(owner, args);
};
