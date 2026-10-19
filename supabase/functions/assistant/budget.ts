/**
 * Wall-clock budget for one Edge Function invocation.
 *
 * Supabase's hosted limits are far higher than the old 15s assumption: the
 * free plan allows 150s of wall clock and a 150s request idle timeout
 * (https://supabase.com/docs/guides/functions/limits). The real constraint
 * is the LLM provider — free-tier OpenRouter models routinely need 10-30s to
 * answer, which is what the SDK's own `timeout` option used to cut short.
 *
 * The deadline is therefore generous: it exists to keep a single request from
 * retrying forever, not to squeeze the model. A retry only starts when the
 * remaining budget can still fit a full attempt.
 */

export const FUNCTION_BUDGET_MS = 120_000;
export const LLM_MAX_TIMEOUT_MS = 45_000;

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
  if (remaining <= 2_000) return 0;
  return Math.min(LLM_MAX_TIMEOUT_MS, remaining - 1_500);
}

/** True when a timeout is a "model too slow" signal rather than a transient glitch. */
export function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message);
}
