import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { cwdKey } from "../src/coordination.js";

test("workspace keys follow host path semantics", () => {
  const path = resolve("Project With Spaces");
  assert.equal(cwdKey(path), cwdKey(path + "/."));
  if (process.platform === "win32") {
    assert.equal(cwdKey(path), cwdKey(path.toLowerCase()));
  } else {
    assert.notEqual(cwdKey(path), cwdKey(path.toLowerCase()));
    assert.notEqual(cwdKey(path + "\\child"), cwdKey(path + "/child"));
    assert.equal(cwdKey("/"), "/");
  }
});
