/**
 * Super Admin base path configuration.
 *
 * The admin UI lives under a generated, unguessable path (VITE_ADMIN_PATH,
 * e.g. `/control/<32 hex chars>`). This path is OBSCURITY ONLY: it keeps the
 * login out of sitemaps and casual browsing, but it is not access control.
 * Real authorization is enforced server-side by the `admin-api` Edge
 * Function, which verifies platform-admin membership on every call and never
 * trusts the client path, session role claims, or e-mail addresses.
 *
 * Rotation = set a new VITE_ADMIN_PATH value + rebuild + redeploy.
 * Never commit a real generated path to the repo.
 */

const DEFAULT_ADMIN_BASE_PATH = '/control/admin';

function normalizeBasePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : withLeading;
  // Admin paths must live under /control/ so the static host rewrite and
  // no-store headers in vercel.json apply to every admin route.
  if (!withoutTrailing.startsWith('/control/')) return null;
  if (withoutTrailing === '/control/') return null;
  return withoutTrailing;
}

/** Base path for the Super Admin UI, e.g. `/control/<secret>`. No secret literal lives in code. */
export function getAdminBasePath(): string {
  const fromEnv = normalizeBasePath(import.meta.env.VITE_ADMIN_PATH ?? '');
  if (fromEnv) return fromEnv;
  if (import.meta.env.VITE_ADMIN_PATH?.trim()) {
    console.warn(
      '[admin] VITE_ADMIN_PATH must be under /control/ (e.g. /control/<secret>). Falling back to the default dev path.',
    );
  } else if (import.meta.env.PROD) {
    // Fail-visible in production: the default path is a dev fallback only.
    // Configure VITE_ADMIN_PATH in Vercel and redeploy; see docs/ADMIN.md.
    console.error('[admin] VITE_ADMIN_PATH is not configured. Using the dev fallback path — set a generated /control/<secret> value.');
  }
  return DEFAULT_ADMIN_BASE_PATH;
}

/** True when VITE_ADMIN_PATH provides an explicit configured path (not the dev fallback). */
export function isAdminPathConfigured(): boolean {
  return normalizeBasePath(import.meta.env.VITE_ADMIN_PATH ?? '') !== null;
}

/** True when a pathname belongs to the Super Admin UI (exact base or nested). */
export function isAdminPath(pathname: string): boolean {
  const base = getAdminBasePath();
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Join the admin base path with route segments, e.g. adminUrl('tenants', id). */
export function adminUrl(...segments: Array<string | number>): string {
  const base = getAdminBasePath();
  const suffix = segments
    .map((segment) => String(segment).trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return suffix ? `${base}/${suffix}` : base;
}
