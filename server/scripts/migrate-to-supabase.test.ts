import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { migrateToSupabase } from "./migrate-to-supabase.js";

describe("migrateToSupabase", () => {
  let source: TestDb;
  let target: TestDb;
  // organizations is a shared, project-wide table (not isolated per test schema -- see testDb.ts's
  // opening comment), so every org this file creates must be explicitly deleted here or it leaks
  // into the real sfcowboy-dev project forever. Same createdOrgIds pattern as team.test.ts. This
  // also cleans up the fixed-literal org id used below on this file's very next run, even if it
  // was left behind by an earlier, pre-fix run of this same test file.
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    // target must be stopped (dropping its per-test schema) BEFORE the organizations row is
    // deleted: connections/pipelines/etc. each declare `organization_id ... REFERENCES
    // organizations(id)`, and migrateToSupabase inserts its rows into TARGET with that FK pointed
    // at this org -- deleting the org first would violate that constraint (silently, since the
    // query below is caught). source's own seed rows use the default org (not this test's org
    // id), so source has no such reference and can be stopped in any order.
    await target?.stop();
    for (const id of createdOrgIds.splice(0)) {
      await source?.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await source?.stop();
  });

  async function seedOrg(target: TestDb, orgId: string) {
    createdOrgIds.push(orgId);
    // ON CONFLICT DO NOTHING: this literal id may already exist from a previous `it` block in
    // this same file inserting it first.
    await target.pool.query(
      `INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [orgId, "Migrated Org", new Date().toISOString()]
    );
  }

  it("copies every row from source to target, assigning the given organization_id", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await seedOrg(target, orgId);

    await source.pool.query(
      `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Source Connection', '2026-01-01T00:00:00.000Z')`
    );
    await source.pool.query(
      `INSERT INTO pipelines (id, name, connection_ids, status) VALUES ('p1', 'Source Pipeline', '["c1"]', 'active')`
    );

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);

    const connectionsCopied = summary.find((s) => s.table === "connections");
    expect(connectionsCopied?.rowCount).toBe(1);

    const targetConnection = await target.pool.query(`SELECT nickname, organization_id FROM connections WHERE id = 'c1'`);
    expect(targetConnection.rows[0]).toEqual({ nickname: "Source Connection", organization_id: orgId });

    const targetPipeline = await target.pool.query(`SELECT name, organization_id FROM pipelines WHERE id = 'p1'`);
    expect(targetPipeline.rows[0].organization_id).toBe(orgId);
  });

  it("is safe to run when a table has zero rows", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await seedOrg(target, orgId);

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);
    expect(summary.every((s) => s.rowCount === 0)).toBe(true);
  });

  it("rolls back every table's inserts, including earlier tables already copied in the same run, if a later table's insert fails", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await seedOrg(target, orgId);

    await source.pool.query(
      `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Source Connection', '2026-01-01T00:00:00.000Z')`
    );
    await source.pool.query(
      `INSERT INTO pipelines (id, name, connection_ids, status) VALUES ('p1', 'Source Pipeline', '["c1"]', 'active')`
    );

    // Pre-seed the target's pipelines table with a colliding primary key ('p1') so the migration's
    // SECOND table (pipelines, per TABLES_IN_DEPENDENCY_ORDER -- connections copies first) fails
    // with a duplicate-key violation. Without a transaction, connections' row would already be
    // committed by the time this failure happens; with one, it must be rolled back too.
    await target.pool.query(`INSERT INTO pipelines (id, name, connection_ids, status, organization_id) VALUES ('p1', 'Existing Pipeline', '[]', 'active', $1)`, [
      orgId,
    ]);

    await expect(migrateToSupabase(source.pool, target.pool, orgId)).rejects.toThrow();

    const targetConnections = await target.pool.query(`SELECT * FROM connections WHERE id = 'c1'`);
    expect(targetConnections.rows).toHaveLength(0);
  });
});
