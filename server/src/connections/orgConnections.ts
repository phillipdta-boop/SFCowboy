import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { refreshAccessToken } from "../auth/oauth.js";
import type { Config } from "../config.js";

export interface ConnectionSummary {
  id: string;
  type: "org" | "git";
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  instanceUrl?: string;
  orgType?: "sandbox" | "production";
  remoteUrl?: string;
  defaultBranch?: string;
  // Set when the most recent token refresh attempt failed (e.g. an expired or rotated-away
  // refresh token) — lets the Connections page offer to re-authorize just that org.
  lastError?: string | null;
}

export function createOrgConnection(
  db: Database.Database,
  input: { nickname: string; orgType: "sandbox" | "production"; instanceUrl: string; refreshToken: string; clientId: string }
): ConnectionSummary {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (id, type, nickname, created_at, instance_url, org_type, encrypted_refresh_token, encrypted_client_id)
     VALUES (?, 'org', ?, ?, ?, ?, ?, ?)`
  ).run(id, input.nickname, createdAt, input.instanceUrl, input.orgType, encrypt(input.refreshToken), encrypt(input.clientId));

  return { id, type: "org", nickname: input.nickname, createdAt, lastUsedAt: null, instanceUrl: input.instanceUrl, orgType: input.orgType };
}

export function listConnections(db: Database.Database): ConnectionSummary[] {
  return db
    .prepare(
      `SELECT id, type, nickname,
              created_at as createdAt, last_used_at as lastUsedAt,
              instance_url as instanceUrl, org_type as orgType,
              remote_url as remoteUrl, default_branch as defaultBranch,
              last_error as lastError
       FROM connections`
    )
    .all() as ConnectionSummary[];
}

export function deleteConnection(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
}

export function getConnectionRow(db: Database.Database, id: string): any {
  return db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
}

// Two requests for the same connection can land close together (e.g. a page that fetches
// metadata types and loads a diff at the same time). With refresh token rotation enabled,
// Salesforce invalidates a refresh token the instant it's used, so if both requests read the
// same stored token and both try to exchange it, the loser gets invalid_grant — and can leave
// the DB holding a token that's already been superseded, permanently breaking the connection.
// Coalescing concurrent calls into a single in-flight exchange avoids that race entirely.
const inFlightRefreshes = new Map<string, Promise<{ accessToken: string; instanceUrl: string }>>();

export async function getValidAccessToken(
  db: Database.Database,
  id: string,
  _config: Config
): Promise<{ accessToken: string; instanceUrl: string }> {
  const existing = inFlightRefreshes.get(id);
  if (existing) return existing;

  const exchange = (async () => {
    const row = getConnectionRow(db, id);
    if (!row || row.type !== "org") {
      throw new Error(`No org connection with id ${id}`);
    }
    const refreshToken = decrypt(row.encrypted_refresh_token);
    const clientId = decrypt(row.encrypted_client_id);
    const loginUrl = row.org_type === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

    let result;
    try {
      result = await refreshAccessToken({ loginUrl, refreshToken, clientId });
    } catch (err) {
      // Recorded so the Connections page can flag this org as needing re-authorization, instead
      // of the failure only ever surfacing as a one-off error on whatever action triggered it.
      db.prepare(`UPDATE connections SET last_error = ? WHERE id = ?`).run((err as Error).message, id);
      throw err;
    }

    // Connected Apps with refresh token rotation enabled invalidate the old refresh token as soon
    // as a new one is issued — if we don't persist it here, the next refresh fails with
    // invalid_grant even though nothing else is wrong.
    if (result.refreshToken) {
      db.prepare(`UPDATE connections SET last_used_at = ?, encrypted_refresh_token = ?, last_error = NULL WHERE id = ?`).run(
        new Date().toISOString(),
        encrypt(result.refreshToken),
        id
      );
    } else {
      db.prepare(`UPDATE connections SET last_used_at = ?, last_error = NULL WHERE id = ?`).run(new Date().toISOString(), id);
    }

    return { accessToken: result.accessToken, instanceUrl: result.instanceUrl };
  })();

  inFlightRefreshes.set(id, exchange);
  try {
    return await exchange;
  } finally {
    inFlightRefreshes.delete(id);
  }
}

/**
 * Replaces an org connection's credentials after the user re-authorizes it through Salesforce
 * again — used to recover a connection whose refresh token expired or was revoked, without
 * creating a duplicate connection or losing its id (and everything referencing it, like past
 * deployments).
 */
export function reauthorizeOrgConnection(
  db: Database.Database,
  id: string,
  input: { instanceUrl: string; refreshToken: string }
): void {
  const row = getConnectionRow(db, id);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${id}`);
  }
  db.prepare(
    `UPDATE connections SET instance_url = ?, encrypted_refresh_token = ?, last_error = NULL, last_used_at = ? WHERE id = ?`
  ).run(input.instanceUrl, encrypt(input.refreshToken), new Date().toISOString(), id);
}
