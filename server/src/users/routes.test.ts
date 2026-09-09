import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser } from "./users.js";
import { createSession, SESSION_COOKIE_NAME } from "./sessions.js";
import { createUsersRouter } from "./routes.js";

async function seedOrgAndAdmin(
  db: TestDb["pool"],
  overrides: { orgName?: string; adminEmail?: string } = {}
): Promise<{ orgId: string; adminId: string }> {
  const orgId = randomUUID();
  const orgName = overrides.orgName ?? "Acme";
  const adminEmail = overrides.adminEmail ?? "admin@example.com";
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, orgName, new Date().toISOString()]);
  const admin = await createUser(db, {
    organizationId: orgId,
    email: adminEmail,
    passwordHash: await hashPassword("password123"),
    role: "admin",
    name: "Admin",
  });
  return { orgId, adminId: admin.id };
}

function buildApp(db: TestDb["pool"]) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createUsersRouter(db));
  return app;
}

function sessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  const match = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) throw new Error("no session cookie set");
  return match.split(";")[0];
}

describe("users routes", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  describe("POST /api/auth/login", () => {
    it("logs in with correct credentials and sets a session cookie", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);

      const res = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      expect(res.status).toBe(200);
      expect(sessionCookie(res)).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    });

    it("returns a generic error for a wrong password without revealing the email is valid", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "wrong" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid email or password/i);
    });

    it("returns the same generic error for an unknown email", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever1" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid email or password/i);
    });
  });

  describe("GET /api/auth/me and POST /api/auth/logout", () => {
    it("returns the current user when logged in, 401 when not", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);

      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const cookie = sessionCookie(loginRes);

      const meRes = await request(app).get("/api/auth/me").set("Cookie", [cookie]);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toMatchObject({ email: "admin@example.com", role: "admin", organizationId: orgId });

      const anonRes = await request(app).get("/api/auth/me");
      expect(anonRes.status).toBe(401);
    });

    it("logout invalidates the session so /me then returns 401", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const cookie = sessionCookie(loginRes);

      await request(app).post("/api/auth/logout").set("Cookie", [cookie]);
      const meRes = await request(app).get("/api/auth/me").set("Cookie", [cookie]);
      expect(meRes.status).toBe(401);
    });

    it("logout with no session at all still succeeds (idempotent no-op)", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/logout");
      expect(res.status).toBe(200);
    });

    it("logout with a malformed (undecodable) cookie value still succeeds instead of crashing", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/logout").set("Cookie", [`${SESSION_COOKIE_NAME}=%1`]);
      expect(res.status).toBe(200);
    });
  });

  describe("invite endpoints", () => {
    it("an admin creates an invite, a public GET reveals just enough to render, and accepting logs the invitee in", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const adminCookie = sessionCookie(loginRes);

      const createRes = await request(app)
        .post("/api/team/invites")
        .set("Cookie", [adminCookie])
        .send({ email: "newbie@example.com", role: "member" });
      expect(createRes.status).toBe(201);
      const token: string = createRes.body.token;
      expect(token).toBeTruthy();

      const infoRes = await request(app).get(`/api/invites/${token}`);
      expect(infoRes.status).toBe(200);
      expect(infoRes.body).toMatchObject({ email: "newbie@example.com" });

      const acceptRes = await request(app).post(`/api/invites/${token}/accept`).send({ password: "a-real-password" });
      expect(acceptRes.status).toBe(200);
      expect(sessionCookie(acceptRes)).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    });

    it("a non-admin cannot create an invite", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      await createUser(db.pool, { organizationId: orgId, email: "member@example.com", passwordHash: await hashPassword("password123"), role: "member", name: "Member" });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "member@example.com", password: "password123" });
      const memberCookie = sessionCookie(loginRes);

      const res = await request(app).post("/api/team/invites").set("Cookie", [memberCookie]).send({ email: "x@example.com", role: "member" });
      expect(res.status).toBe(403);
    });

    it("GET /api/invites/:token returns 404 for an unknown token", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/api/invites/not-a-real-token");
      expect(res.status).toBe(404);
    });
  });

  describe("team endpoints", () => {
    it("an admin lists the team, resets a member's password, and removes a member", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      const member = await createUser(db.pool, {
        organizationId: orgId,
        email: "member2@example.com",
        passwordHash: await hashPassword("password123"),
        role: "member",
        name: "Member Two",
      });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const adminCookie = sessionCookie(loginRes);

      const listRes = await request(app).get("/api/team").set("Cookie", [adminCookie]);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(2);

      const resetRes = await request(app).post(`/api/team/${member.id}/reset-password`).set("Cookie", [adminCookie]);
      expect(resetRes.status).toBe(200);
      expect(resetRes.body.temporaryPassword).toBeTruthy();

      const removeRes = await request(app).delete(`/api/team/${member.id}`).set("Cookie", [adminCookie]);
      expect(removeRes.status).toBe(204);

      const listAfter = await request(app).get("/api/team").set("Cookie", [adminCookie]);
      expect(listAfter.body.find((m: { id: string }) => m.id === member.id).disabledAt).not.toBeNull();
    });

    it("an admin from one organization gets the generic 404, not an id-embedding message, when targeting a real user in a different organization", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool, { orgName: "Acme", adminEmail: "admin-a@example.com" });
      const { orgId: orgBId } = await seedOrgAndAdmin(db.pool, { orgName: "Globex", adminEmail: "admin-b@example.com" });
      const orgBMember = await createUser(db.pool, {
        organizationId: orgBId,
        email: "member-b@example.com",
        passwordHash: await hashPassword("password123"),
        role: "member",
        name: "Member B",
      });
      const app = buildApp(db.pool);

      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin-a@example.com", password: "password123" });
      const adminACookie = sessionCookie(loginRes);

      const resetRes = await request(app).post(`/api/team/${orgBMember.id}/reset-password`).set("Cookie", [adminACookie]);
      expect(resetRes.status).toBe(404);
      expect(resetRes.body).toEqual({ error: "Member not found" });
      expect(JSON.stringify(resetRes.body)).not.toContain(orgBMember.id);
    });

    it("a non-admin gets 403 from every team endpoint", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      await createUser(db.pool, { organizationId: orgId, email: "plain@example.com", passwordHash: await hashPassword("password123"), role: "member", name: "Plain" });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "plain@example.com", password: "password123" });
      const memberCookie = sessionCookie(loginRes);

      expect((await request(app).get("/api/team").set("Cookie", [memberCookie])).status).toBe(403);
      expect((await request(app).post("/api/team/some-id/reset-password").set("Cookie", [memberCookie])).status).toBe(403);
      expect((await request(app).delete("/api/team/some-id").set("Cookie", [memberCookie])).status).toBe(403);
    });
  });
});
