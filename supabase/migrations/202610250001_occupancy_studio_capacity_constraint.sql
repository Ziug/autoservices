-- Studio-wide single capacity as a database constraint.
--
-- Until now the "one booking at a time" rule for a flagged tenant lived only
-- inside the RPC functions (create_public_booking, move_appointment,
-- create_availability_block). The table's exclusion constraint covers a
-- single POST (tenant_id, resource_id, occupied), so a studio-wide overlap
-- was only prevented as long as every write went through those RPCs and each
-- of them remembered the check. Any new write path — or a direct insert —
-- could double-book the studio.
--
-- The rule is now enforced by the database itself:
--   * resource_occupancies.studio_capacity_key carries the tenant id for
--     flagged tenants and NULL for everybody else.
--   * A new exclusion constraint rejects two overlapping live occupancies
--     that share the same key. NULL keys never conflict, so studios with
--     parallel posts keep booking in parallel.
--   * The key is maintained by triggers, so flipping the tenant flag takes
--     effect immediately and cannot leave the constraint unenforced.
--
-- Conflict detection lives in the GiST index, so it is race-free without
-- the advisory lock the RPC uses, and it protects every write path at once.

alter table public.resource_occupancies
  add column if not exists studio_capacity_key uuid;

comment on column public.resource_occupancies.studio_capacity_key is
  'Tenant id when the studio is flagged for single capacity, NULL otherwise; drives the studio-wide exclusion constraint.';

-- Keeps the key in sync with the tenant flag on every occupancy write.
create or replace function public.resource_occupancies_sync_capacity_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.studio_capacity_key := case
    when exists (select 1 from public.tenants where id = new.tenant_id and booking_single_capacity)
    then new.tenant_id
    else null
  end;
  return new;
end;
$$;

drop trigger if exists resource_occupancies_sync_capacity_key_trg on public.resource_occupancies;
create trigger resource_occupancies_sync_capacity_key_trg
  before insert or update on public.resource_occupancies
  for each row execute function public.resource_occupancies_sync_capacity_key();

-- Reacts to the flag being switched on or off. Enabling single capacity for
-- a studio that already has overlapping live work is refused with a clear
-- message instead of failing later with a constraint violation.
create or replace function public.tenants_sync_capacity_keys()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.booking_single_capacity is distinct from old.booking_single_capacity then
    if new.booking_single_capacity and exists (
      select 1
      from public.resource_occupancies a
      join public.resource_occupancies b
        on b.tenant_id = a.tenant_id and b.id > a.id
      where a.tenant_id = new.id
        and a.released_at is null
        and b.released_at is null
        and a.occupied && b.occupied
    ) then
      raise exception 'CANNOT_ENABLE_SINGLE_CAPACITY: the studio already has overlapping bookings'
        using errcode = '22023';
    end if;
    update public.resource_occupancies
    set studio_capacity_key = case when new.booking_single_capacity then tenant_id else null end
    where tenant_id = new.id and released_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists tenants_sync_capacity_keys_trg on public.tenants;
create trigger tenants_sync_capacity_keys_trg
  after update of booking_single_capacity on public.tenants
  for each row execute function public.tenants_sync_capacity_keys();

-- Backfill the rows that already exist.
update public.resource_occupancies o
set studio_capacity_key = o.tenant_id
where o.released_at is null
  and o.studio_capacity_key is distinct from o.tenant_id
  and exists (select 1 from public.tenants t where t.id = o.tenant_id and t.booking_single_capacity);

-- The database-level rule. NULL keys (multi-post studios) never conflict.
alter table public.resource_occupancies
  drop constraint if exists resource_occupancies_studio_capacity_excl;
alter table public.resource_occupancies
  add constraint resource_occupancies_studio_capacity_excl
  exclude using gist (studio_capacity_key with =, occupied with &&)
  where (released_at is null);

revoke all on function public.resource_occupancies_sync_capacity_key() from public, anon, authenticated;
revoke all on function public.tenants_sync_capacity_keys() from public, anon, authenticated;

grant execute on function public.resource_occupancies_sync_capacity_key() to service_role;
grant execute on function public.tenants_sync_capacity_keys() to service_role;

-- The RPCs must report the new studio-wide violation as SLOT_TAKEN (23P01),
-- the same error a taken post produces, so the Edge Functions keep mapping
-- it to HTTP 409 and the standard message.
--
-- create_public_booking: the resource loop already retries the next post on
-- an exclusion violation. A studio-wide conflict must NOT be retried on
-- another post — the studio as a whole is busy — so it is re-raised as
-- SLOT_TAKEN.
create or replace function public.create_public_booking(
  p_slug text,
  p_service_slug text,
  p_starts_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_vehicle text,
  p_idempotency_key uuid,
  p_access_token_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_tenant public.tenants%rowtype;
  v_service public.services%rowtype;
  v_resource public.resources%rowtype;
  v_existing public.appointments%rowtype;
  v_appointment public.appointments%rowtype;
  v_override public.date_overrides%rowtype;
  v_local_start timestamp;
  v_local_end timestamp;
  v_hours jsonb;
  v_opens_at time;
  v_closes_at time;
  v_resource_types text[];
begin
  select * into v_tenant from public.tenants where slug = p_slug and status in ('preview', 'live') for share;
  if not found then raise exception 'TENANT_NOT_AVAILABLE' using errcode = 'P0002'; end if;
  select * into v_service from public.services where tenant_id = v_tenant.id and slug = p_service_slug and active for share;
  if not found then raise exception 'SERVICE_NOT_AVAILABLE' using errcode = 'P0002'; end if;
  if length(trim(p_customer_name)) not between 2 and 100 or length(trim(p_customer_phone)) not between 5 and 40 or length(trim(p_vehicle)) not between 2 and 120 then
    raise exception 'INVALID_CUSTOMER_DETAILS' using errcode = '22023';
  end if;
  select * into v_existing from public.appointments where tenant_id = v_tenant.id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.access_token_hash <> p_access_token_hash then raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023'; end if;
    if v_existing.service_id <> v_service.id or v_existing.starts_at <> p_starts_at
      or v_existing.customer_name <> trim(p_customer_name) or v_existing.customer_phone <> trim(p_customer_phone)
      or v_existing.vehicle <> trim(p_vehicle) then
      raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023';
    end if;
    return jsonb_build_object('id', v_existing.id, 'tenant_id', v_existing.tenant_id, 'service_id', v_existing.service_id,
      'resource_id', v_existing.resource_id, 'starts_at', v_existing.starts_at, 'ends_at', v_existing.ends_at,
      'status', v_existing.status, 'price_minor', v_existing.price_minor, 'customer_name', v_existing.customer_name,
      'customer_phone', v_existing.customer_phone, 'vehicle', v_existing.vehicle, 'idempotent', true);
  end if;
  if p_starts_at <= now() then raise exception 'BOOKING_TIME_IN_PAST' using errcode = '22023'; end if;
  if p_starts_at > now() + interval '90 days' then raise exception 'BOOKING_TOO_FAR_AHEAD' using errcode = '22023'; end if;
  v_local_start := p_starts_at at time zone v_tenant.timezone;
  select item into v_hours from jsonb_array_elements(v_tenant.opening_hours) item
    where (item->>'weekday')::integer = extract(dow from v_local_start)::integer limit 1;
  select * into v_override from public.date_overrides where tenant_id = v_tenant.id and local_date = v_local_start::date;
  if found then
    if v_override.is_closed then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := v_override.opens_at;
    v_closes_at := v_override.closes_at;
  else
    if v_hours is null then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := (v_hours->>'opensAt')::time;
    v_closes_at := (v_hours->>'closesAt')::time;
  end if;
  if v_local_start::time < v_opens_at or v_local_start::time >= v_closes_at then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  if mod((extract(epoch from (v_local_start::time - v_opens_at)) / 60)::integer, v_tenant.booking_step_minutes) <> 0 then
    raise exception 'INVALID_BOOKING_STEP' using errcode = '22023';
  end if;
  v_local_end := (p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes)) at time zone v_tenant.timezone;
  if v_local_end::date = v_local_start::date and v_local_end::time > v_closes_at then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  if v_tenant.booking_single_capacity then
    -- Serialize bookings per tenant (transaction-scoped lock: pooler-safe)
    -- so the studio-wide overlap check below cannot race.
    perform pg_advisory_xact_lock(hashtextextended('booking-cap:' || v_tenant.id::text, 0));
    if exists (select 1 from public.resource_occupancies studio_occupancy
      where studio_occupancy.tenant_id = v_tenant.id and studio_occupancy.released_at is null
        and studio_occupancy.occupied && tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
          p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)')) then
      raise exception 'SLOT_TAKEN' using errcode = '23P01';
    end if;
  end if;

  for v_resource in
    select * from public.resources resources
    where resources.tenant_id = v_tenant.id and resources.active
      and (resources.resource_type = 'any' or v_service.resource_types = array['any']::text[] or resources.resource_type = any(v_service.resource_types))
    order by resources.slug
  loop
    begin
      insert into public.appointments (tenant_id, service_id, resource_id, customer_name, customer_phone, vehicle,
        starts_at, ends_at, price_minor, idempotency_key, access_token_hash)
      values (v_tenant.id, v_service.id, v_resource.id, trim(p_customer_name), trim(p_customer_phone), trim(p_vehicle),
        p_starts_at, p_starts_at + make_interval(mins => v_service.duration_minutes), v_service.price_minor, p_idempotency_key, p_access_token_hash)
      returning * into v_appointment;
      insert into public.resource_occupancies (tenant_id, resource_id, appointment_id, kind, occupied, label)
      values (v_tenant.id, v_resource.id, v_appointment.id, 'appointment',
        tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
          p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)'), v_service.name);
      if not v_tenant.is_demo and p_starts_at > now() + interval '24 hours' then
        insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
        values (v_tenant.id, v_appointment.id, 'booking_reminder', p_starts_at - interval '24 hours', 'reminder:' || v_appointment.id::text,
          jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
      end if;
      insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
      values (v_tenant.id, v_appointment.id, 'booking_confirmed', now(), 'confirmed:' || v_appointment.id::text,
        jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
      return jsonb_build_object('id', v_appointment.id, 'tenant_id', v_appointment.tenant_id, 'service_id', v_appointment.service_id,
        'resource_id', v_appointment.resource_id, 'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at,
        'status', v_appointment.status, 'price_minor', v_appointment.price_minor, 'customer_name', v_appointment.customer_name,
        'customer_phone', v_appointment.customer_phone, 'vehicle', v_appointment.vehicle, 'idempotent', false);
    exception when exclusion_violation then
      -- The studio-wide capacity constraint fired: the whole studio is busy
      -- for that window, so another post cannot help. Report it as a taken
      -- slot instead of silently trying the next post.
      if v_tenant.booking_single_capacity then
        raise exception 'SLOT_TAKEN' using errcode = '23P01';
      end if;
      continue;
    -- NOTE: any unique_violation here is assumed to be the
    -- UNIQUE(tenant_id, idempotency_key) conflict: every other INSERT in
    -- this block either uses ON CONFLICT DO NOTHING or keys that cannot
    -- collide (fresh UUID PKs). If a new unique constraint is ever added
    -- to appointments, this handler must check the constraint name first.
    when unique_violation then
      -- Same full comparison as the pre-loop replay check: a concurrent
      -- same-key booking with different details must report a mismatch
      -- (400), not a false idempotent hit and not a raw 500.
      select * into v_existing from public.appointments where tenant_id = v_tenant.id and idempotency_key = p_idempotency_key;
      if not found then raise; end if;
      if v_existing.access_token_hash <> p_access_token_hash then raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023'; end if;
      if v_existing.service_id <> v_service.id or v_existing.starts_at <> p_starts_at
        or v_existing.customer_name <> trim(p_customer_name) or v_existing.customer_phone <> trim(p_customer_phone)
        or v_existing.vehicle <> trim(p_vehicle) then
        raise exception 'IDEMPOTENCY_KEY_MISMATCH' using errcode = '22023';
      end if;
      return jsonb_build_object('id', v_existing.id, 'tenant_id', v_existing.tenant_id, 'service_id', v_existing.service_id,
        'resource_id', v_existing.resource_id, 'starts_at', v_existing.starts_at, 'ends_at', v_existing.ends_at,
        'status', v_existing.status, 'price_minor', v_existing.price_minor, 'customer_name', v_existing.customer_name,
        'customer_phone', v_existing.customer_phone, 'vehicle', v_existing.vehicle, 'idempotent', true);
    end;
  end loop;
  raise exception 'SLOT_TAKEN' using errcode = '23P01';
end;
$$;

-- create_availability_block: an owner-created block that would overlap a
-- live occupancy of a single-capacity studio is a taken slot, not a raw
-- constraint error.
create or replace function public.create_availability_block(p_tenant_id uuid, p_resource_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_ends_at <= p_starts_at then raise exception 'INVALID_BLOCK_RANGE' using errcode = '22023'; end if;
  if (select booking_single_capacity from public.tenants where id = p_tenant_id) then
    perform pg_advisory_xact_lock(hashtextextended('booking-cap:' || p_tenant_id::text, 0));
    if exists (select 1 from public.resource_occupancies studio_occupancy
      where studio_occupancy.tenant_id = p_tenant_id and studio_occupancy.released_at is null
        and studio_occupancy.occupied && tstzrange(p_starts_at, p_ends_at, '[)')) then
      raise exception 'SLOT_TAKEN' using errcode = '23P01';
    end if;
  end if;
  begin
    insert into public.resource_occupancies (tenant_id, resource_id, kind, occupied, label)
    values (p_tenant_id, p_resource_id, 'block', tstzrange(p_starts_at, p_ends_at, '[)'), left(trim(p_label), 120)) returning id into v_id;
  exception when exclusion_violation then
    raise exception 'SLOT_TAKEN' using errcode = '23P01';
  end;
  return v_id;
end;
$$;

revoke all on function public.create_public_booking(text, text, timestamptz, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.create_availability_block(uuid, uuid, timestamptz, timestamptz, text) from public, anon, authenticated;

grant execute on function public.create_public_booking(text, text, timestamptz, text, text, text, uuid, text) to service_role;
grant execute on function public.create_availability_block(uuid, uuid, timestamptz, timestamptz, text) to service_role;
