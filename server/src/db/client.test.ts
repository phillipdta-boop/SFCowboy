import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openDb, runMigrations } from "./client.js";

const testDbPath = "./test-sfcowboy.db";

afterEach(() => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

describe("db client", () => {
  it("creates all expected tables", () => {
    const db = openDb(testDbPath);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(["connections", "pipelines", "deployments", "deployment_items"])
    );
    db.close();
  });

  it("adds encrypted_client_id to a pre-existing connections table that predates the column", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        nickname TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(connections)").all().map((row: any) => row.name);
    expect(columns).toContain("encrypted_client_id");
    db.close();
  });

  it("running migrations twice on the same db does not error", () => {
    const db = openDb(testDbPath);
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });
});
