/**
 * Local storage of booking access tokens.
 *
 * The "Моя запись" page and the assistant both need to persist the
 * {appointmentId, accessToken} pair so a booking created by the assistant
 * shows up in the customer's cabinet exactly like a booking made through the
 * regular schedule flow.
 *
 * The access token is the customer's own credential — it is derived from the
 * booking's idempotency key on the server and never leaves the device.
 */

export type SavedAccess = {
  appointmentId: string;
  accessToken: string;
  startsAt: string;
  businessSlug: string;
};

export function accessStorageKey(businessSlug: string) {
  return `autoservices:access:${businessSlug}`;
}

export function readSavedAccess(businessSlug: string): SavedAccess[] {
  try {
    const raw = localStorage.getItem(accessStorageKey(businessSlug));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedAccess[]) : [];
  } catch {
    return [];
  }
}

/**
 * Stores the access pair for a booking, newest first, without duplicates.
 * Used by both the schedule flow and the assistant so a booking created by
 * the assistant lands in the same cabinet as a manually created one.
 */
export function rememberAccess(input: {appointmentId: string; accessToken: string; startsAt: string; businessSlug: string}) {
  const key = accessStorageKey(input.businessSlug);
  const saved = readSavedAccess(input.businessSlug);
  const next = [input, ...saved.filter((entry) => entry.appointmentId !== input.appointmentId)].slice(0, 10);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode, quota) — the access link
    // still works, the cabinet shortcut is just not persisted.
  }
}
