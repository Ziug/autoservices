import {randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';

try { process.loadEnvFile('.env.local'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local before running this integration check.');
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/i.test(url);
if (!isLocal && process.env.SUPABASE_INTEGRATION_ALLOW_MUTATIONS !== 'true') {
  throw new Error('This check creates and removes a temporary tenant. For a non-local project, set SUPABASE_INTEGRATION_ALLOW_MUTATIONS=true explicitly.');
}

const admin = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
const suffix = randomUUID().slice(0, 8);
const slug = `race-check-${suffix}`;
const day = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const startsAt = `${day}T10:00:00.000Z`;
const openingHours = Array.from({length: 7}, (_, weekday) => ({weekday, opensAt: '09:00', closesAt: '20:00'}));
let tenantId;

async function expectNoError(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function cleanup() {
  if (!tenantId) return;
  for (const table of ['payments', 'notification_jobs', 'push_subscriptions', 'appointments', 'resource_occupancies', 'services', 'resources', 'date_overrides', 'tenant_memberships']) {
    const {error} = await admin.from(table).delete().eq('tenant_id', tenantId);
    if (error) console.error(`Cleanup warning for ${table}: ${error.message}`);
  }
  const {error} = await admin.from('tenants').delete().eq('id', tenantId);
  if (error) console.error(`Cleanup warning for tenants: ${error.message}`);
}

try {
  const tenant = await expectNoError(await admin.from('tenants').insert({
    slug, name: 'Temporary booking race test', city: 'Test city', address: 'Local test address', phone: '+70000000000',
    map_url: 'https://example.test/map', timezone: 'UTC', currency: 'RUB', locale: 'ru-RU', accent_color: '#4690FF',
    is_demo: true, status: 'preview', booking_step_minutes: 30, opening_hours: openingHours,
  }).select('id').single(), 'create temporary tenant');
  tenantId = tenant.id;

  const service = await expectNoError(await admin.from('services').insert({
    tenant_id: tenantId, slug: 'race-service', name: 'Race test service', price_minor: 32500,
    duration_minutes: 60, buffer_before_minutes: 0, buffer_after_minutes: 0, resource_types: ['lift'], active: true,
  }).select('slug').single(), 'create temporary service');
  await expectNoError(await admin.from('resources').insert({
    tenant_id: tenantId, slug: 'only-lift', name: 'The only resource', resource_type: 'lift', active: true,
  }), 'create the single resource');

  const requests = [1, 2].map((index) => ({
    p_slug: slug,
    p_service_slug: service.slug,
    p_starts_at: startsAt,
    p_customer_name: `Race Client ${index}`,
    p_customer_phone: `+7000000000${index}`,
    p_vehicle: `Test vehicle ${index}`,
    p_idempotency_key: randomUUID(),
    p_access_token_hash: `integration-test-${randomUUID()}`,
  }));
  const race = await Promise.all(requests.map((args) => admin.rpc('create_public_booking', args)));
  const winners = race.flatMap((result, index) => result.error ? [] : [{index, appointment: result.data}]);
  const losers = race.filter((result) => result.error);
  if (winners.length !== 1 || losers.length !== 1) {
    throw new Error(`Expected one winner and one rejected request; received ${winners.length} winner(s), ${losers.length} error(s).`);
  }
  if (losers[0].error.code !== '23P01' || !String(losers[0].error.message).includes('SLOT_TAKEN')) {
    throw new Error(`The losing request did not report SLOT_TAKEN: ${losers[0].error.message}`);
  }
  const winner = winners[0];
  if (winner.appointment.price_minor !== 32500) throw new Error('The client did not receive the server-side service price.');

  const retry = await expectNoError(await admin.rpc('create_public_booking', requests[winner.index]), 'retry winning request');
  if (retry.id !== winner.appointment.id || retry.idempotent !== true) throw new Error('Retry did not return the original appointment idempotently.');
  const {count, error: countError} = await admin.from('appointments').select('id', {count: 'exact', head: true}).eq('tenant_id', tenantId);
  if (countError) throw countError;
  if (count !== 1) throw new Error(`Expected exactly one saved appointment, found ${count}.`);

  console.log('Passed: two concurrent requests competed for one resource; exactly one booking persisted and its retry returned the same appointment.');
} finally {
  await cleanup();
}
