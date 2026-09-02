import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { verifyLogin } from "./users.js";
import { bootstrapIfNeeded } from "./bootstrap.js";
import type { Config } from "../config.js";

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    databaseUrl: "unused",
    encryptionKey: "unused",
    oauthCallbackUrl: "unused",
    sfClientId: "unused",
    bootstrapAdminEmail: "admin@example.com",
    bootstrapAdminPassword: "bootstrap-password",
    bootstrapOrgName: "Bootstrapped Org",
    ...overrides,
  };
}

describe("bootstrapIfNeeded", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates one organization and one admin user when organizations is empty", async () => {
    db = await openTestDb();
    await bootstrapIfNeeded(db.pool, fakeConfig());

    const orgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Bootstrapped Org");

    const user = await verifyLogin(db.pool, "admin@example.com", "bootstrap-password");
    expect(user).toMatchObject({ organizationId: orgs[0].id, role: "admin" });
  });

  it("backfills organization_id on every existing row across all 5 tables", async () => {
    db = await openTestDb();
    const connId = randomUUID();
    const pipelineId = randomUUID();
    const deploymentId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    await db.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ($1, 'org', 'Existing', $2)`, [connId, new Date().toISOString()]);
    await db.pool.query(`INSERT INTO pipelines (id, name, connection_ids) VALUES ($1, 'Existing Pipeline', '[]')`, [pipelineId]);
    await db.pool.query(
      `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at) VALUES ($1, $2, '[]', 'NoTestRun', 'pending', $3)`,
      [deploymentId, connId, new Date().toISOString()]
    );
    await db.pool.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, 'ApexClass', 'A', 'add', 'pending')`,
      [itemId, deploymentId]
    );
    await db.pool.query(`INSERT INTO pipeline_runs (id, pipeline_id, component_list, created_at) VALUES ($1, $2, '[]', $3)`, [
      runId,
      pipelineId,
      new Date().toISOString(),
    ]);

    await bootstrapIfNeeded(db.pool, fakeConfig());
    const orgId = (await db.pool.query(`SELECT id FROM organizations`)).rows[0].id;

    for (const [table, id] of [
      ["connections", connId],
      ["pipelines", pipelineId],
      ["deployments", deploymentId],
      ["deployment_items", itemId],
      ["pipeline_runs", runId],
    ] as const) {
      const row = (await db.pool.query(`SELECT organization_id FROM ${table} WHERE id = $1`, [id])).rows[0];
      expect(row.organization_id).toBe(orgId);
    }
  });

  it("is a no-op on a second call once an organization already exists", async () => {
    db = await openTestDb();
    await bootstrapIfNeeded(db.pool, fakeConfig());
    const firstOrgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;

    await bootstrapIfNeeded(db.pool, fakeConfig({ bootstrapOrgName: "Should Not Be Created" }));
    const secondOrgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;

    expect(secondOrgs).toEqual(firstOrgs);
  });

  it("throws a clear error if organizations is empty but the bootstrap credentials aren't set", async () => {
    db = await openTestDb();
    await expect(bootstrapIfNeeded(db.pool, fakeConfig({ bootstrapAdminEmail: undefined, bootstrapAdminPassword: undefined }))).rejects.toThrow(
      /BOOTSTRAP_ADMIN_EMAIL/
    );
  });
});
