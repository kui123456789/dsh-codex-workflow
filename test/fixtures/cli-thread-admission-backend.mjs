const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "normalization") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
      text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "original result" }) } }) + "\n",
    () => process.disconnect()); return;
  }
  if (mode === "binding") {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "01234567-89ab-4def-8123-456789abcdef" }) + "\n",
      () => process.disconnect()); return;
  }
  process.send({ ready: true });
});
process.on("message", () => {
  const text = "VERDICT: pass\nFINDINGS: none\nTEST GAPS: none\nSUMMARY: original result";
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n", () => process.disconnect());
});
process.on("disconnect", () => process.exit());
