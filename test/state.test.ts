import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("SQLite state admits only one active workflow per canonical workspace", async () => {
  const module = await import("../src/state.js").catch(() => undefined);
  assert.ok(module, "standalone SQLite state module exists");
  const home = await mkdtemp(join(tmpdir(), "codex-workflow-state-"));
  try {
    const store = new module.StateStore(home);
    try {
      const first = module.newRecord("/workspace", { task: "first" }, "codex", []);
      store.insert(first);
      assert.equal(store.activeForCwd("/workspace")?.id, first.id);
      assert.throws(() => store.insert(module.newRecord("/workspace", { task: "second" }, "codex", [])));
      store.update(first.id, (record: { phase: string }) => { record.phase = "cancelled"; });
      const next = module.newRecord("/workspace", { task: "second" }, "codex", []);
      store.insert(next);
      assert.equal(store.activeForCwd("/workspace")?.id, next.id);
    } finally { store.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});
