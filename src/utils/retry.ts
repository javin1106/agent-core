// How many times to try again after a failed model call (so up to 5 calls in total).
export const MAX_RETRIES = 4;

const MAX_DELAY_MS = 60_000;

// How long to wait before retry number `attempt` (1, 2, 3, ...).
// "Exponential backoff": wait 1s, then 2s, 4s, 8s... so a struggling server
// gets more and more room. A little randomness ("jitter") is added so many
// clients that failed at the same moment don't all retry at the same moment.
// If the server told us how long to wait, we do that instead.
export function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_DELAY_MS);
  const base = 1000 * 2 ** (attempt - 1);
  const jitter = Math.random() * base * 0.25;
  return Math.min(base + jitter, MAX_DELAY_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
