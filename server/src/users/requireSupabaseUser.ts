import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { verifySupabaseJwt } from "../supabase.js";

export interface AppUser {
  id: string;
  organizationId: string;
  role: "admin" | "member";
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

interface AppUserRow {
  id: string;
  organization_id: string;
  role: "admin" | "member";
  name: string;
  disabled_at: string | null;
}

function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/**
 * Resolves the Supabase-issued access token into req.user, or responds 401 if the token is
 * missing, invalid, or belongs to a user with no app_users row (never invited/bootstrapped, or
 * disabled). This is the choke point every route that needs a logged-in user relies on -- see
 * requireAdmin (Task 6) for the additional admin-only check layered on top.
 */
export function requireSupabaseUser(db: Pool, config: Config): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    let userId: string;
    try {
      const verified = await verifySupabaseJwt(config, token);
      userId = verified.userId;
    } catch {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const result = await db.query<AppUserRow>(`SELECT * FROM app_users WHERE id = $1`, [userId]);
    const row = result.rows[0];
    if (!row || row.disabled_at !== null) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.user = { id: row.id, organizationId: row.organization_id, role: row.role, name: row.name };
    next();
  };
}
