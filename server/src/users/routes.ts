import { Router } from "express";
import type { Pool } from "pg";
import { isAuthApiError } from "@supabase/supabase-js";
import type { Config } from "../config.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { requireSupabaseUser } from "./requireSupabaseUser.js";
import { listTeamMembers, createInvite, sendPasswordReset, removeMember } from "./team.js";
import { getUsageSummary } from "./usage.js";

function requireAdmin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

/**
 * Maps a Supabase AuthApiError raised by createInvite/sendPasswordReset to a status/message an
 * admin can actually act on -- without this, every one of these (a hit rate limit, an
 * already-registered address, a malformed address) fell through to app.ts's generic terminal
 * error handler and surfaced as an opaque "Internal server error", unlike Login.tsx's own
 * client-side error path, which shows the real message. Returns null for any error this function
 * doesn't recognize, so the caller lets it propagate to the generic 500 handler unchanged rather
 * than this function ever swallowing an error it doesn't understand.
 */
function mapAuthApiError(error: unknown): { status: number; message: string } | null {
  if (!isAuthApiError(error)) return null;
  if (error.status === 429 || error.code === "over_email_send_rate_limit") {
    return { status: 429, message: "Email rate limit exceeded — try again later" };
  }
  if (error.code === "email_exists") {
    return { status: 409, message: "A user with this email already exists" };
  }
  if (error.code === "email_address_invalid") {
    return { status: 400, message: "Invalid email address" };
  }
  return null;
}

export function createUsersRouter(db: Pool, config: Config): Router {
  const router = Router();
  const admin = createSupabaseAdminClient(config);
  const auth = requireSupabaseUser(db, config);

  router.get("/api/me/usage", auth, async (req, res) => {
    res.json(await getUsageSummary(db, req.user!.id));
  });

  router.get("/api/team", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    res.json(members);
  });

  router.post("/api/team/invites", auth, requireAdmin, async (req, res) => {
    const { email, role, name } = req.body as { email?: unknown; role?: unknown; name?: unknown };
    if (typeof email !== "string" || email === "" || (role !== "admin" && role !== "member")) {
      res.status(400).json({ error: "email and role ('admin' or 'member') are required" });
      return;
    }
    if (name !== undefined && typeof name !== "string") {
      res.status(400).json({ error: "name must be a string when provided" });
      return;
    }
    try {
      await createInvite(admin, config.appBaseUrl, req.user!.organizationId, email, role, name);
    } catch (error) {
      const mapped = mapAuthApiError(error);
      if (!mapped) throw error;
      res.status(mapped.status).json({ error: mapped.message });
      return;
    }
    res.status(200).json({ ok: true });
  });

  router.post("/api/team/:userId/reset-password", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    const target = members.find((m) => m.id === req.params.userId);
    if (!target || target.disabledAt !== null) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    try {
      await sendPasswordReset(admin, config.appBaseUrl, target.email);
    } catch (error) {
      const mapped = mapAuthApiError(error);
      if (!mapped) throw error;
      res.status(mapped.status).json({ error: mapped.message });
      return;
    }
    res.status(200).json({ ok: true });
  });

  router.delete("/api/team/:userId", auth, requireAdmin, async (req, res) => {
    try {
      await removeMember(db, req.user!.organizationId, req.params.userId);
    } catch {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
