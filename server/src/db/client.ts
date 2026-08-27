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

  const pipelinesColumns = db.prepare("PRAGMA table_info(pipelines)").all() as { name: string }[];
  const hasStatus = pipelinesColumns.some((col) => col.name === "status");
  if (!hasStatus) {
    db.exec("ALTER TABLE pipelines ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))");
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
}
