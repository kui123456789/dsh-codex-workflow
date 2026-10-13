const mode = process.argv[2];
process.stdin.resume();
process.stdin.on("end", () => {
  if (mode === "held") process.send({ ready: true });
  else finish();
});
function finish() {
  if (mode === "binding") process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "01234567-89ab-4def-8123-456789abcdef" }) + "\n");
  process.stdout.write("original result\n", () => { if (process.connected) process.disconnect(); });
}
process.on("message", finish);
process.on("disconnect", () => process.exit());
