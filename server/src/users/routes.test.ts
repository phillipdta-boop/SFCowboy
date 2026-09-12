// Must be imported before any router is created (matches server/src/app.ts's own real ordering)
// so a rejected promise from an async route handler reaches this test's terminal error handler
// below via next(err), instead of hanging as an unhandled rejection until Vitest's testTimeout --
// this codebase's real app.ts has always needed this; this test harness didn't have it, and a
// real (if environmental -- see the email-rate-limit note in this file's other tests) route
// failure surfaced exactly that hang during Task 15's full-suite verification.
import "express-async-errors";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig } from "../config.js";
import { createUsersRouter } from "./routes.js";

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

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await db.stop();
  });

  async function seedOrgAndAdmin(organizationId: string) {
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
      app_metadata: { organization_id: organizationId, role: "admin" },
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
