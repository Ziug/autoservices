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
 * Fired after the stored access pairs change. The assistant widget and the
 * schedule page write bookings from outside React, so pages that display the
 * saved list have to be told to re-read it — localStorage writes do not
 * trigger a re-render on their own.
 */
const ACCESS_CHANGED_EVENT = 'autoservices:access-changed';

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
  window.dispatchEvent(new CustomEvent(ACCESS_CHANGED_EVENT, {detail: {businessSlug: input.businessSlug}}));
}

/**
 * Subscribes to access-list changes for one studio. Returns the unsubscribe
 * function. Listeners are notified for their own studio and for events
 * without a studio filter.
 */
export function subscribeToAccessChanges(businessSlug: string, onChange: () => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{businessSlug?: string}>).detail;
    if (!detail?.businessSlug || detail.businessSlug === businessSlug) onChange();
  };
  window.addEventListener(ACCESS_CHANGED_EVENT, handler);
  // A booking made in another tab of the same browser.
  const onStorage = (event: StorageEvent) => {
    if (event.key === accessStorageKey(businessSlug)) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACCESS_CHANGED_EVENT, handler);
    window.removeEventListener('storage', onStorage);
  };
}
