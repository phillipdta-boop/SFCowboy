// Must be imported before any router is created (matches server/src/app.ts's own real ordering)
// so a rejected promise from an async route handler reaches this test's terminal error handler
// below via next(err), instead of hanging as an unhandled rejection until Vitest's testTimeout --
// this codebase's real app.ts has always needed this; this test harness didn't have it, and a
// real (if environmental -- see the email-rate-limit note in this file's other tests) route
// failure surfaced exactly that hang during Task 15's full-suite verification.
import "express-async-errors";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { AuthApiError } from "@supabase/supabase-js";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig } from "../config.js";
import { createUsersRouter } from "./routes.js";
import * as team from "./team.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("users router", () => {
  let db: TestDb;
  const config = loadConfig();
  const admin = createSupabaseAdminClient(config);
  const createdUserIds: string[] = [];
  // organizations lives only in the shared "public" schema (see Task 2's opening note), so every
  // org this file creates must be explicitly deleted here or it leaks into the real sfcowboy-dev
  // project forever.
  const createdOrgIds: string[] = [];
  // deployments.organization_id has no ON DELETE CASCADE, so any deployment row created against
  // a test org must be deleted before that org, or the org's own DELETE below fails on the FK.
  const createdDeploymentIds: string[] = [];

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
    for (const id of createdDeploymentIds.splice(0)) {
      await db.pool.query(`DELETE FROM deployments WHERE id = $1`, [id]).catch(() => {});
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await db.stop();
  });

  async function seedOrgAndAdmin(organizationId: string, role: "admin" | "member" = "admin") {
    createdOrgIds.push(organizationId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      organizationId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `admin-test-${randomUUID()}@example.com`;
    const password = "a-good-test-password-1";
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { organization_id: organizationId, role },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    const { data: sessionData } = await admin.auth.signInWithPassword({ email, password });
    return { token: sessionData.session!.access_token, userId: data.user!.id };
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(createUsersRouter(db.pool, config));
    // Matches app.ts's real terminal error handler -- without this, a rejected promise inside a
    // route handler (e.g. a genuine Supabase API failure, not just a 4xx the route itself
    // returns) hangs as an unhandled rejection until Vitest's testTimeout instead of producing a
    // fast, clean 500 the test can observe and fail on immediately.
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (res.headersSent) return;
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal server error" });
    });
    return app;
  }

  it("GET /api/me/usage requires authentication", async () => {
    const res = await request(buildApp()).get("/api/me/usage");
    expect(res.status).toBe(401);
  });

  it("GET /api/me/usage groups a user's own deployments by status, split into this month and all time", async () => {
    const orgId = randomUUID();
    const { token, userId } = await seedOrgAndAdmin(orgId);
    const app = buildApp();

    async function insertDeployment(status: string, startedAt: string) {
      const id = randomUUID();
      createdDeploymentIds.push(id);
      await db.pool.query(
        `INSERT INTO deployments (id, organization_id, target_connection_id, component_list, test_level, status, started_at, run_by_user_id)
         VALUES ($1, $2, 'conn-1', '[]', 'NoTestRun', $3, $4, $5)`,
        [id, orgId, status, startedAt, userId]
      );
    }

    const now = new Date();
    const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15)).toISOString();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();

    await insertDeployment("succeeded", thisMonth);
    await insertDeployment("succeeded", lastMonth);
    await insertDeployment("failed", lastMonth);

    const res = await request(app).get("/api/me/usage").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.thisMonth).toMatchObject({ succeeded: 1, failed: 0 });
    expect(res.body.allTime).toMatchObject({ succeeded: 2, failed: 1 });
  });

  it("GET /api/team requires authentication", async () => {
    const res = await request(buildApp()).get("/api/team");
    expect(res.status).toBe(401);
  });

  it("an admin lists the team, invites a member, and removes them", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();

    const listRes = await request(app).get("/api/team").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const inviteEmail = `invitee-${randomUUID()}@example.com`;
    const inviteRes = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: inviteEmail, role: "member" });
    expect(inviteRes.status).toBe(200);

    const { data } = await admin.auth.admin.listUsers();
    const invited = data.users.find((u) => u.email === inviteEmail)!;
    createdUserIds.push(invited.id);

    const removeRes = await request(app).delete(`/api/team/${invited.id}`).set("Authorization", `Bearer ${token}`);
    expect(removeRes.status).toBe(204);
  });

  it("a removed member's still-valid JWT is rejected on their next authenticated request", async () => {
    // requireSupabaseUser's disabled_at check is what actually enforces removal -- the JWT itself
    // stays cryptographically valid until it expires, so this proves the DB-level disabled_at flip
    // really is the enforcement point (the spec's own framing), not just that the row got updated.
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { token: memberToken, userId: memberId } = await seedOrgAndAdmin(orgId, "member");
    const app = buildApp();

    const removeRes = await request(app).delete(`/api/team/${memberId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(removeRes.status).toBe(204);

    const res = await request(app).get("/api/team").set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects a valid JWT for a user with no app_users row (never invited/bootstrapped)", async () => {
    // Same "metadata-less user" pattern as supabase.test.ts's own verifySupabaseJwt test: a real
    // Supabase user with a cryptographically valid token, but no organization_id/role app_metadata
    // and therefore no matching app_users row (Task 2's trigger only creates one when app_metadata
    // is present). Proves requireSupabaseUser rejects this case instead of silently proceeding
    // with an undefined role/org.
    const email = `no-app-user-row-${randomUUID()}@example.com`;
    const password = "a-good-test-password-1";
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    const { data: sessionData } = await admin.auth.signInWithPassword({ email, password });

    const res = await request(buildApp()).get("/api/team").set("Authorization", `Bearer ${sessionData.session!.access_token}`);
    expect(res.status).toBe(401);
  });

  it("maps a rate-limit AuthApiError from createInvite to 429 with a clear message", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();
    const createInviteSpy = vi.spyOn(team, "createInvite").mockRejectedValue(new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"));

    const res = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: "someone@example.invalid", role: "member" });

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Email rate limit exceeded — try again later" });
    createInviteSpy.mockRestore();
  });

  it("maps an email_exists AuthApiError from createInvite to 409 with a clear message", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();
    const createInviteSpy = vi
      .spyOn(team, "createInvite")
      .mockRejectedValue(new AuthApiError("A user with this email address has already been registered", 422, "email_exists"));

    const res = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: "someone@example.invalid", role: "member" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "A user with this email already exists" });
    createInviteSpy.mockRestore();
  });

  it("maps an email_address_invalid AuthApiError from createInvite to 400 with a clear message", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();
    const createInviteSpy = vi
      .spyOn(team, "createInvite")
      .mockRejectedValue(new AuthApiError("Unable to validate email address: invalid format", 400, "email_address_invalid"));

    const res = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: "not-an-email", role: "member" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid email address" });
    createInviteSpy.mockRestore();
  });

  it("lets an unrecognized error from createInvite propagate to the generic 500 handler instead of swallowing it", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();
    const createInviteSpy = vi.spyOn(team, "createInvite").mockRejectedValue(new Error("something unrelated broke"));

    const res = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: "someone@example.invalid", role: "member" });

    expect(res.status).toBe(500);
    createInviteSpy.mockRestore();
  });

  it("maps a rate-limit AuthApiError from sendPasswordReset to 429 with a clear message", async () => {
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { userId: memberId } = await seedOrgAndAdmin(orgId, "member");
    const app = buildApp();
    const resetSpy = vi.spyOn(team, "sendPasswordReset").mockRejectedValue(new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"));

    const res = await request(app).post(`/api/team/${memberId}/reset-password`).set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Email rate limit exceeded — try again later" });
    resetSpy.mockRestore();
  });

  it("returns 404 for a reset-password request targeting an already-removed member, without leaking their existence via a different error", async () => {
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { userId: memberId } = await seedOrgAndAdmin(orgId, "member");
    const app = buildApp();

    const removeRes = await request(app).delete(`/api/team/${memberId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(removeRes.status).toBe(204);

    const res = await request(app).post(`/api/team/${memberId}/reset-password`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member not found" });
  });

  it("returns a generic 404 for a cross-org target instead of leaking the id-embedding error", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const { token } = await seedOrgAndAdmin(orgA);
    const { userId: userInOrgB } = await seedOrgAndAdmin(orgB);
    const app = buildApp();

    const res = await request(app).delete(`/api/team/${userInOrgB}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member not found" });
  });

  it("PATCH /api/team/:userId/role promotes a member to admin", async () => {
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { userId: memberId } = await seedOrgAndAdmin(orgId, "member");
    const app = buildApp();

    const res = await request(app).patch(`/api/team/${memberId}/role`).set("Authorization", `Bearer ${adminToken}`).send({ role: "admin" });
    expect(res.status).toBe(200);

    const { data } = await admin.auth.admin.getUserById(memberId);
    expect(data.user!.app_metadata.role).toBe("admin");

    const row = await db.pool.query(`SELECT role FROM app_users WHERE id = $1`, [memberId]);
    expect(row.rows[0].role).toBe("admin");
  });

  it("PATCH /api/team/:userId/role refuses to demote the organization's last remaining admin", async () => {
    const orgId = randomUUID();
    const { token: adminToken, userId: adminId } = await seedOrgAndAdmin(orgId, "admin");
    const app = buildApp();

    const res = await request(app).patch(`/api/team/${adminId}/role`).set("Authorization", `Bearer ${adminToken}`).send({ role: "member" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last remaining admin/i);

    const row = await db.pool.query(`SELECT role FROM app_users WHERE id = $1`, [adminId]);
    expect(row.rows[0].role).toBe("admin");
  });

  it("PATCH /api/team/:userId/role allows demoting an admin when another admin remains", async () => {
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { userId: secondAdminId } = await seedOrgAndAdmin(orgId, "admin");
    const app = buildApp();

    const res = await request(app).patch(`/api/team/${secondAdminId}/role`).set("Authorization", `Bearer ${adminToken}`).send({ role: "member" });
    expect(res.status).toBe(200);

    const row = await db.pool.query(`SELECT role FROM app_users WHERE id = $1`, [secondAdminId]);
    expect(row.rows[0].role).toBe("member");
  });

  it("PATCH /api/team/:userId/role rejects an invalid role", async () => {
    const orgId = randomUUID();
    const { token: adminToken } = await seedOrgAndAdmin(orgId, "admin");
    const { userId: memberId } = await seedOrgAndAdmin(orgId, "member");
    const app = buildApp();

    const res = await request(app).patch(`/api/team/${memberId}/role`).set("Authorization", `Bearer ${adminToken}`).send({ role: "owner" });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/team/:userId/role returns a generic 404 for a cross-org target", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const { token } = await seedOrgAndAdmin(orgA);
    const { userId: userInOrgB } = await seedOrgAndAdmin(orgB);
    const app = buildApp();

    const res = await request(app).patch(`/api/team/${userInOrgB}/role`).set("Authorization", `Bearer ${token}`).send({ role: "admin" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member not found" });
  });

  it("PATCH /api/team/:userId/role requires authentication", async () => {
    const res = await request(buildApp()).patch("/api/team/someone/role").send({ role: "admin" });
    expect(res.status).toBe(401);
  });

  it("a non-admin gets 403 from an admin-only route", async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      orgId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `member-test-${randomUUID()}@example.com`;
    const password = "a-good-test-password-1";
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { organization_id: orgId, role: "member" },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    const { data: sessionData } = await admin.auth.signInWithPassword({ email, password });

    const res = await request(buildApp()).get("/api/team").set("Authorization", `Bearer ${sessionData.session!.access_token}`);
    expect(res.status).toBe(403);
  });
});
