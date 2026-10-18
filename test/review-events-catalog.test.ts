import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import * as reviewEvents from "../src/review-events.js";

const CODEX_WORKFLOW_EVENT_TYPES = [
  "dsh-codex-workflow/plan-updated",
  "dsh-codex-workflow/review-start",
  "dsh-codex-workflow/review-progress",
  "dsh-codex-workflow/review-end",
  "dsh-codex-workflow/live",
] as const;

test("registers all Codex workflow session event types idempotently", () => {
  const catalog = KNOWN_SESSION_EVENT_TYPES as Set<string>;
  const before = new Set(catalog);
  const register = (reviewEvents as typeof reviewEvents & {
    registerCodexWorkflowSessionEventTypes?: () => void;
  }).registerCodexWorkflowSessionEventTypes;

  assert.equal(typeof register, "function");
  register?.();
  const afterFirstRegistration = new Set(catalog);
  for (const type of CODEX_WORKFLOW_EVENT_TYPES) assert.equal(catalog.has(type), true, type);
  assert.deepEqual(
    new Set([...afterFirstRegistration].filter((type) => !before.has(type))),
    new Set(CODEX_WORKFLOW_EVENT_TYPES.filter((type) => !before.has(type))),
  );

  register?.();
  assert.deepEqual(new Set(catalog), afterFirstRegistration);

  for (const type of CODEX_WORKFLOW_EVENT_TYPES) {
    if (!before.has(type)) catalog.delete(type);
  }
  assert.deepEqual(new Set(catalog), before);
});
