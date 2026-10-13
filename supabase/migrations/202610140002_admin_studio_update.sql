-- Studio-setup upgrades: audit rows for admin content edits.
-- Appends 'admin.update', 'admin.save-service', 'admin.save-resource',
-- 'admin.save-date-override' to the admin_audit_log action CHECK.
-- Existing values kept verbatim; only appended. No RLS/grant/RPC changes.
-- Idempotent: DROP IF EXISTS + ADD, safe to re-run.

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_action_check;

alter table public.admin_audit_log
  add constraint admin_audit_log_action_check check (action in (
    'admin.login', 'admin.suspend', 'admin.reactivate',
    'admin.archive', 'admin.unarchive', 'admin.view',
    'admin.create', 'admin.publish', 'admin.activate',
    'admin.update', 'admin.save-service', 'admin.save-resource',
    'admin.save-date-override'
  ));
