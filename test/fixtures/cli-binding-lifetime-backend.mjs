const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "normalization") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
      text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "original result" }) } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "01234567-89ab-4def-8123-456789abcdef" }) + "\n");
  if (mode === "success") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
      text: "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: original result" } }) + "\n");
  } else { process.stderr.write("permission denied"); process.exitCode = 1; }
});
