-- Correct simple-car schedule to the intended business rules: 30-minute
-- booking steps and 09:00-21:00 weekday closing.
--
-- Why data, not engine: the stored row has booking_step_minutes = 60 and
-- Mon-Fri closesAt 20:00, and public_booking_slots behaves exactly per that
-- config (hourly candidates, last start = close - step). No engine change.
-- Saturday 10:00-18:00 is left untouched (no evidence it should change).
-- Existing appointments are unaffected: occupancy ranges are absolute and do
-- not depend on the step. Safe to re-run (post-apply state is a no-op).

update public.tenants
set booking_step_minutes = 30,
    opening_hours = (
      select jsonb_agg(
        case
          when (item->>'weekday')::integer between 1 and 5
           and item->>'closesAt' = '20:00'
          then jsonb_set(item, '{closesAt}', '"21:00"')
          else item
        end
        order by (item->>'weekday')::integer
      )
      from jsonb_array_elements(opening_hours) as item
    )
where slug = 'simple-car';
