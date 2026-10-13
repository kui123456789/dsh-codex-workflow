const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "bound-overload") {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "01234567-89ab-4def-8123-456789abcdef" }) + "\n");
  }
  if (mode === "overload" || mode === "bound-overload") {
    process.stderr.write("server_overloaded", () => process.exit(1));
    return;
  }
  const text = JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "ok" });
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
});
