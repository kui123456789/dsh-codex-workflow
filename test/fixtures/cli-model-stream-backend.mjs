const mode = process.argv[2];
if (mode === "stdin" || mode === "cancel-stdin") process.send({ ready: true });
else process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "identity-stdout") {
    process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "01234567-89ab-4def-8123-456789abcdef" }) + "\n",
      () => process.send({ ready: true }));
    return;
  }
  if (process.argv[2] === "completed-stdout") {
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
      text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "original result" }) } }) + "\n",
    () => process.send({ ready: true }));
  } else process.send({ ready: true });
});
process.on("message", () => process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message",
  text: JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "original result" }) } }) + "\n", () => process.disconnect()));
process.on("disconnect", () => process.exit());
