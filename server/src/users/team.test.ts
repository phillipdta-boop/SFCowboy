import "dotenv/config";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig } from "../config.js";
import { listTeamMembers, createInvite, sendPasswordReset, removeMember } from "./team.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("team management", () => {
  let db: TestDb;
  const config = loadConfig();
  const admin = createSupabaseAdminClient(config);
  const createdUserIds: string[] = [];
  // organizations now lives only in the shared "public" schema (see Task 2's opening note) --
  // unlike the 5 pre-existing domain tables, it is NOT dropped when this test's own schema is
  // torn down, so every org this file creates must be explicitly deleted here or it leaks into
  // the real sfcowboy-dev project's organizations table forever.
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

  async function seedOrgAndMember(db: TestDb, organizationId: string, role: "admin" | "member" = "member") {
    createdOrgIds.push(organizationId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      organizationId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `team-test-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "a-good-test-password-1",
      email_confirm: true,
      app_metadata: { organization_id: organizationId, role },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    // The trigger fires inside Supabase's own Postgres project (the real db.pool connection IS
    // that project in this test file), so no manual app_users insert is needed here -- but give
    // it a moment: the trigger commits as part of the same transaction Supabase's own createUser
    // call runs, so it's visible immediately once createUser's promise resolves.
    return { id: data.user!.id, email };
  }

  it("lists only the members of the given organization, not another org's", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const memberA = await seedOrgAndMember(db, orgA);
    await seedOrgAndMember(db, orgB);

    const members = await listTeamMembers(db.pool, admin, orgA);
    expect(members).toHaveLength(1);
    expect(members[0].id).toBe(memberA.id);
    expect(members[0].email).toBe(memberA.email);
  });

  it("createInvite creates an auth user with the right organization/role metadata, and the trigger creates the matching app_users row", async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, "Test Org", new Date().toISOString()]);
    // Confirmed empirically (Task 4's implementation work) that GoTrue's real inviteUserByEmail
    // (unlike admin.createUser, used everywhere else in this plan's tests) hard-rejects
    // @example.com specifically with AuthApiError: email_address_invalid -- this is the one test
    // in the whole plan that actually calls the send-an-email path, so it's the only one that
    // hits this. `.invalid` (RFC 2606, reserved specifically for addresses guaranteed never to
    // resolve) passed GoTrue's validation in a direct probe against the real project.
    //
    // Note: Supabase Cloud's built-in email service (used by inviteUserByEmail) has a low
    // per-project rate limit intended for testing only -- Supabase's own docs recommend
    // configuring a custom SMTP provider before relying on it for real invite volume. This test
    // may occasionally fail with "email rate limit exceeded" under frequent re-runs (e.g. rapid
    // CI re-triggers) -- treat that as an accepted, environmental flakiness class, the same way
    // this plan already accepts real-network flakiness elsewhere, not a code defect to chase.
    const email = `invite-test-${randomUUID()}@example.invalid`;

    await createInvite(admin, config.appBaseUrl, orgId, email, "member");

    const { data: usersPage } = await admin.auth.admin.listUsers();
    const invited = usersPage.users.find((u) => u.email === email);
    expect(invited).toBeDefined();
    createdUserIds.push(invited!.id);

    const appUserRow = await db.pool.query(`SELECT organization_id, role FROM app_users WHERE id = $1`, [invited!.id]);
    expect(appUserRow.rows[0]).toEqual({ organization_id: orgId, role: "member" });
  });

  // Mocked rather than hitting the real project: the two email-sending admin calls
  // (inviteUserByEmail above, resetPasswordForEmail below) already share a real, low, per-project
  // rate limit (see the comment on the invite test above) -- these two tests only need to prove
  // the redirectTo argument is wired correctly, a pure call-argument check that doesn't need a
  // real email to actually be sent, so mocking avoids spending more of that already-scarce quota.
  it("createInvite passes redirectTo pointing at /accept-invite, so the invite link lands on the password-setup page instead of silently logging the invitee in", async () => {
    const fakeUserId = randomUUID();
    const inviteSpy = vi.spyOn(admin.auth.admin, "inviteUserByEmail").mockResolvedValue({ data: { user: { id: fakeUserId } }, error: null } as any);
    const updateSpy = vi.spyOn(admin.auth.admin, "updateUserById").mockResolvedValue({ data: { user: {} }, error: null } as any);

    await createInvite(admin, "https://example-app.invalid", randomUUID(), "someone@example.invalid", "member");

    expect(inviteSpy).toHaveBeenCalledWith("someone@example.invalid", expect.objectContaining({ redirectTo: "https://example-app.invalid/accept-invite" }));

    inviteSpy.mockRestore();
    updateSpy.mockRestore();
  });

  it("sendPasswordReset passes redirectTo pointing at /reset-password, so the reset link lands on the set-new-password page instead of silently logging the teammate in on their old password", async () => {
    const spy = vi.spyOn(admin.auth, "resetPasswordForEmail").mockResolvedValue({ data: {}, error: null } as any);

    await sendPasswordReset(admin, "https://example-app.invalid", "someone@example.invalid");

    expect(spy).toHaveBeenCalledWith("someone@example.invalid", { redirectTo: "https://example-app.invalid/reset-password" });

    spy.mockRestore();
  });

  it("removeMember disables the app_users row without deleting it, and refuses to remove a user outside the given organization", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const memberA = await seedOrgAndMember(db, orgA);

    await removeMember(db.pool, orgA, memberA.id);
    const row = await db.pool.query(`SELECT disabled_at FROM app_users WHERE id = $1`, [memberA.id]);
    expect(row.rows[0].disabled_at).not.toBeNull();

    await expect(removeMember(db.pool, orgB, memberA.id)).rejects.toThrow();
  });
});
