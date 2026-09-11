import "dotenv/config";
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig, type Config } from "../config.js";
import { bootstrapIfNeeded } from "./bootstrap.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

// app_users is a shared, project-wide table in the real sfcowboy-dev project (see Task 2's
// opening note) -- this file's "empty" test relies on no OTHER row existing there when it runs.
// Sequential file execution (server/vitest.config.ts's fileParallelism: false, added in Task 2)
// and every other test file's own afterEach cleanup keep this true in the automated suite. It
// will start failing if a real admin is ever manually bootstrapped against sfcowboy-dev (e.g.
// Task 15's manual smoke test, which necessarily runs after this task) -- an accepted, disclosed
// limitation of testing against a real, persistent, shared project rather than a disposable one,
// not something to engineer around here.
describe.skipIf(!hasRealSupabaseProject)("bootstrapIfNeeded", () => {
  let db: TestDb;
  const baseConfig = loadConfig();
  const admin = createSupabaseAdminClient(baseConfig);
  let createdUserId: string | undefined;

  afterEach(async () => {
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      createdUserId = undefined;
    }
    await db.stop();
  });

  it("creates one admin user scoped to the default organization when app_users is empty", async () => {
    db = await openTestDb();
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };

    await bootstrapIfNeeded(db.pool, admin, config);

    const { data } = await admin.auth.admin.listUsers();
    const created = data.users.find((u) => u.email === email);
    expect(created).toBeDefined();
    createdUserId = created!.id;

    const row = await db.pool.query(`SELECT organization_id, role FROM app_users WHERE id = $1`, [created!.id]);
    expect(row.rows[0]).toEqual({ organization_id: "00000000-0000-0000-0000-000000000000", role: "admin" });
  });

  it("is a no-op on a second call once an admin already exists", async () => {
    db = await openTestDb();
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };
    await bootstrapIfNeeded(db.pool, admin, config);
    const { data: firstPass } = await admin.auth.admin.listUsers();
    createdUserId = firstPass.users.find((u) => u.email === email)!.id;

    await bootstrapIfNeeded(db.pool, admin, config);
    const { data: secondPass } = await admin.auth.admin.listUsers();
    expect(secondPass.users.filter((u) => u.email === email)).toHaveLength(1);
  });

  it("throws a clear error if app_users is empty but the bootstrap credentials aren't set", async () => {
    db = await openTestDb();
    await expect(bootstrapIfNeeded(db.pool, admin, baseConfig)).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
  });
});
