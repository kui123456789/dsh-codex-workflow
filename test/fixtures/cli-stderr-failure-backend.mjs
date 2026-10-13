const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  const diagnostic = mode === "transient-exit" ? "503 Service Unavailable" : mode === "terminal-exit" ? "permission denied"
    : mode === "invalid-thread" ? "no rollout found for thread id original-reviewer" : "";
  if (diagnostic) process.stderr.write(diagnostic, () => process.send({ ready: true }));
  else process.send({ ready: true });
});
process.on("message", () => {
  const text = JSON.stringify({ verdict: "pass", findings: [], testGaps: [], summary: "original result" });
  const failed = mode === "transient-exit" || mode === "terminal-exit" || mode === "invalid-thread";
  if (failed) { process.exitCode = 1; process.disconnect(); }
  else process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n", () => process.disconnect());
});
