import assert from "node:assert/strict";
import test from "node:test";
import { compactDiagnostic } from "../src/transient-retry.js";

test("Chinese diagnostics obey the actual UTF-8 byte budget even below the UTF-16 length limit", () => {
  const source = "诊断".repeat(900) + "😀模型连接中断";
  assert.ok(source.length < 2048);
  const result = compactDiagnostic(source);
  assert.ok(Buffer.byteLength(result, "utf8") <= 2048);
  assert.ok(result.startsWith("诊断"));
  assert.ok(result.endsWith("😀模型连接中断"));
});

test("diagnostic omission counts the exact removed source bytes while retaining both original ends", () => {
  const source = "权限拒绝:" + "界😀é".repeat(1000) + ":原始错误尾部🔥";
  for (const limit of [100, 200, 400, 2048]) {
    const result = compactDiagnostic(`  ${source}\n`, limit);
    const match = /^(.*)\n…\[(\d+) bytes omitted\]…\n(.*)$/s.exec(result);
    assert.ok(match, "Large enough diagnostics show the omitted byte count");
    assert.ok(Buffer.byteLength(result, "utf8") <= limit);
    assert.ok(source.startsWith(match[1]!));
    assert.ok(source.endsWith(match[3]!));
    assert.equal(Buffer.byteLength(match[1]! + match[3]!, "utf8") + Number(match[2]), Buffer.byteLength(source, "utf8"));
    assert.equal(Buffer.from(result, "utf8").toString("utf8"), result, "Truncation cannot leave lone UTF-16 surrogates");
    assert.equal(result.includes("�"), false, "Valid source text cannot acquire a replacement character");
  }
});

test("tiny diagnostic budgets preserve complete source characters without oversized markers", () => {
  const source = "😀诊断é🔥".repeat(40);
  for (let limit = 0; limit <= 80; limit++) {
    const result = compactDiagnostic(source, limit);
    assert.ok(Buffer.byteLength(result, "utf8") <= limit, `UTF-8 output exceeds ${limit} bytes`);
    assert.equal(Buffer.from(result).toString("utf8"), result);
    assert.equal(result.includes("�"), false);
    if (!result.includes("bytes omitted")) assert.ok(source.startsWith(result));
  }
});

test("short Unicode diagnostics remain exact at and above their UTF-8 boundary", () => {
  const source = "请求失败😀é";
  const bytes = Buffer.byteLength(source, "utf8");
  assert.equal(compactDiagnostic(` \n${source}\n `, bytes), source);
  assert.equal(compactDiagnostic(source, bytes + 1), source);
  assert.equal(compactDiagnostic("  \n ", 0), "");
  assert.ok(Buffer.byteLength(compactDiagnostic(source, bytes - 1)) <= bytes - 1);
});
