import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser } from "./users.js";
import { SESSION_COOKIE_NAME, createSession, deleteSession, deleteSessionsForUser, requireSession } from "./sessions.js";

async function seedOrgAndUser(db: TestDb["pool"]): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [orgId, new Date().toISOString()]);
  const user = await createUser(db, {
    organizationId: orgId,
    email: "user@example.com",
    passwordHash: await hashPassword("password123"),
    role: "member",
    name: "User",
  });
  return { orgId, userId: user.id };
}

describe("sessions", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a session row with a 30-day expiry", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const before = Date.now();
    const session = await createSession(db.pool, userId);
    const row = (await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows[0];
    expect(row.user_id).toBe(userId);
    const expiresAt = new Date(row.expires_at).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + thirtyDaysMs - 5000);
    expect(expiresAt).toBeLessThan(before + thirtyDaysMs + 5000);
  });

  it("deleteSession removes exactly that session", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const session = await createSession(db.pool, userId);
    await deleteSession(db.pool, session.id);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
  });

  it("deleteSessionsForUser removes every session for that user, not other users'", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const orgId2 = randomUUID();
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Other', $2)`, [orgId2, new Date().toISOString()]);
    const otherUser = await createUser(db.pool, {
      organizationId: orgId2,
      email: "other@example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Other",
    });

    await createSession(db.pool, userId);
    await createSession(db.pool, userId);
    const otherSession = await createSession(db.pool, otherUser.id);

    await deleteSessionsForUser(db.pool, userId);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE user_id = $1`, [userId])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [otherSession.id])).rows).toHaveLength(1);
  });

  describe("requireSession middleware", () => {
    function buildApp(db: TestDb["pool"]) {
      const app = express();
      app.use(requireSession(db));
      app.get("/protected", (req, res) => {
        res.json({ user: req.user });
      });
      return app;
    }

    it("rejects a request with no cookie", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
    });

    it("rejects a request with an unknown session id", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=not-a-real-session`]);
      expect(res.status).toBe(401);
    });

    it("attaches req.user and succeeds for a valid session", async () => {
      db = await openTestDb();
      const { userId, orgId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: userId, organizationId: orgId, role: "member", name: "User" });
    });

    it("rejects an expired session", async () => {
      db = await openTestDb();
      const { userId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      await db.pool.query(`UPDATE sessions SET expires_at = $1 WHERE id = $2`, ["2000-01-01T00:00:00.000Z", session.id]);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(401);
    });

    it("rejects a session whose user was disabled after the session was created", async () => {
      db = await openTestDb();
      const { userId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      await db.pool.query(`UPDATE users SET disabled_at = $1 WHERE id = $2`, [new Date().toISOString(), userId]);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(401);
    });

    it("rejects a request with a malformed (undecodable) cookie value instead of crashing", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=%1`]);
      expect(res.status).toBe(401);
    });
  });
});
