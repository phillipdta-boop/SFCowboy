-- Explicitly schema-qualified (unlike every other CREATE TABLE in this file) because this table
-- must always live in the one shared "public" schema, never inside a test run's own isolated
-- schema -- see this task's opening note on why organizations/app_users can't be duplicated
-- per-schema the way the rest of this file's tables are.
CREATE TABLE IF NOT EXISTS public.organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The one organization every row belongs to until Plan 2 threads real per-request organization_id
-- values through every write path. Its id is a fixed, well-known constant (the nil UUID) rather
-- than a randomly generated one specifically so the DEFAULT clauses below can reference it as a
-- literal -- a random id wouldn't be knowable at schema-authoring time. ON CONFLICT DO NOTHING
-- makes this safe to re-run on every boot (matches this file's CREATE TABLE IF NOT EXISTS
-- idempotency elsewhere).
INSERT INTO public.organizations (id, name, created_at)
VALUES ('00000000-0000-0000-0000-000000000000', 'My Organization', '1970-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
  type TEXT NOT NULL CHECK (type IN ('org', 'git')),
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  instance_url TEXT,
  org_type TEXT CHECK (org_type IN ('sandbox', 'production')),
  encrypted_refresh_token TEXT,
  remote_url TEXT,
  default_branch TEXT,
  encrypted_auth_token TEXT,
  encrypted_client_id TEXT,
  last_error TEXT,
  login_username TEXT,
  min_code_coverage_percent INTEGER
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
  name TEXT NOT NULL,
  connection_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  track_components_independently INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  title TEXT,
  component_list TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
  title TEXT,
  source_connection_id TEXT,
  target_connection_id TEXT NOT NULL,
  component_list TEXT NOT NULL,
  test_level TEXT NOT NULL CHECK (test_level IN ('NoTestRun','RunSpecifiedTests','RunLocalTests','RunAllTestsInOrg')),
  status TEXT NOT NULL CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back','cancelled')),
  validate_only INTEGER NOT NULL DEFAULT 0,
  ignore_warnings INTEGER NOT NULL DEFAULT 0,
  allow_missing_files INTEGER NOT NULL DEFAULT 0,
  auto_update_package INTEGER NOT NULL DEFAULT 0,
  run_tests TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_detail TEXT,
  snapshot_path TEXT,
  is_rollback_of TEXT REFERENCES deployments(id),
  sf_job_id TEXT,
  components_deployed INTEGER,
  components_total INTEGER,
  tests_completed INTEGER,
  tests_total INTEGER,
  run_by TEXT,
  pipeline_run_id TEXT REFERENCES pipeline_runs(id),
  pipeline_step_index INTEGER,
  coverage_percent REAL,
  coverage_details TEXT,
  source_branch TEXT,
  target_branch TEXT,
  static_analysis_findings TEXT,
  scheduled_at TEXT,
  package_path TEXT
);

CREATE TABLE IF NOT EXISTS deployment_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  metadata_type TEXT NOT NULL,
  api_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add','modify','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  error_message TEXT
);

-- Explicitly schema-qualified for the same reason as public.organizations above -- tied to
-- Supabase's single, global auth.users table via the FK below, so it must always be the one
-- shared table, never duplicated per test schema.
CREATE TABLE IF NOT EXISTS public.app_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name TEXT NOT NULL,
  disabled_at TIMESTAMPTZ
);

-- Fires whenever Supabase creates a new auth.users row (via admin.inviteUserByEmail or
-- admin.createUser) that was given organization_id/role metadata at creation time -- both
-- Task 4's createInvite and Task 5's bootstrapIfNeeded pass this metadata, so this single
-- trigger is the one place app_users rows get created, for both flows. A user created with no
-- such metadata (shouldn't happen given this plan's own code, but defensively) is simply not
-- given an app_users row and therefore can never pass requireSupabaseUser's lookup.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger AS $$
DECLARE
  org_id TEXT := NEW.raw_app_meta_data->>'organization_id';
  user_role TEXT := NEW.raw_app_meta_data->>'role';
  user_name TEXT := COALESCE(NEW.raw_app_meta_data->>'name', NEW.email);
BEGIN
  IF org_id IS NOT NULL AND user_role IS NOT NULL THEN
    INSERT INTO public.app_users (id, organization_id, role, name)
    VALUES (NEW.id, org_id, user_role, user_name)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
