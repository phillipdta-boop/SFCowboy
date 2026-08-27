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

  it("adds a status column defaulting to 'active' to a pre-existing pipelines table that predates it", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        connection_ids TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '[]')`).run();

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(pipelines)").all().map((row: any) => row.name);
    expect(columns).toContain("status");

    const row = db.prepare("SELECT status FROM pipelines WHERE id = 'p1'").get() as any;
    expect(row.status).toBe("active");
    db.close();
  });

  it("adds a title column to a pre-existing deployments table that predates it", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        source_connection_id TEXT NOT NULL,
        target_connection_id TEXT NOT NULL,
        component_list TEXT NOT NULL,
        test_level TEXT NOT NULL,
        status TEXT NOT NULL,
        validate_only INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
       VALUES ('d1', 's', 't', '[]', 'NoTestRun', 'pending', '2026-01-01T00:00:00.000Z')`
    ).run();

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(deployments)").all().map((row: any) => row.name);
    expect(columns).toContain("title");

    const row = db.prepare("SELECT title FROM deployments WHERE id = 'd1'").get() as any;
    expect(row.title).toBeNull();
    db.close();
  });

  it("adds a last_error column to a pre-existing connections table that predates it", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        nickname TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', '2026-01-01T00:00:00.000Z')`).run();

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(connections)").all().map((row: any) => row.name);
    expect(columns).toContain("last_error");

    const row = db.prepare("SELECT last_error FROM connections WHERE id = 'c1'").get() as any;
    expect(row.last_error).toBeNull();
    db.close();
  });
});
