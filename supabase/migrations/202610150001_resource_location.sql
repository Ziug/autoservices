-- Resource physical-location label.
-- The admin UI conflated resources.slug with the physical placement of a
-- post; this adds an explicit free-text location per resource row.
-- Purely additive: NOT NULL with DEFAULT '' so existing rows backfill to
-- empty; no RLS/grant/RPC/CHECK/exclusion changes. The 120-char limit is
-- enforced in supabase/functions/admin-api (save-resource schema), not here.
-- Idempotent (IF NOT EXISTS), safe to re-run.

alter table public.resources
  add column if not exists location text not null default '';

comment on column public.resources.location is
  'Physical placement label for the post (hall, address note, etc.). Max 120 chars enforced in admin-api; empty means unset.';
