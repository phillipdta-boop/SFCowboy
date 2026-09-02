import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import {
  hashPassword,
  verifyPassword,
  createUser,
  getUserByEmail,
  getUserById,
  verifyLogin,
  updateUserPassword,
  setUserDisabled,
} from "./users.js";

async function seedOrg(db: TestDb["pool"]): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [id, new Date().toISOString()]);
  return id;
}

describe("password hashing", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).not.toBe("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("users", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a user and fetches it by email and by id", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "Admin@Example.com",
      passwordHash: await hashPassword("password123"),
      role: "admin",
      name: "Ada Admin",
    });
    expect(created).toMatchObject({ organizationId: orgId, email: "admin@example.com", name: "Ada Admin", role: "admin" });

    const byEmail = await getUserByEmail(db.pool, "ADMIN@example.com");
    expect(byEmail?.id).toBe(created.id);

    const byId = await getUserById(db.pool, created.id);
    expect(byId?.email).toBe("admin@example.com");
  });

  it("lowercases email on creation and lookup, so case never creates duplicate accounts", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    await createUser(db.pool, {
      organizationId: orgId,
      email: "Person@Example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Percy",
    });
    await expect(
      createUser(db.pool, {
        organizationId: orgId,
        email: "person@example.com",
        passwordHash: await hashPassword("password123"),
        role: "member",
        name: "Duplicate",
      })
    ).rejects.toThrow();
  });

  it("verifyLogin succeeds with correct credentials and fails with wrong password or unknown email", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "member@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Mel Member",
    });

    const ok = await verifyLogin(db.pool, "member@example.com", "s3cret!!");
    expect(ok).toMatchObject({ id: created.id, organizationId: orgId, role: "member", name: "Mel Member" });

    expect(await verifyLogin(db.pool, "member@example.com", "wrong")).toBeUndefined();
    expect(await verifyLogin(db.pool, "nobody@example.com", "s3cret!!")).toBeUndefined();
  });

  it("verifyLogin refuses a disabled user even with the correct password", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "gone@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Gone",
    });
    await setUserDisabled(db.pool, created.id, true);
    expect(await verifyLogin(db.pool, "gone@example.com", "s3cret!!")).toBeUndefined();
  });

  it("verifyLogin updates last_login_at on success", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "time@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Time",
    });
    expect((await getUserById(db.pool, created.id))?.last_login_at).toBeNull();
    await verifyLogin(db.pool, "time@example.com", "s3cret!!");
    expect((await getUserById(db.pool, created.id))?.last_login_at).not.toBeNull();
  });

  it("updateUserPassword replaces the hash so the old password no longer verifies", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "reset@example.com",
      passwordHash: await hashPassword("old-password"),
      role: "member",
      name: "Reset Me",
    });
    await updateUserPassword(db.pool, created.id, await hashPassword("new-password"));
    expect(await verifyLogin(db.pool, "reset@example.com", "old-password")).toBeUndefined();
    expect(await verifyLogin(db.pool, "reset@example.com", "new-password")).toMatchObject({ id: created.id });
  });

  it("setUserDisabled(false) re-enables a previously disabled user", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "back@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Back",
    });
    await setUserDisabled(db.pool, created.id, true);
    await setUserDisabled(db.pool, created.id, false);
    expect(await verifyLogin(db.pool, "back@example.com", "s3cret!!")).toMatchObject({ id: created.id });
  });
});
