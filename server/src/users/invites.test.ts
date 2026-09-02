import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser, verifyLogin } from "./users.js";
import { createInvite, getInviteByToken, acceptInvite } from "./invites.js";

async function seedOrgAndAdmin(db: TestDb["pool"]): Promise<{ orgId: string; adminId: string }> {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [orgId, new Date().toISOString()]);
  const admin = await createUser(db, {
    organizationId: orgId,
    email: "admin@example.com",
    passwordHash: await hashPassword("password123"),
    role: "admin",
    name: "Admin",
  });
  return { orgId, adminId: admin.id };
}

describe("invites", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates an invite with a future expiry and a unique token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "new@example.com", role: "member", createdByUserId: adminId });
    expect(invite.token).toBeTruthy();
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await getInviteByToken(db.pool, invite.token);
    expect(row).toMatchObject({ organization_id: orgId, email: "new@example.com", role: "member", created_by: adminId, accepted_at: null });
  });

  it("getInviteByToken returns undefined for an unknown token", async () => {
    db = await openTestDb();
    expect(await getInviteByToken(db.pool, "not-a-real-token")).toBeUndefined();
  });

  it("acceptInvite creates a user scoped to the invite's organization and role, and logs them in", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "newmember@example.com", role: "member", createdByUserId: adminId });

    const { user, sessionId } = await acceptInvite(db.pool, invite.token, "a-good-password");
    expect(user).toMatchObject({ organizationId: orgId, email: "newmember@example.com", role: "member" });
    expect(sessionId).toBeTruthy();

    const sessionRow = (await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [sessionId])).rows[0];
    expect(sessionRow.user_id).toBe(user.id);

    expect(await verifyLogin(db.pool, "newmember@example.com", "a-good-password")).toMatchObject({ id: user.id });

    const acceptedInvite = await getInviteByToken(db.pool, invite.token);
    expect(acceptedInvite?.accepted_at).not.toBeNull();
  });

  it("acceptInvite rejects an already-accepted token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "once@example.com", role: "member", createdByUserId: adminId });
    await acceptInvite(db.pool, invite.token, "password-one");
    await expect(acceptInvite(db.pool, invite.token, "password-two")).rejects.toThrow(/already been accepted/i);
  });

  it("acceptInvite rejects an expired token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "expired@example.com", role: "member", createdByUserId: adminId });
    await db.pool.query(`UPDATE invites SET expires_at = $1 WHERE token = $2`, ["2000-01-01T00:00:00.000Z", invite.token]);
    await expect(acceptInvite(db.pool, invite.token, "password")).rejects.toThrow(/expired/i);
  });

  it("acceptInvite rejects an unknown token", async () => {
    db = await openTestDb();
    await expect(acceptInvite(db.pool, "not-a-real-token", "password")).rejects.toThrow(/no invite/i);
  });

  it("acceptInvite rejects a password shorter than 8 characters", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "short@example.com", role: "member", createdByUserId: adminId });
    await expect(acceptInvite(db.pool, invite.token, "short")).rejects.toThrow(/at least 8 characters/i);
  });

  it("acceptInvite closes the TOCTOU race when the same token is accepted concurrently", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "racer@example.com", role: "member", createdByUserId: adminId });

    const [resultA, resultB] = await Promise.allSettled([
      acceptInvite(db.pool, invite.token, "password-one"),
      acceptInvite(db.pool, invite.token, "password-two"),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((r) => r.status === "fulfilled");
    const rejected = outcomes.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/already been accepted/i);

    const userRows = (await db.pool.query(`SELECT * FROM users WHERE email = $1`, ["racer@example.com"])).rows;
    expect(userRows).toHaveLength(1);
  });
});
