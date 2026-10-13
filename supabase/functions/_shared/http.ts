import {createClient, type SupabaseClient} from 'npm:@supabase/supabase-js@2.117.3';

export function corsHeaders(request: Request) {
  const origin = request.headers.get('origin');
  const configured = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const localOrigin = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const allowed = !origin || localOrigin || configured.includes(origin);
  return {
    ...(origin && allowed ? {'Access-Control-Allow-Origin': origin} : !origin ? {'Access-Control-Allow-Origin': '*'} : {}),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret, x-app-name',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
}

export function forbiddenOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const configured = (Deno.env.get('APP_ALLOWED_ORIGINS') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !configured.includes(origin);
}

export function preflight(request: Request) {
  return new Response(null, {status: 204, headers: corsHeaders(request)});
}

export function adminClient(): SupabaseClient {
  // SUPABASE_URL is a reserved secret auto-provided to every function.
  // Custom secret names must NOT start with SUPABASE_ (platform rejects them),
  // so the service key lives in APP_SERVICE_ROLE_KEY. Legacy names are kept
  // as fallbacks for older projects and `supabase functions serve` locally.
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('APP_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !key) throw new Error('Supabase server environment is not configured.');
  return createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});
}

export async function userFromRequest(request: Request) {
  const authorization = request.headers.get('authorization');
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('APP_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY');
  if (!authorization?.startsWith('Bearer ') || !url || !anonKey) return null;
  const userClient = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}, global: {headers: {Authorization: authorization}}});
  const {data, error} = await userClient.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function tenantBySlug(admin: SupabaseClient, slug: string) {
  const {data, error} = await admin.from('tenants').select('id,slug,status,is_demo,timezone,currency,cancellation_window_hours,assistant_prompts,opening_hours').eq('slug', slug).in('status', ['preview', 'live']).maybeSingle();
  if (error) throw new Error('Could not load the requested studio.');
  return data;
}

export async function requireMembership(admin: SupabaseClient, tenantId: string, userId: string) {
  const {data, error} = await admin.from('tenant_memberships').select('role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
  if (error || !data) return null;
  return data.role as 'owner' | 'manager' | 'staff';
}

export async function checkRateLimit(admin: SupabaseClient, request: Request, purpose: string, tenantId: string, limit = 20, windowSeconds = 300) {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const digest = await sha256(ip);
  const {data, error} = await admin.rpc('consume_api_limit', {p_bucket_key: `${purpose}:${tenantId}:${digest}`, p_limit: limit, p_window_seconds: windowSeconds});
  if (error) throw new Error('Could not check request limits.');
  return data === true;
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function deterministicAccessToken(slug: string, idempotencyKey: string) {
  const secret = Deno.env.get('BOOKING_TOKEN_SECRET');
  if (!secret || secret.length < 32) throw new Error('BOOKING_TOKEN_SECRET must contain at least 32 characters.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${slug}:${idempotencyKey}`));
  return toBase64Url(new Uint8Array(signature));
}

export function errorStatus(error: unknown) {
  const code = (error as {code?: string})?.code;
  if (code === '23P01' || code === 'SLOT_TAKEN') return 409;
  if (code === '42501') return 403;
  if (code === 'P0002') return 404;
  if (code === '22023') return 400;
  return 500;
}

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as {code?: string})?.code;
  if (code === '23P01' || message.includes('SLOT_TAKEN')) return 'Это окно только что заняли. Выберите другое время.';
  if (code === 'P0002') return 'Студия или услуга не найдена.';
  if (code === '42501') return 'Нет прав для этого действия.';
  if (code === '22023') return message.replaceAll('_', ' ').toLocaleLowerCase('ru-RU');
  if (/Supabase server environment|BOOKING_TOKEN_SECRET/.test(message)) return message;
  return 'Не удалось выполнить запрос. Попробуйте ещё раз.';
}
