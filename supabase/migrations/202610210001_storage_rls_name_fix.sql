-- Fix the same unqualified-column shadowing class in tenant-media storage
-- policies (fail-closed availability bug, not a leak).
--
-- Root cause: inside EXISTS (... tenants tenant ...), unqualified `name`
-- binds to the INNER tenants.name (studio display name, e.g. 'Simple Car'),
-- not to storage.objects.name (the '<slug>/...' path). The predicate
-- `tenant.slug = split_part(name, '/', 1)` therefore compares the slug to
-- the display name and is ~always false: public reads of published tenant
-- media are denied and member uploads/updates are denied too.
-- Fix: qualify storage.objects.name explicitly. Policy names, roles,
-- commands and the preview/live guards are preserved. Safe to re-run.

drop policy if exists "Public reads published tenant media" on storage.objects;
create policy "Public reads published tenant media" on storage.objects
for select to anon, authenticated
using (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenants tenant
  where tenant.slug = split_part(storage.objects.name, '/', 1)
    and tenant.status in ('preview', 'live')
));

drop policy if exists "Tenant members upload media only under their slug" on storage.objects;
create policy "Tenant members upload media only under their slug" on storage.objects
for insert to authenticated
with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership
  join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid()
    and tenant.slug = split_part(storage.objects.name, '/', 1)
    and tenant.status in ('preview', 'live')
));

drop policy if exists "Tenant members update media only under their slug" on storage.objects;
create policy "Tenant members update media only under their slug" on storage.objects
for update to authenticated
using (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership
  join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid()
    and tenant.slug = split_part(storage.objects.name, '/', 1)
    and tenant.status in ('preview', 'live')
)) with check (bucket_id = 'tenant-media' and exists (
  select 1 from public.tenant_memberships membership
  join public.tenants tenant on tenant.id = membership.tenant_id
  where membership.user_id = auth.uid()
    and tenant.slug = split_part(storage.objects.name, '/', 1)
    and tenant.status in ('preview', 'live')
));
