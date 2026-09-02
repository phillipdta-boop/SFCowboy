import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { migrateSqliteToPostgres } from "./migrate-sqlite-to-postgres.js";

describe("migrateSqliteToPostgres", () => {
  let testDb: TestDb | undefined;
  let sqlitePath: string | undefined;

  afterEach(async () => {
    if (testDb) await testDb.stop();
    if (sqlitePath) fs.rmSync(sqlitePath, { force: true });
    testDb = undefined;
    sqlitePath = undefined;
  });

  it("copies every row from a representative SQLite file into Postgres, matching row counts and content", async () => {
    sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-migrate-")), "sfcowboy.db");
    const sqlite = new Database(sqlitePath);
    sqlite.exec(`
      CREATE TABLE connections (id TEXT PRIMARY KEY, type TEXT NOT NULL, nickname TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, instance_url TEXT, org_type TEXT, encrypted_refresh_token TEXT, remote_url TEXT, default_branch TEXT, encrypted_auth_token TEXT, encrypted_client_id TEXT, last_error TEXT, login_username TEXT, min_code_coverage_percent INTEGER);
      CREATE TABLE pipelines (id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', track_components_independently INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, title TEXT, component_list TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE deployments (id TEXT PRIMARY KEY, title TEXT, source_connection_id TEXT, target_connection_id TEXT NOT NULL, component_list TEXT NOT NULL, test_level TEXT NOT NULL, status TEXT NOT NULL, validate_only INTEGER NOT NULL DEFAULT 0, ignore_warnings INTEGER NOT NULL DEFAULT 0, allow_missing_files INTEGER NOT NULL DEFAULT 0, auto_update_package INTEGER NOT NULL DEFAULT 0, run_tests TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT, error_detail TEXT, snapshot_path TEXT, is_rollback_of TEXT, sf_job_id TEXT, components_deployed INTEGER, components_total INTEGER, tests_completed INTEGER, tests_total INTEGER, run_by TEXT, pipeline_run_id TEXT, pipeline_step_index INTEGER, coverage_percent REAL, coverage_details TEXT, source_branch TEXT, target_branch TEXT, static_analysis_findings TEXT, scheduled_at TEXT, package_path TEXT);
      CREATE TABLE deployment_items (id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, metadata_type TEXT NOT NULL, api_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT);
    `);
    sqlite.prepare(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', '2026-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '["c1"]')`).run();
    sqlite
      .prepare(
        `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 'c1', 'c1', '[]', 'NoTestRun', 'pending', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ('i1', 'd1', 'ApexClass', 'A', 'add', 'pending')`
      )
      .run();
    sqlite.close();

    testDb = await openTestDb();
    const counts = await migrateSqliteToPostgres(sqlitePath, testDb.pool);

    expect(counts).toEqual({ connections: 1, pipelines: 1, pipeline_runs: 0, deployments: 1, deployment_items: 1 });

    const connectionRow = (await testDb.pool.query(`SELECT id, type, nickname FROM connections WHERE id = 'c1'`)).rows[0];
    expect(connectionRow).toEqual({ id: "c1", type: "org", nickname: "Dev" });

    const deploymentRow = (await testDb.pool.query(`SELECT id, status, component_list FROM deployments WHERE id = 'd1'`)).rows[0];
    expect(deploymentRow).toEqual({ id: "d1", status: "pending", component_list: "[]" });
  }, 60_000);
});
