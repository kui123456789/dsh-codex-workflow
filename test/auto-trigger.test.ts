import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_TRIGGER_SECTION_NAME,
  AUTO_TRIGGER_SECTION_ORDER,
  autoTriggerGuidance,
  registerAutoTriggerPrompt,
} from "../src/auto-trigger.js";
import { Config } from "../src/config.js";
import { inject } from "../src/index.js";

test("autoTriggerMode defaults to complex and validates the public modes", () => {
  assert.equal(Config({}).autoTriggerMode, "complex");
  assert.equal(Config({ autoTriggerMode: "off" }).autoTriggerMode, "off");
  assert.equal(Config({ autoTriggerMode: "complex" }).autoTriggerMode, "complex");
  assert.equal(Config({ autoTriggerMode: "always" }).autoTriggerMode, "always");
  assert.throws(() => Config({ autoTriggerMode: "sometimes" as never }));
});

test("plugin declares systemPrompt as a required injected service", () => {
  assert.deepEqual(inject, ["tools", "agents", "systemPrompt"]);
});

test("off mode registers no prompt section and has a harmless disposer", () => {
  let calls = 0;
  const dispose = registerAutoTriggerPrompt({
    section: () => {
      calls += 1;
      return () => undefined;
    },
  } as never, "off");
  assert.equal(calls, 0);
  dispose();
  assert.equal(calls, 0);
});

for (const mode of ["complex", "always"] as const) {
  test(`${mode} mode registers and disposes exactly one stable prompt section`, () => {
    const sections: Array<{ name: string; order: number; text: string | ((context: unknown) => string) }> = [];
    let disposed = 0;
    const dispose = registerAutoTriggerPrompt({
      section: (section: { name: string; order: number; text: string | ((context: unknown) => string) }) => {
        sections.push(section as never);
        return () => { disposed += 1; };
      },
    } as never, mode);
    assert.equal(sections.length, 1);
    assert.equal(sections[0]!.name, AUTO_TRIGGER_SECTION_NAME);
    assert.equal(sections[0]!.order, AUTO_TRIGGER_SECTION_ORDER);
    assert.equal(sections[0]!.text, autoTriggerGuidance(mode));
    dispose();
    assert.equal(disposed, 1);
  });
}

test("complex guidance is decision-complete and fail-closed around workflow ownership", () => {
  const guidance = autoTriggerGuidance("complex");
  assert.match(guidance, /multiple files\/modules/);
  assert.match(guidance, /architecture.*public API.*persistence.*concurrency.*security/);
  assert.match(guidance, /root-cause-unclear defect.*regression tests/);
  assert.match(guidance, /mature, stable, complete, end-to-end, or release-quality/);
  assert.match(guidance, /Do not auto-trigger for ordinary questions/);
  assert.match(guidance, /explicit user instruction.*always overrides/);
  assert.match(guidance, /Never start a second workflow/);
  assert.match(guidance, /minimum read-only inspection/);
  assert.match(guidance, /before any modification/);
  assert.match(guidance, /codex_workflow_start exactly once/);
  assert.match(guidance, /complete goal, constraints, and acceptance requirements/);
  assert.match(guidance, /codex_workflow_continue/);
});

test("always guidance covers every write-intent development task but keeps exclusions", () => {
  const guidance = autoTriggerGuidance("always");
  assert.match(guidance, /every user-requested development task/);
  assert.match(guidance, /before making changes/);
  assert.match(guidance, /explicit user instruction.*always overrides/);
  assert.match(guidance, /Never auto-trigger from plugin-generated/);
});
