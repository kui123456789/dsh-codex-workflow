/**
 * Transient upstream failures (1.1.1): ONE shared classification + ONE shared
 * bounded-backoff policy for every model call the plugin makes.
 *
 * Real evidence for why this exists: an upstream `server_overloaded` reply
 * ("Selected model is at capacity. Please try a different model.") reached the
 * CLI audit as a failed turn with exit code 1, matched none of the old retry
 * patterns (`rate limit|429|active writer`), and was therefore classified as a
 * TERMINAL `CodexCallbackProcessError` — the workflow stopped dead and needed a
 * human to run the same call again. Capacity/overload is by nature temporary.
 *
 * Everything here is deliberately pure/injectable so tests can assert the exact
 * backoff sequence without waiting for real time.
 */

/** Failure texts that mean "the upstream could not serve this request NOW" and
 * are therefore safe to retry after a delay. Kept as one list so the CLI audit,
 * the App Server turns and the callback paths can never drift apart. */
const TRANSIENT_PATTERNS: RegExp[] = [
  // Capacity / overload (the incident signature).
  /server[_\s-]?overloaded/i,
  /at capacity/i,
  /overloaded/i,
  // Explicit throttling.
  /\b429\b/,
  /too many requests/i,
  /rate[_\s-]?limit/i,
  /usage[_\s-]?limit/i,
  /exceeded retry limit/i,
  // Upstream/gateway 5xx and dropped streams.
  /\b50[234]\b/,
  /bad gateway/i,
  /service unavailable/i,
  /gateway time-?out/i,
  /stream (?:disconnected|error)/i,
  /connection (?:reset|closed|aborted)/i,
  /transport error/i,
  // Thread writers held by another process (Codex Desktop): transient by nature.
  /already has an active writer/i,
  /already in use/i,
  /thread-store conflict/i,
];

/** Terminal conditions that must NEVER be retried, even if a transient-looking
 * token appears elsewhere in the same diagnostic (e.g. a thread id that does
 * not exist, a display/schema contract violation, an explicit cancellation).
 * Checked BEFORE the transient patterns. */
const TERMINAL_PATTERNS: RegExp[] = [
  /no rollout found for thread id/i,
  /does not exist/i,
  /cancelled by user/i,
  /cancelled by test/i,
  /\baborted\b.*\b(cancel|teardown|lease)\b/i,
  /violates the display contract/i,
  /schema/i,
  /invalid normalization output/i,
  /approval (?:denied|rejected|required)/i,
];

/** True when `text` names a TEMPORARY upstream condition worth retrying. */
export function isTransientFailure(text: string | undefined | null): boolean {
  const value = text ?? "";
  if (value.length === 0) return false;
  if (TERMINAL_PATTERNS.some((pattern) => pattern.test(value))) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(value));
}

/** Short machine-readable reason for a transient diagnostic (logging/status). */
export function transientReason(text: string | undefined | null): string | undefined {
  const value = text ?? "";
  if (!isTransientFailure(value)) return undefined;
  if (/server[_\s-]?overloaded|at capacity|overloaded/i.test(value)) return "overloaded";
  if (/\b429\b|too many requests|rate[_\s-]?limit|usage[_\s-]?limit|exceeded retry limit/i.test(value)) return "rate limit";
  if (/already has an active writer|already in use|thread-store conflict/i.test(value)) return "active writer";
  return "upstream unavailable";
}

export interface BackoffPolicy {
  /** First (and exponential base) delay. */
  baseMs: number;
  /** Per-attempt delay ceiling. */
  maxMs: number;
  /** Total wall-clock budget for one operation's retries. */
  budgetMs: number;
  /** ±fraction applied to every delay (default 0.25). 0 disables jitter. */
  jitterRatio?: number;
}

/** Injectable seams: tests assert the exact sequence instead of sleeping. */
export interface BackoffHooks {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Deterministic jitter source in [0,1); defaults to Math.random. */
  random?: () => number;
}

export const DEFAULT_BACKOFF: Required<BackoffPolicy> = {
  baseMs: 3_000,
  maxMs: 60_000,
  budgetMs: 20 * 60 * 1000,
  jitterRatio: 0.25,
};

/**
 * Normalize a (possibly partial, possibly stale) policy: a caller that builds a
 * config object WITHOUT the retry fields must never end up with `undefined`
 * bounds — `undefined <= 0` and `now + undefined > deadline` are both false, so
 * an unsanitized policy silently turns a bounded retry into an endless loop.
 * `budgetMs: 0` stays 0 and means "no automatic retry".
 */
export function normalizeBackoff(policy: Partial<BackoffPolicy> | undefined): BackoffPolicy {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const budget = policy?.budgetMs;
  return {
    baseMs: positive(policy?.baseMs, DEFAULT_BACKOFF.baseMs),
    maxMs: positive(policy?.maxMs, DEFAULT_BACKOFF.maxMs),
    budgetMs: typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_BACKOFF.budgetMs,
    jitterRatio: typeof policy?.jitterRatio === "number" && Number.isFinite(policy.jitterRatio)
      ? Math.max(0, policy.jitterRatio)
      : DEFAULT_BACKOFF.jitterRatio,
  };
}

/** Exponential delay for `attempt` (0-based) with bounded jitter. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const ceiling = Math.max(1, Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt)));
  const ratio = policy.jitterRatio ?? DEFAULT_BACKOFF.jitterRatio;
  if (ratio <= 0) return Math.round(ceiling);
  const factor = 1 + ratio * (random() * 2 - 1);
  return Math.max(1, Math.round(ceiling * factor));
}

export class TransientRetryExhaustedError extends Error {
  constructor(readonly reason: string, readonly attempts: number, readonly lastError?: unknown) {
    super(`transient upstream failure persisted for ${attempts} attempt(s) within the retry budget (${reason})`);
    this.name = "TransientRetryExhaustedError";
  }
}

/**
 * Run `operation` until it succeeds or the retry budget is spent.
 *
 * `operation` must THROW on failure; `classify` decides whether the thrown
 * error is transient (returning a reason) or terminal (returning undefined, in
 * which case the error is rethrown immediately and unchanged).
 *
 * Cancellation is honoured everywhere: an aborted signal rejects immediately,
 * and a signal that aborts while sleeping settles at once (never after the
 * delay) so cancel/teardown stays responsive.
 */
export async function retryTransient<T>(
  operation: (attempt: number) => Promise<T>,
  classify: (error: unknown) => string | undefined,
  policy: BackoffPolicy,
  hooks: BackoffHooks = {},
  signal?: AbortSignal,
): Promise<T> {
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? defaultSleep;
  const random = hooks.random ?? Math.random;
  const deadline = now() + policy.budgetMs;
  let attempt = 0;
  for (;;) {
    throwIfAborted(signal);
    try {
      return await operation(attempt);
    } catch (error) {
      const reason = classify(error);
      if (!reason) throw error;
      const delayMs = backoffDelayMs(attempt, policy, random);
      if (now() + delayMs > deadline) {
        throw new TransientRetryExhaustedError(reason, attempt + 1, error);
      }
      await sleep(delayMs, signal);
      attempt += 1;
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Keep BOTH ends of a long diagnostic. The old `slice(0, 2048)` kept only the
 * head, which is exactly where the interesting part is NOT: a CLI audit prints
 * one JSONL event per line and the fatal `task_complete`/error record is the
 * LAST line. The persisted error therefore showed a truncated tool call and
 * hid "Selected model is at capacity", making the incident undiagnosable.
 */
export function compactDiagnostic(text: string, maxBytes = 2048): string {
  const value = text.trim();
  if (value.length <= maxBytes) return value;
  const headBytes = Math.max(1, Math.floor((maxBytes - 40) / 2));
  const tailBytes = Math.max(1, maxBytes - 40 - headBytes);
  const omitted = value.length - headBytes - tailBytes;
  return `${value.slice(0, headBytes)}\n…[${omitted} bytes omitted]…\n${value.slice(value.length - tailBytes)}`;
}
