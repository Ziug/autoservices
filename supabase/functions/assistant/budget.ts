/**
 * Wall-clock budget for one Edge Function invocation.
 *
 * Supabase's free plan allows ~15s per request. The LLM call must fit inside
 * that budget together with the database round-trips, so the deadline is
 * threaded through the request and every step sizes its own timeout from what
 * is actually left. Without this, a slow model plus a blind retry exceeded the
 * platform limit and the function was killed mid-request.
 */

export const FUNCTION_BUDGET_MS = 12_000;
export const LLM_MAX_TIMEOUT_MS = 6_000;

export type Deadline = {expiresAt: number};

export function startDeadline(budgetMs: number = FUNCTION_BUDGET_MS): Deadline {
  return {expiresAt: Date.now() + budgetMs};
}

export function remainingMs(deadline: Deadline): number {
  return deadline.expiresAt - Date.now();
}

/** Timeout for a single LLM attempt, never longer than the remaining budget. */
export function llmTimeout(deadline: Deadline): number {
  const remaining = remainingMs(deadline);
  if (remaining <= 1_200) return 0;
  return Math.min(LLM_MAX_TIMEOUT_MS, remaining - 800);
}

/** True when a timeout is a "model too slow" signal rather than a transient glitch. */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message);
}
