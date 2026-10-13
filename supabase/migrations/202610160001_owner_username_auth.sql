-- Add username to tenant_memberships for non-email owner authentication
-- Username must be unique across all tenants and used as the login identifier

-- 1. Add the username column
ALTER TABLE public.tenant_memberships
  ADD COLUMN IF NOT EXISTS username text;

-- 2. Add NOT NULL + UNIQUE constraint (requires username for existing members)
ALTER TABLE public.tenant_memberships
  ALTER COLUMN username SET NOT NULL;

ALTER TABLE public.tenant_memberships
  ADD CONSTRAINT tenant_memberships_username_unique UNIQUE (username);

-- 3. Create an index for fast lookup during login
CREATE INDEX IF NOT EXISTS idx_tenant_memberships_username
  ON public.tenant_memberships(username);

COMMENT ON COLUMN public.tenant_memberships.username IS
  'Unique display name used for owner login instead of email. Maps to user_id in auth.users.';
