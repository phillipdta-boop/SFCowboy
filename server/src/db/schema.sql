CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
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
  organization_id TEXT REFERENCES organizations(id),
  name TEXT NOT NULL,
  connection_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  track_components_independently INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  title TEXT,
  component_list TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
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
  organization_id TEXT REFERENCES organizations(id),
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  metadata_type TEXT NOT NULL,
  api_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add','modify','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  -- Soft-delete for "remove a member": set, never row-deleted. A hard delete would violate
  -- invites.created_by's FK the moment a removed admin's past invites are looked at, and would
  -- discard a real audit trail for no benefit. NULL = active member.
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
