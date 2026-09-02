import { Router } from "express";
import type { Pool } from "pg";
import { verifyLogin } from "./users.js";
import { createSession, deleteSession, readSessionCookie, requireSession, SESSION_COOKIE_NAME } from "./sessions.js";
import { createInvite, getInviteByToken, acceptInvite } from "./invites.js";
import { listTeamMembers, resetMemberPassword, removeMember } from "./team.js";

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function setSessionCookie(res: import("express").Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
}

function requireAdmin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function createUsersRouter(db: Pool): Router {
  const router = Router();
  const auth = requireSession(db);

  router.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (typeof email !== "string" || typeof password !== "string" || email === "" || password === "") {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const user = await verifyLogin(db, email, password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const session = await createSession(db, user.id);
    setSessionCookie(res, session.id);
    res.status(200).json(user);
  });

  // Deliberately not gated by `auth` — logging out with no session, or an already-expired one,
  // should just succeed as a no-op rather than 401ing on the way out.
  router.post("/api/auth/logout", async (req, res) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) await deleteSession(db, sessionId);
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(200).json({ ok: true });
  });

  router.get("/api/auth/me", auth, (req, res) => {
    res.json(req.user);
  });

  router.get("/api/invites/:token", async (req, res) => {
    const invite = await getInviteByToken(db, req.params.token);
    if (!invite || invite.accepted_at !== null || new Date(invite.expires_at).getTime() < Date.now()) {
      res.status(404).json({ error: "This invite link is invalid or has expired" });
      return;
    }
    res.json({ email: invite.email });
  });

  router.post("/api/invites/:token/accept", async (req, res) => {
    const { password } = req.body as { password?: unknown };
    if (typeof password !== "string") {
      res.status(400).json({ error: "password is required" });
      return;
    }
    try {
      const { user, sessionId } = await acceptInvite(db, req.params.token, password);
      setSessionCookie(res, sessionId);
      res.status(200).json(user);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/team/invites", auth, requireAdmin, async (req, res) => {
    const { email, role } = req.body as { email?: unknown; role?: unknown };
    if (typeof email !== "string" || email === "") {
      res.status(400).json({ error: "email is required and must be a non-empty string" });
      return;
    }
    if (role !== "admin" && role !== "member") {
      res.status(400).json({ error: "role must be 'admin' or 'member'" });
      return;
    }
    const invite = await createInvite(db, { organizationId: req.user!.organizationId, email, role, createdByUserId: req.user!.id });
    res.status(201).json(invite);
  });

  router.get("/api/team", auth, requireAdmin, async (req, res) => {
    res.json(await listTeamMembers(db, req.user!.organizationId));
  });

  // Both handlers below return a fixed, generic "Member not found" on any failure — never
  // (err as Error).message. resetMemberPassword/removeMember's only failure mode is the org-
  // boundary check in team.ts's getMemberInOrg, whose thrown message embeds the raw userId (e.g.
  // "No member with id abc123 in this organization"); relaying that verbatim to an HTTP response
  // would let an admin probe arbitrary user ids and learn, from the response alone, whether each
  // one exists anywhere on the platform (just in a different organization) — a cross-org user-id
  // existence oracle. The generic message carries the same 404 semantics without that leak.
  router.post("/api/team/:userId/reset-password", auth, requireAdmin, async (req, res) => {
    try {
      const result = await resetMemberPassword(db, req.user!.organizationId, req.params.userId);
      res.status(200).json(result);
    } catch {
      res.status(404).json({ error: "Member not found" });
    }
  });

  router.delete("/api/team/:userId", auth, requireAdmin, async (req, res) => {
    try {
      await removeMember(db, req.user!.organizationId, req.params.userId);
      res.status(204).send();
    } catch {
      res.status(404).json({ error: "Member not found" });
    }
  });

  return router;
}
