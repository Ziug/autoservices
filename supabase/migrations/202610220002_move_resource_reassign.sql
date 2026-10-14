-- Allow move_appointment to reassign to another compatible resource.
--
-- Product decision: a move previously kept the same post and failed even when
-- a different compatible post was free at the target time. The move now tries
-- the current post first (stable history when possible), then other compatible
-- posts in slug order — the same rule as create_public_booking.
-- Atomicity contract (unchanged): the old occupancy stays live until the new
-- one commits; on total failure nothing is written and the original booking
-- (time, post, occupancy) is preserved. Also applies the same closing-time
-- rule as creation (same-day work must end by closes_at; multi-day exempt).

create or replace function public.move_appointment(p_tenant_id uuid, p_appointment_id uuid, p_starts_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_appointment public.appointments%rowtype;
  v_service public.services%rowtype;
  v_occupancy public.resource_occupancies%rowtype;
  v_tenant public.tenants%rowtype;
  v_resource public.resources%rowtype;
  v_override public.date_overrides%rowtype;
  v_local_start timestamp;
  v_local_end timestamp;
  v_hours jsonb;
  v_opens_at time;
  v_closes_at time;
begin
  select * into v_appointment from public.appointments where tenant_id = p_tenant_id and id = p_appointment_id for update;
  if not found or v_appointment.status <> 'confirmed' then raise exception 'APPOINTMENT_NOT_MOVABLE' using errcode = '22023'; end if;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  select * into v_service from public.services where tenant_id = p_tenant_id and id = v_appointment.service_id and active;
  if not found then raise exception 'SERVICE_NOT_AVAILABLE' using errcode = '22023'; end if;
  if p_starts_at <= now() or p_starts_at > now() + interval '90 days' then raise exception 'INVALID_BOOKING_TIME' using errcode = '22023'; end if;
  v_local_start := p_starts_at at time zone v_tenant.timezone;
  select item into v_hours from jsonb_array_elements(v_tenant.opening_hours) item
    where (item->>'weekday')::integer = extract(dow from v_local_start)::integer limit 1;
  select * into v_override from public.date_overrides where tenant_id = p_tenant_id and local_date = v_local_start::date;
  if found then
    if v_override.is_closed then raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023'; end if;
    v_opens_at := v_override.opens_at;
    v_closes_at := v_override.closes_at;
  elsif v_hours is not null then
    v_opens_at := (v_hours->>'opensAt')::time;
    v_closes_at := (v_hours->>'closesAt')::time;
  else
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  if v_local_start::time < v_opens_at or v_local_start::time >= v_closes_at
    or mod((extract(epoch from (v_local_start::time - v_opens_at)) / 60)::integer, v_tenant.booking_step_minutes) <> 0 then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  v_local_end := (p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes)) at time zone v_tenant.timezone;
  if v_local_end::date = v_local_start::date and v_local_end::time > v_closes_at then
    raise exception 'OUTSIDE_OPENING_HOURS' using errcode = '22023';
  end if;
  select * into v_occupancy from public.resource_occupancies where tenant_id = p_tenant_id and appointment_id = p_appointment_id and released_at is null for update;
  if not found then raise exception 'APPOINTMENT_OCCUPANCY_NOT_FOUND' using errcode = '22023'; end if;
  for v_resource in
    select * from public.resources resources
    where resources.tenant_id = p_tenant_id and resources.active
      and (resources.resource_type = 'any' or v_service.resource_types = array['any']::text[] or resources.resource_type = any(v_service.resource_types))
    order by (resources.id = v_occupancy.resource_id) desc, resources.slug
  loop
    begin
      if v_resource.id = v_occupancy.resource_id then
        -- Same post: shift the existing range in place. An in-place update
        -- never conflicts with its own old window, so a small nudge stays
        -- on the same post instead of spilling to another one.
        update public.resource_occupancies set occupied = tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
          p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)')
        where id = v_occupancy.id;
      else
        insert into public.resource_occupancies (tenant_id, resource_id, appointment_id, kind, occupied, label)
        values (p_tenant_id, v_resource.id, p_appointment_id, 'appointment',
          tstzrange(p_starts_at - make_interval(mins => v_service.buffer_before_minutes),
            p_starts_at + make_interval(mins => v_service.duration_minutes + v_service.buffer_after_minutes), '[)'), v_service.name);
      end if;
      update public.appointments set starts_at = p_starts_at, ends_at = p_starts_at + make_interval(mins => v_service.duration_minutes),
        resource_id = v_resource.id
      where id = p_appointment_id returning * into v_appointment;
      if v_resource.id <> v_occupancy.resource_id then
        update public.resource_occupancies set released_at = now() where id = v_occupancy.id;
      end if;
      update public.notification_jobs set state = 'cancelled', updated_at = now()
      where tenant_id = p_tenant_id and appointment_id = p_appointment_id and job_type = 'booking_reminder' and state = 'pending';
      if not (select is_demo from public.tenants where id = p_tenant_id) then
        insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
        values (p_tenant_id, p_appointment_id, 'booking_changed', now(), 'changed:' || p_appointment_id::text || ':' || extract(epoch from p_starts_at)::bigint::text,
          jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
        if p_starts_at > now() + interval '24 hours' then
          insert into public.notification_jobs (tenant_id, appointment_id, job_type, run_after, dedupe_key, payload)
          values (p_tenant_id, p_appointment_id, 'booking_reminder', p_starts_at - interval '24 hours', 'reminder:' || p_appointment_id::text || ':' || extract(epoch from p_starts_at)::bigint::text,
            jsonb_build_object('channel', 'push')) on conflict (tenant_id, dedupe_key) do nothing;
        end if;
      end if;
      return jsonb_build_object('id', v_appointment.id, 'starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at, 'status', v_appointment.status);
    exception when exclusion_violation then
      continue;
    end;
  end loop;
  raise exception 'SLOT_TAKEN' using errcode = '23P01';
end;
$$;
