// A real codex-callback child that IGNORES SIGTERM and never exits on its own.
// Used by the process-level suite to prove the dispatcher escalates a stubborn
// child through SIGTERM -> SIGKILL instead of waiting for close forever.
process.on("SIGTERM", () => {
  // Intentionally swallow: the process stays alive until SIGKILL.
});
process.on("SIGHUP", () => {
  // Swallow as well (some platforms target HUP first).
});
// Keep the event loop alive with a REFERENCED timer (unref would let the
// process exit once stdin closes) so the child only ends when actually killed.
setInterval(() => undefined, 60_000);
process.stdin.resume();
