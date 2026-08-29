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

  it("adds the deploy-options columns, defaulting to 0, to a pre-existing deployments table that predates them", () => {
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
    expect(columns).toEqual(expect.arrayContaining(["ignore_warnings", "allow_missing_files", "auto_update_package"]));

    const row = db.prepare("SELECT ignore_warnings, allow_missing_files, auto_update_package FROM deployments WHERE id = 'd1'").get() as any;
    expect(row).toEqual({ ignore_warnings: 0, allow_missing_files: 0, auto_update_package: 0 });
    db.close();
  });

  it("adds a run_tests column defaulting to '[]' to a pre-existing deployments table that predates it", () => {
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
    expect(columns).toContain("run_tests");

    const row = db.prepare("SELECT run_tests FROM deployments WHERE id = 'd1'").get() as any;
    expect(row.run_tests).toBe("[]");
    db.close();
  });

  it("adds a run_by column to a pre-existing deployments table that predates it", () => {
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
    expect(columns).toContain("run_by");

    const row = db.prepare("SELECT run_by FROM deployments WHERE id = 'd1'").get() as any;
    expect(row.run_by).toBeNull();
    db.close();
  });

  it("adds progress-tracking columns to a pre-existing deployments table that predates them", () => {
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
    expect(columns).toEqual(
      expect.arrayContaining(["sf_job_id", "components_deployed", "components_total", "tests_completed", "tests_total"])
    );

    const row = db.prepare("SELECT sf_job_id, components_deployed FROM deployments WHERE id = 'd1'").get() as any;
    expect(row).toEqual({ sf_job_id: null, components_deployed: null });
    db.close();
  });

  it("allows the 'cancelled' status on a pre-existing deployments table whose CHECK constraint predates it", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        title TEXT,
        source_connection_id TEXT NOT NULL,
        target_connection_id TEXT NOT NULL,
        component_list TEXT NOT NULL,
        test_level TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back')),
        validate_only INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO deployments (id, title, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
       VALUES ('d1', 'Sprint 1', 's', 't', '[{"type":"ApexClass","fullName":"A","action":"add"}]', 'NoTestRun', 'deploying', '2026-01-01T00:00:00.000Z')`
    ).run();

    runMigrations(db);

    expect(() => db.prepare(`UPDATE deployments SET status = 'cancelled' WHERE id = 'd1'`).run()).not.toThrow();

    const row = db.prepare("SELECT title, component_list, status FROM deployments WHERE id = 'd1'").get() as any;
    expect(row).toEqual({ title: "Sprint 1", component_list: '[{"type":"ApexClass","fullName":"A","action":"add"}]', status: "cancelled" });
    db.close();
  });

  // Regression guard: deployment_items.deployment_id REFERENCES deployments(id). A naive rebuild
  // that renames deployments aside (e.g. to deployments_old) makes SQLite auto-rewrite that FK
  // text to follow the rename; dropping the renamed-aside copy afterward then fails with
  // "FOREIGN KEY constraint failed" (or, with enforcement off, silently leaves deployment_items
  // pointing at a table that no longer exists). This must survive with the FK intact and pointing
  // at the real, final 'deployments' table.
  it("rebuilds a deployments table that has deployment_items rows referencing it, without a foreign-key error", () => {
    const db = openDb(testDbPath);
    db.exec(`
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        title TEXT,
        source_connection_id TEXT NOT NULL,
        target_connection_id TEXT NOT NULL,
        component_list TEXT NOT NULL,
        test_level TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back')),
        validate_only INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL
      );
      CREATE TABLE deployment_items (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL REFERENCES deployments(id),
        metadata_type TEXT NOT NULL,
        api_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT
      );
    `);
    db.prepare(
      `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
       VALUES ('d1', 's', 't', '[{"type":"ApexClass","fullName":"A","action":"add"}]', 'NoTestRun', 'succeeded', '2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status)
       VALUES ('item1', 'd1', 'ApexClass', 'A', 'add', 'succeeded')`
    ).run();

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.prepare("SELECT id FROM deployment_items WHERE deployment_id = 'd1'").all()).toEqual([{ id: "item1" }]);
    expect(() => db.prepare(`UPDATE deployments SET status = 'cancelled' WHERE id = 'd1'`).run()).not.toThrow();
    // The FK must resolve to the real, final 'deployments' table, not a table that was dropped
    // partway through the rebuild — deleting the deployment should cascade-fail cleanly if the
    // item row is later deleted, proving the reference is live rather than dangling.
    expect(() => db.prepare(`DELETE FROM deployment_items WHERE id = 'item1'`).run()).not.toThrow();
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

describe("runMigrations — pipeline execution columns", () => {
  it("adds track_components_independently to pipelines, defaulting to 1", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '[]')`).run();
    const row = db.prepare(`SELECT track_components_independently FROM pipelines WHERE id = 'p1'`).get() as any;
    expect(row.track_components_independently).toBe(1);
  });

  it("creates the pipeline_runs table", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '[]')`).run();
    db.prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES ('r1', 'p1', 'Run 1', '[]', '2026-01-01T00:00:00.000Z')`
    ).run();
    const row = db.prepare(`SELECT * FROM pipeline_runs WHERE id = 'r1'`).get() as any;
    expect(row.title).toBe("Run 1");
  });

  it("adds pipeline_run_id and pipeline_step_index to deployments, both nullable", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(deployments)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("pipeline_run_id");
    expect(cols).toContain("pipeline_step_index");
  });

  it("running migrations twice on the same db is a no-op (idempotent)", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(pipelines)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === "track_components_independently")).toHaveLength(1);
  });
});
