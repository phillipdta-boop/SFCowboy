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

  const pipelinesColumns = db.prepare("PRAGMA table_info(pipelines)").all() as { name: string }[];
  const hasStatus = pipelinesColumns.some((col) => col.name === "status");
  if (!hasStatus) {
    db.exec("ALTER TABLE pipelines ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))");
  }
}
