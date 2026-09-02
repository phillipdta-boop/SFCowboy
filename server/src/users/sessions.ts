import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getUserById } from "./users.js";
import type { AuthenticatedUser } from "./users.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export const SESSION_COOKIE_NAME = "sfcowboy_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(db: Pool, userId: string): Promise<{ id: string; expiresAt: string }> {
  const id = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString();
  await db.query(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [
    id,
    userId,
    createdAt.toISOString(),
    expiresAt,
  ]);
  return { id, expiresAt };
}

export async function deleteSession(db: Pool, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

/** Used when an admin removes a member or resets their password — every existing session for
 * that user stops working on its very next request, which is the whole reason this project chose
 * server-side sessions over JWTs (see the design spec). */
export async function deleteSessionsForUser(db: Pool, userId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

/**
 * Reads the session cookie directly off the raw `Cookie` request header rather than depending on
 * `cookie-parser` having already run — this keeps the middleware fully self-contained and testable
 * in isolation (see sessions.test.ts, which mounts only this middleware with no other setup).
 * `cookie-parser` is still used elsewhere (app.ts) for setting/clearing the cookie with the right
 * flags, which needs its `res.cookie()`/`res.clearCookie()` helpers.
 */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        // Malformed percent-encoding in the cookie value (e.g. a stray "%" not followed by two
        // hex digits) — treat exactly like no session cookie at all rather than letting the
        // URIError propagate and crash the request. Reachable by any anonymous client with no
        // knowledge beyond the (public) cookie name, so this must fail closed, not throw.
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Express middleware: resolves the session cookie into `req.user`, or responds 401 if there is no
 * valid, unexpired session for a non-disabled user. This is the single choke point every protected
 * route in this app relies on — no route independently re-checks auth (see the design spec).
 */
export function requireSession(db: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sessionId = readSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const sessionRow = (await db.query(`SELECT * FROM sessions WHERE id = $1`, [sessionId])).rows[0];
    if (!sessionRow || new Date(sessionRow.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const userRow = await getUserById(db, sessionRow.user_id);
    if (!userRow || userRow.disabled_at !== null) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.user = { id: userRow.id, organizationId: userRow.organization_id, email: userRow.email, name: userRow.name, role: userRow.role };
    next();
  };
}
