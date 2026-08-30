import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function runMigrations(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);

  // schema.sql's CREATE TABLE IF NOT EXISTS won't alter a table that already exists from an
  // older schema version, so additive columns need an explicit, idempotent ALTER here.
  const connectionsColumns = db.prepare("PRAGMA table_info(connections)").all() as { name: string }[];
  const hasClientId = connectionsColumns.some((col) => col.name === "encrypted_client_id");
  if (!hasClientId) {
    db.exec("ALTER TABLE connections ADD COLUMN encrypted_client_id TEXT");
  }
  const hasLastError = connectionsColumns.some((col) => col.name === "last_error");
  if (!hasLastError) {
    db.exec("ALTER TABLE connections ADD COLUMN last_error TEXT");
  }
  const hasLoginUsername = connectionsColumns.some((col) => col.name === "login_username");
  if (!hasLoginUsername) {
    db.exec("ALTER TABLE connections ADD COLUMN login_username TEXT");
  }
  const hasMinCoverage = connectionsColumns.some((col) => col.name === "min_code_coverage_percent");
  if (!hasMinCoverage) {
    db.exec("ALTER TABLE connections ADD COLUMN min_code_coverage_percent INTEGER");
  }

  const pipelinesColumns = db.prepare("PRAGMA table_info(pipelines)").all() as { name: string }[];
  const hasStatus = pipelinesColumns.some((col) => col.name === "status");
  if (!hasStatus) {
    db.exec("ALTER TABLE pipelines ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))");
  }
  const hasTrackIndependently = pipelinesColumns.some((col) => col.name === "track_components_independently");
  if (!hasTrackIndependently) {
    db.exec("ALTER TABLE pipelines ADD COLUMN track_components_independently INTEGER NOT NULL DEFAULT 1");
  }

  const deploymentsColumns = db.prepare("PRAGMA table_info(deployments)").all() as { name: string }[];
  const hasTitle = deploymentsColumns.some((col) => col.name === "title");
  if (!hasTitle) {
    db.exec("ALTER TABLE deployments ADD COLUMN title TEXT");
  }
  for (const column of ["ignore_warnings", "allow_missing_files", "auto_update_package"]) {
    if (!deploymentsColumns.some((col) => col.name === column)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
  }
  if (!deploymentsColumns.some((col) => col.name === "run_tests")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN run_tests TEXT NOT NULL DEFAULT '[]'`);
  }
  for (const column of ["sf_job_id", "components_deployed", "components_total", "tests_completed", "tests_total"]) {
    if (!deploymentsColumns.some((col) => col.name === column)) {
      const type = column === "sf_job_id" ? "TEXT" : "INTEGER";
      db.exec(`ALTER TABLE deployments ADD COLUMN ${column} ${type}`);
    }
  }
  if (!deploymentsColumns.some((col) => col.name === "run_by")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN run_by TEXT`);
  }
  if (!deploymentsColumns.some((col) => col.name === "pipeline_run_id")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id)`);
  }
  if (!deploymentsColumns.some((col) => col.name === "pipeline_step_index")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN pipeline_step_index INTEGER`);
  }
  if (!deploymentsColumns.some((col) => col.name === "coverage_percent")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN coverage_percent REAL`);
  }
  if (!deploymentsColumns.some((col) => col.name === "coverage_details")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN coverage_details TEXT`);
  }
  for (const column of ["source_branch", "target_branch"]) {
    if (!deploymentsColumns.some((col) => col.name === column)) {
      db.exec(`ALTER TABLE deployments ADD COLUMN ${column} TEXT`);
    }
  }

  // SQLite can't ALTER a CHECK constraint in place, so a deployments table created before
  // 'cancelled' existed needs a full rebuild. deployment_items.deployment_id REFERENCES
  // deployments(id), and renaming deployments itself (e.g. to deployments_old) makes SQLite
  // auto-rewrite that FK text to follow the rename — which then dangles once the renamed copy is
  // dropped. Building the replacement under a temp name, copying from the still-named-'deployments'
  // original, then dropping the original and renaming the replacement into its place never touches
  // deployment_items's FK text, so it keeps resolving to whichever table is actually named
  // 'deployments' at the end.
  const deploymentsTableSql = (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deployments'`).get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (deploymentsTableSql && !deploymentsTableSql.includes("'cancelled'")) {
    const oldColumns = (db.prepare("PRAGMA table_info(deployments)").all() as { name: string }[]).map((c) => c.name);
    const match = schema.match(/CREATE TABLE IF NOT EXISTS deployments \(([\s\S]*?)\n\);/);
    if (!match) throw new Error("Could not find the deployments table definition in schema.sql");
    const newTableSql = `CREATE TABLE deployments_new (${match[1]}\n)`;

    const fkWasOn = db.pragma("foreign_keys", { simple: true }) === 1;
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(newTableSql);
        const columnList = oldColumns.join(", ");
        db.exec(`INSERT INTO deployments_new (${columnList}) SELECT ${columnList} FROM deployments`);
        db.exec("DROP TABLE deployments");
        db.exec("ALTER TABLE deployments_new RENAME TO deployments");
      })();
    } finally {
      if (fkWasOn) db.pragma("foreign_keys = ON");
    }
  }
}
