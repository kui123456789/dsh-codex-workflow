process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: process.argv[2] } }) + "\n");
});
