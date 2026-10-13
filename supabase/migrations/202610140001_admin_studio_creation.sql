-- Studio-creation upgrade: allow audit rows for the studio lifecycle actions.
-- Appends 'admin.create', 'admin.publish', 'admin.activate' to the
-- admin_audit_log action CHECK. Existing values are kept verbatim; only
-- appended. No RLS/grant/RPC/exclusion changes in this file.
-- Idempotent: DROP IF EXISTS + ADD, safe to re-run.

alter table public.admin_audit_log
  drop constraint if exists admin_audit_log_action_check;

alter table public.admin_audit_log
  add constraint admin_audit_log_action_check check (action in (
    'admin.login', 'admin.suspend', 'admin.reactivate',
    'admin.archive', 'admin.unarchive', 'admin.view',
    'admin.create', 'admin.publish', 'admin.activate'
  ));
