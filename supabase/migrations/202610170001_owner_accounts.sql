-- Owner accounts managed from the admin panel (username + password only).
-- Adds an OPTIONAL recovery contact email on tenant_memberships: it is never
-- required for login and never used as the Supabase Auth email. Auth uses a
-- synthetic internal address (<username>@owners.local) created with
-- email_confirm=true, so login works with email confirmation flows and the
-- recovery address is only a contact for the admin to reach the owner
-- out-of-band (e.g. to pass a new password set via admin-api update-owner).
-- Also appends owner-account audit actions. Idempotent: ADD COLUMN IF NOT
-- EXISTS + DROP/ADD constraint, safe to re-run.

alter table public.tenant_memberships
  add column if not exists recovery_email text not null default '';

comment on column public.tenant_memberships.recovery_email is
  'Optional contact email for the owner (password hand-off only). Never used for login; auth uses a synthetic internal address.';

-- Normalize historic usernames to the canonical lowercase form used by
-- sign-in and admin-api (both lowercase before compare).
update public.tenant_memberships
  set username = lower(username)
  where username <> lower(username);

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_action_check;

alter table public.admin_audit_log
  add constraint admin_audit_log_action_check check (action in (
    'admin.login', 'admin.suspend', 'admin.reactivate',
    'admin.archive', 'admin.unarchive', 'admin.view',
    'admin.create', 'admin.publish', 'admin.activate',
    'admin.update', 'admin.save-service', 'admin.save-resource',
    'admin.save-date-override',
    'admin.create-owner', 'admin.update-owner', 'admin.delete-owner'
  ));
