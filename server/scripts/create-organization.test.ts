import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { verifyLogin } from "../src/users/users.js";
import { createOrganizationWithAdmin } from "./create-organization.js";

describe("createOrganizationWithAdmin", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a new organization and its first admin, independent of any existing organization", async () => {
    db = await openTestDb();
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ('existing-org', 'Existing', $1)`, [new Date().toISOString()]);

    const result = await createOrganizationWithAdmin(db.pool, {
      organizationName: "New Customer Inc",
      adminEmail: "owner@newcustomer.com",
      adminPassword: "a-real-password",
    });

    const org = (await db.pool.query(`SELECT * FROM organizations WHERE id = $1`, [result.organizationId])).rows[0];
    expect(org.name).toBe("New Customer Inc");
    expect(org.id).not.toBe("existing-org");

    const user = await verifyLogin(db.pool, "owner@newcustomer.com", "a-real-password");
    expect(user).toMatchObject({ organizationId: result.organizationId, role: "admin" });

    const totalOrgs = (await db.pool.query(`SELECT COUNT(*)::int AS count FROM organizations`)).rows[0].count;
    expect(totalOrgs).toBe(2);
  });

  it("can be run more than once to create multiple additional organizations", async () => {
    db = await openTestDb();
    const first = await createOrganizationWithAdmin(db.pool, { organizationName: "First", adminEmail: "a@example.com", adminPassword: "password123" });
    const second = await createOrganizationWithAdmin(db.pool, { organizationName: "Second", adminEmail: "b@example.com", adminPassword: "password123" });
    expect(first.organizationId).not.toBe(second.organizationId);
  });
});
