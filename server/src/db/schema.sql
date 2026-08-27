CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
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
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  title TEXT,
  source_connection_id TEXT NOT NULL,
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
  run_by TEXT
);

CREATE TABLE IF NOT EXISTS deployment_items (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  metadata_type TEXT NOT NULL,
  api_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add','modify','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  error_message TEXT
);
