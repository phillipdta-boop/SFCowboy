import "dotenv/config";
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig, type Config } from "../config.js";
import { bootstrapIfNeeded } from "./bootstrap.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

// bootstrapIfNeeded's emptiness check is scoped to a single organization (see bootstrap.ts), so
// each test here creates its own throwaway organization and passes its id explicitly -- this
// keeps the test's precondition ("this org has no app_users row yet") genuinely isolated
// regardless of what real data (smoke-test admins, invited teammates, etc.) already lives in the
// shared sfcowboy-dev project's default organization. Same createdOrgIds cleanup pattern as
// team.test.ts, since organizations is not dropped when this test's own schema is torn down.
describe.skipIf(!hasRealSupabaseProject)("bootstrapIfNeeded", () => {
  let db: TestDb;
  const baseConfig = loadConfig();
  const admin = createSupabaseAdminClient(baseConfig);
  let createdUserId: string | undefined;
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      createdUserId = undefined;
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await db.stop();
  });

  async function createOrg(db: TestDb): Promise<string> {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      orgId,
      "Bootstrap Test Org",
      new Date().toISOString(),
    ]);
    return orgId;
  }

  it("creates one admin user scoped to the given organization when app_users is empty for that organization", async () => {
    db = await openTestDb();
    const orgId = await createOrg(db);
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };

    await bootstrapIfNeeded(db.pool, admin, config, orgId);

    const { data } = await admin.auth.admin.listUsers();
    const created = data.users.find((u) => u.email === email);
    expect(created).toBeDefined();
    createdUserId = created!.id;

    const row = await db.pool.query(`SELECT organization_id, role FROM app_users WHERE id = $1`, [created!.id]);
    expect(row.rows[0]).toEqual({ organization_id: orgId, role: "admin" });
  });

  it("is a no-op on a second call once an admin already exists for that organization", async () => {
    db = await openTestDb();
    const orgId = await createOrg(db);
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };
    await bootstrapIfNeeded(db.pool, admin, config, orgId);
    const { data: firstPass } = await admin.auth.admin.listUsers();
    createdUserId = firstPass.users.find((u) => u.email === email)!.id;

    await bootstrapIfNeeded(db.pool, admin, config, orgId);
    const { data: secondPass } = await admin.auth.admin.listUsers();
    expect(secondPass.users.filter((u) => u.email === email)).toHaveLength(1);
  });

  it("throws a clear error if app_users is empty for that organization but the bootstrap credentials aren't set", async () => {
    db = await openTestDb();
    const orgId = await createOrg(db);
    // Built explicitly without bootstrapAdminEmail/Password rather than reusing baseConfig
    // directly -- a real local .env (e.g. one already carrying credentials from a prior manual
    // bootstrap/smoke test) may have these set, which would otherwise make this test's own
    // "credentials aren't set" precondition false regardless of the org-scoping fix above.
    const configWithoutBootstrapCreds: Config = { ...baseConfig, bootstrapAdminEmail: undefined, bootstrapAdminPassword: undefined };
    await expect(bootstrapIfNeeded(db.pool, admin, configWithoutBootstrapCreds, orgId)).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
  });
});
