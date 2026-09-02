import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser, verifyLogin, getUserById } from "./users.js";
import { createSession } from "./sessions.js";
import { listTeamMembers, resetMemberPassword, removeMember } from "./team.js";

async function seedOrg(db: TestDb["pool"], name = "Acme"): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [id, name, new Date().toISOString()]);
  return id;
}

describe("team management", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("lists only the members of the given organization, not another org's", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    await createUser(db.pool, { organizationId: orgA, email: "a1@example.com", passwordHash: "x", role: "admin", name: "A1" });
    await createUser(db.pool, { organizationId: orgA, email: "a2@example.com", passwordHash: "x", role: "member", name: "A2" });
    await createUser(db.pool, { organizationId: orgB, email: "b1@example.com", passwordHash: "x", role: "admin", name: "B1" });

    const members = await listTeamMembers(db.pool, orgA);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.email).sort()).toEqual(["a1@example.com", "a2@example.com"]);
  });

  it("resetMemberPassword sets a new working password and invalidates existing sessions", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const user = await createUser(db.pool, {
      organizationId: orgId,
      email: "reset@example.com",
      passwordHash: await hashPassword("old-password"),
      role: "member",
      name: "Reset Me",
    });
    const session = await createSession(db.pool, user.id);

    const { temporaryPassword } = await resetMemberPassword(db.pool, orgId, user.id);
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(8);

    expect(await verifyLogin(db.pool, "reset@example.com", "old-password")).toBeUndefined();
    expect(await verifyLogin(db.pool, "reset@example.com", temporaryPassword)).toMatchObject({ id: user.id });

    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
  });

  it("resetMemberPassword refuses to reset a user outside the given organization", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    const outsider = await createUser(db.pool, { organizationId: orgB, email: "outsider@example.com", passwordHash: "x", role: "member", name: "Outsider" });
    await expect(resetMemberPassword(db.pool, orgA, outsider.id)).rejects.toThrow(/no member/i);
  });

  it("removeMember disables the user and invalidates their sessions, without deleting the row", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const user = await createUser(db.pool, {
      organizationId: orgId,
      email: "bye@example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Bye",
    });
    const session = await createSession(db.pool, user.id);

    await removeMember(db.pool, orgId, user.id);

    expect(await verifyLogin(db.pool, "bye@example.com", "password123")).toBeUndefined();
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
    expect(await getUserById(db.pool, user.id)).toBeDefined();
  });

  it("removeMember refuses to remove a user outside the given organization", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    const outsider = await createUser(db.pool, { organizationId: orgB, email: "outsider2@example.com", passwordHash: "x", role: "member", name: "Outsider" });
    await expect(removeMember(db.pool, orgA, outsider.id)).rejects.toThrow(/no member/i);
    expect(await verifyLogin(db.pool, "outsider2@example.com", "x")).toBeUndefined(); // unaffected either way (wrong password), but the row must still exist:
    expect(await getUserById(db.pool, outsider.id)).toBeDefined();
  });
});
