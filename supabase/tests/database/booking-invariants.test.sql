begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

create temporary table test_fixtures (
  tenant_a uuid not null default extensions.gen_random_uuid(),
  tenant_b uuid not null default extensions.gen_random_uuid(),
  owner_id uuid not null default extensions.gen_random_uuid(),
  service_a uuid not null default extensions.gen_random_uuid(),
  service_long uuid not null default extensions.gen_random_uuid(),
  service_b uuid not null default extensions.gen_random_uuid(),
  resource_a1 uuid not null default extensions.gen_random_uuid(),
  resource_a2 uuid not null default extensions.gen_random_uuid(),
  resource_a3 uuid not null default extensions.gen_random_uuid(),
  resource_long uuid not null default extensions.gen_random_uuid(),
  resource_b uuid not null default extensions.gen_random_uuid(),
  key_a1 uuid not null default extensions.gen_random_uuid(),
  key_a2 uuid not null default extensions.gen_random_uuid(),
  key_long uuid not null default extensions.gen_random_uuid(),
  key_b uuid not null default extensions.gen_random_uuid(),
  booking_a1 uuid,
  booking_a2 uuid,
  booking_long uuid,
  booking_b uuid,
  leased_job uuid,
  slug_a text,
  slug_b text,
  booking_day date,
  starts_at timestamptz,
  move_starts_at timestamptz,
  long_starts_at timestamptz
);

insert into test_fixtures (booking_day) values ((now() at time zone 'Europe/Moscow')::date + 4);
update test_fixtures set
  slug_a = 'pgtap-' || substr(tenant_a::text, 1, 8),
  slug_b = 'pgtap-' || substr(tenant_b::text, 1, 8),
  starts_at = ((booking_day + time '10:00') at time zone 'Europe/Moscow'),
  move_starts_at = (((booking_day + 1) + time '10:00') at time zone 'Europe/Moscow'),
  long_starts_at = (((booking_day + 1) + time '09:00') at time zone 'Europe/Moscow');

insert into public.tenants (id, slug, name, city, address, phone, map_url, timezone, currency, accent_color, is_demo, status, booking_step_minutes, opening_hours)
select tenant_a, slug_a, 'pgTAP tenant A', 'Test city', 'Test address', '+70000000000', 'https://example.test/map', 'Europe/Moscow', 'RUB', '#4690FF', true, 'preview', 30,
  (select jsonb_agg(jsonb_build_object('weekday', weekday, 'opensAt', '09:00', 'closesAt', '20:00')) from generate_series(0, 6) weekday)
from test_fixtures;
insert into public.tenants (id, slug, name, city, address, phone, map_url, timezone, currency, accent_color, is_demo, status, booking_step_minutes, opening_hours)
select tenant_b, slug_b, 'pgTAP tenant B', 'Other city', 'Other address', '+71111111111', 'https://example.test/other-map', 'Europe/Moscow', 'RUB', '#D88A4A', true, 'preview', 30,
  (select jsonb_agg(jsonb_build_object('weekday', weekday, 'opensAt', '09:00', 'closesAt', '20:00')) from generate_series(0, 6) weekday)
from test_fixtures;

insert into public.services (id, tenant_id, slug, name, price_minor, duration_minutes, buffer_before_minutes, buffer_after_minutes, resource_types)
select service_a, tenant_a, 'wash', 'Test wash', 12345, 60, 15, 15, array['lift']::text[] from test_fixtures
union all
select service_long, tenant_a, 'long-service', 'Long service', 88000, 1800, 0, 0, array['long']::text[] from test_fixtures
union all
select service_b, tenant_b, 'wash', 'Other wash', 7000, 60, 0, 0, array['lift']::text[] from test_fixtures;

insert into public.resources (id, tenant_id, slug, name, resource_type)
select resource_a1, tenant_a, 'lift-a', 'Lift A', 'lift' from test_fixtures
union all select resource_a2, tenant_a, 'lift-b', 'Lift B', 'lift' from test_fixtures
union all select resource_a3, tenant_a, 'lift-c', 'Lift C', 'lift' from test_fixtures
union all select resource_long, tenant_a, 'long-bay', 'Long bay', 'long' from test_fixtures
union all select resource_b, tenant_b, 'lift-a', 'Other lift', 'lift' from test_fixtures;

select extensions.is(
  (select count(*) from public.public_booking_slots(slug_a, 'wash', booking_day) where starts_at = test_fixtures.starts_at),
  3::bigint,
  'all compatible resources are initially available'
) from test_fixtures;

update test_fixtures set booking_a1 = (public.create_public_booking(
  slug_a, 'wash', starts_at, 'Test Customer One', '+70000000001', 'Car One', key_a1, 'token-hash-a1'
)->>'id')::uuid;
select extensions.is((select price_minor from public.appointments where id = booking_a1), 12345::bigint, 'price is read from the server-side service record') from test_fixtures;
select extensions.is((select resource_id from public.appointments where id = booking_a1), resource_a1, 'the first compatible resource is assigned') from test_fixtures;

update test_fixtures set booking_a2 = (public.create_public_booking(
  slug_a, 'wash', starts_at, 'Test Customer Two', '+70000000002', 'Car Two', key_a2, 'token-hash-a2'
)->>'id')::uuid;
select extensions.ok((select resource_id from public.appointments where id = booking_a1) <> (select resource_id from public.appointments where id = booking_a2), 'simultaneous capacity is distributed across two resources') from test_fixtures;
select extensions.is((select count(*) from public.public_booking_slots(slug_a, 'wash', booking_day) where starts_at = test_fixtures.starts_at), 1::bigint, 'two bookings leave one of three resources free') from test_fixtures;
select extensions.is((select available_count from public.public_booking_slots(slug_a, 'wash', booking_day) where starts_at = test_fixtures.starts_at - interval '30 minutes'), 1, 'buffer time blocks overlapping starts') from test_fixtures;

select extensions.is((public.create_public_booking(
  slug_a, 'wash', starts_at, 'Test Customer One', '+70000000001', 'Car One', key_a1, 'token-hash-a1'
)->>'id')::uuid, booking_a1, 'a retry with the same key returns the original appointment') from test_fixtures;
select extensions.is((public.create_public_booking(
  slug_a, 'wash', starts_at, 'Test Customer One', '+70000000001', 'Car One', key_a1, 'token-hash-a1'
)->>'idempotent')::boolean, true, 'an idempotent retry is identified') from test_fixtures;
select extensions.throws_ok($test$
  select public.create_public_booking(
    (select slug_a from test_fixtures), 'wash', (select starts_at from test_fixtures),
    'Test Customer One', '+70000000001', 'Car One', (select key_a1 from test_fixtures), 'wrong-token-hash'
  )
$test$, '22023', 'IDEMPOTENCY_KEY_MISMATCH', 'a reused key cannot return access with a different token');

select extensions.is(public.create_availability_block(
  tenant_a, resource_a3, starts_at, starts_at + interval '1 hour', 'Test block'
) is not null, true, 'an owner-created resource block is stored') from test_fixtures;
select extensions.is((select available_count from public.public_booking_slots(slug_a, 'wash', booking_day) where starts_at = test_fixtures.starts_at), 0, 'a block consumes the final matching resource') from test_fixtures;
select extensions.throws_ok($test$
  select public.create_public_booking(
    (select slug_a from test_fixtures), 'wash', (select starts_at from test_fixtures),
    'Test Customer Three', '+70000000003', 'Car Three', extensions.gen_random_uuid(), 'token-hash-a3'
  )
$test$, '23P01', 'SLOT_TAKEN', 'a fully occupied slot cannot be booked again');

select extensions.is(public.create_availability_block(
  tenant_a, resource_a1, move_starts_at, move_starts_at + interval '1 hour', 'Move conflict'
) is not null, true, 'the target time is blocked before a move') from test_fixtures;
create function pg_temp.move_reports_occupancy_conflict(p_tenant_id uuid, p_appointment_id uuid, p_starts_at timestamptz)
returns boolean language plpgsql as $$
begin
  perform public.move_appointment(p_tenant_id, p_appointment_id, p_starts_at);
  return false;
exception when exclusion_violation then
  return true;
end;
$$;
select extensions.is(pg_temp.move_reports_occupancy_conflict(tenant_a, booking_a1, move_starts_at), true, 'a move into an occupied resource is rejected') from test_fixtures;
select extensions.is((select starts_at from public.appointments where id = booking_a1), starts_at, 'a failed move preserves the original appointment time') from test_fixtures;
select extensions.is((select count(*) from public.resource_occupancies where appointment_id = booking_a1 and released_at is null), 1::bigint, 'a failed move keeps the original resource occupancy') from test_fixtures;

update test_fixtures set booking_long = (public.create_public_booking(
  slug_a, 'long-service', long_starts_at, 'Long Customer', '+70000000004', 'Long Car', key_long, 'token-hash-long'
)->>'id')::uuid;
select extensions.is((select ends_at from public.appointments where id = booking_long), long_starts_at + interval '30 hours', 'long work reserves its full duration') from test_fixtures;
select extensions.is((
  select available_count from public.public_booking_slots(slug_a, 'long-service', booking_day + 2)
  where starts_at = (((booking_day + 2) + time '09:00') at time zone 'Europe/Moscow')
), 0, 'a multi-day service blocks the resource on the following day') from test_fixtures;

update public.services set price_minor = 99999 where id = (select service_a from test_fixtures);
select extensions.is((select price_minor from public.appointments where id = booking_a1), 12345::bigint, 'a later price change does not change the historical appointment price') from test_fixtures;
select extensions.ok(public.add_payment(tenant_a, booking_a1, 'charge', 5000, 'cash', 'Paid', null) is not null, 'a charge is recorded') from test_fixtures;
select extensions.ok(public.add_payment(tenant_a, booking_a1, 'refund', 1000, 'cash', 'Refunded', null) is not null, 'a refund is recorded separately') from test_fixtures;
select extensions.is((select collected_minor from public.owner_metrics_for_edge(tenant_a, now() - interval '1 day', now() + interval '90 days')), 4000::bigint, 'metrics use net payments actually recorded') from test_fixtures;
select extensions.is((public.set_appointment_status(tenant_a, booking_a1, 'completed')).status, 'completed'::public.appointment_status, 'an appointment can be marked complete') from test_fixtures;
select extensions.is((select completed from public.owner_metrics_for_edge(tenant_a, now() - interval '1 day', now() + interval '90 days')), 1::bigint, 'completed work is counted separately') from test_fixtures;
select extensions.is((select arrivals from public.owner_metrics_for_edge(tenant_a, now() - interval '1 day', now() + interval '90 days')), 3::bigint, 'confirmed and completed work is counted as arrivals') from test_fixtures;
select extensions.is(public.cancel_appointment(tenant_a, booking_a2), true, 'cancellation releases the selected resource') from test_fixtures;
select extensions.is((select available_count from public.public_booking_slots(slug_a, 'wash', booking_day) where starts_at = test_fixtures.starts_at), 1, 'cancelling reopens the resource while the other booking and block remain') from test_fixtures;

insert into public.date_overrides (tenant_id, local_date, is_closed, label)
select tenant_a, booking_day + 3, true, 'Closed test day' from test_fixtures;
select extensions.is((select count(*) from public.public_booking_slots(slug_a, 'wash', booking_day + 3)), 0::bigint, 'a closed date override hides all booking windows') from test_fixtures;
select extensions.throws_ok($test$
  select public.create_public_booking(
    (select slug_a from test_fixtures), 'wash', (((select booking_day from test_fixtures) + 3 + time '10:00') at time zone 'Europe/Moscow'),
    'Closed Day Customer', '+70000000005', 'Closed Car', extensions.gen_random_uuid(), 'closed-day-hash'
  )
$test$, '22023', 'OUTSIDE_OPENING_HOURS', 'a direct request cannot bypass a closed date override');

update test_fixtures set booking_b = (public.create_public_booking(
  slug_b, 'wash', starts_at, 'Other Tenant Customer', '+71111111111', 'Other Car', key_b, 'token-hash-b'
)->>'id')::uuid;
select extensions.ok(public.add_payment(tenant_b, booking_b, 'charge', 7000, 'cash', 'Other tenant payment', null) is not null, 'the second tenant has independent payment data') from test_fixtures;
select extensions.ok(not has_table_privilege('anon', 'public.appointments', 'SELECT'), 'anonymous clients cannot read appointment rows directly');
select extensions.ok(not has_table_privilege('anon', 'public.payments', 'SELECT'), 'anonymous clients cannot read payment rows directly');
select extensions.ok(not has_function_privilege('authenticated', 'public.reserve_llm_budget(uuid,date,integer,integer,integer,bigint,bigint)', 'EXECUTE'), 'authenticated clients cannot spend the model budget');
select extensions.ok(not has_function_privilege('authenticated', 'public.owner_metrics_for_edge(uuid,timestamp with time zone,timestamp with time zone)', 'EXECUTE'), 'authenticated clients cannot call the service-role assistant metrics tool');
select extensions.ok(has_function_privilege('service_role', 'public.owner_metrics_for_edge(uuid,timestamp with time zone,timestamp with time zone)', 'EXECUTE'), 'the server can call its assistant metrics tool');
select extensions.is(public.reserve_llm_budget(tenant_a, booking_day, 0, 100, 100, 1000, 1000), false, 'a zero-call model budget cannot be bypassed on its first request') from test_fixtures;
select extensions.is(public.reserve_llm_budget(tenant_a, booking_day, 1, 100, 100, 1000, 1000), true, 'the model budget atomically reserves its first request') from test_fixtures;
select extensions.is(public.reserve_llm_budget(tenant_a, booking_day, 1, 100, 100, 1000, 1000), false, 'the model budget rejects a request that exceeds a daily limit') from test_fixtures;
select extensions.is((select reserved_calls from public.llm_usage_daily where tenant_id = tenant_a and local_day = booking_day), 1, 'rejected model calls do not increase the reserved call count') from test_fixtures;

insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select owner_id, 'authenticated', 'authenticated', owner_id::text || '@pgtap.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
from test_fixtures;
insert into public.tenant_memberships (tenant_id, user_id, role)
select tenant_a, owner_id, 'owner' from test_fixtures;
grant select on test_fixtures to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select owner_id::text from test_fixtures), true);
select extensions.is((select count(*) from public.appointments where tenant_id = (select tenant_a from test_fixtures)), 3::bigint, 'the owner can read appointments in their own tenant');
select extensions.is((select count(*) from public.appointments where tenant_id = (select tenant_b from test_fixtures)), 0::bigint, 'the owner cannot read another tenant appointments');
select extensions.is((select count(*) from public.payments where tenant_id = (select tenant_a from test_fixtures)), 2::bigint, 'the owner can read their tenant payments');
select extensions.is((select count(*) from public.payments where tenant_id = (select tenant_b from test_fixtures)), 0::bigint, 'the owner cannot read another tenant payments');
select extensions.is((select arrivals from public.owner_metrics((select tenant_a from test_fixtures), now() - interval '1 day', now() + interval '90 days')), 2::bigint, 'owner metrics require membership and return tenant-scoped totals');
select extensions.throws_ok($test$
  select * from public.owner_metrics((select tenant_b from test_fixtures), now() - interval '1 day', now() + interval '90 days')
$test$, '42501', 'TENANT_ACCESS_DENIED', 'an owner cannot request metrics for another tenant');
reset role;

select extensions.is((select count(*) from public.notification_jobs where tenant_id = (select tenant_a from test_fixtures) and appointment_id = (select booking_a1 from test_fixtures) and job_type = 'booking_confirmed'), 1::bigint, 'an idempotent retry creates only one confirmation outbox job');
update test_fixtures set leased_job = (select id from public.claim_notification_jobs(1) limit 1);
select extensions.ok((select leased_job is not null from test_fixtures), 'notification dispatch claims a job with a lease');
select public.finish_notification_job(leased_job, false, 'test retry') from test_fixtures;
select extensions.is((select state from public.notification_jobs where id = (select leased_job from test_fixtures)), 'pending'::public.notification_state, 'a failed delivery returns to pending for retry');
select extensions.is((select attempts from public.notification_jobs where id = (select leased_job from test_fixtures)), 1, 'outbox retry attempts are tracked');

select * from extensions.finish();
rollback;
