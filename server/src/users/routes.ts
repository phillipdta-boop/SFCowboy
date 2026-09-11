import { Router } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { requireSupabaseUser } from "./requireSupabaseUser.js";
import { listTeamMembers, createInvite, sendPasswordReset, removeMember } from "./team.js";

function requireAdmin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function createUsersRouter(db: Pool, config: Config): Router {
  const router = Router();
  const admin = createSupabaseAdminClient(config);
  const auth = requireSupabaseUser(db, config);

  router.get("/api/team", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    res.json(members);
  });

  router.post("/api/team/invites", auth, requireAdmin, async (req, res) => {
    const { email, role } = req.body as { email?: unknown; role?: unknown };
    if (typeof email !== "string" || email === "" || (role !== "admin" && role !== "member")) {
      res.status(400).json({ error: "email and role ('admin' or 'member') are required" });
      return;
    }
    await createInvite(admin, req.user!.organizationId, email, role);
    res.status(200).json({ ok: true });
  });

  router.post("/api/team/:userId/reset-password", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    const target = members.find((m) => m.id === req.params.userId);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    await sendPasswordReset(admin, target.email);
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
