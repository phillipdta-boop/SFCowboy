import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
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
  // The Salesforce username this org connection is authorized as — captured from the identity
  // endpoint at (re-)authorization time (see oauth.ts's exchangeCodeForToken). Org connections
  // only; always undefined for a git connection.
  username?: string | null;
  // The minimum aggregate Apex coverage a deploy to this connection must meet — see the coverage
  // gate in engine/deploy.ts. Org connections only (git targets never run Apex tests); null means
  // no gate is configured.
  minCodeCoveragePercent?: number | null;
}

export async function createOrgConnection(
  db: Pool,
  input: {
    nickname: string;
    orgType: "sandbox" | "production";
    instanceUrl: string;
    refreshToken: string;
    clientId: string;
    username?: string;
  }
): Promise<ConnectionSummary> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    `INSERT INTO connections (id, type, nickname, created_at, instance_url, org_type, encrypted_refresh_token, encrypted_client_id, login_username)
     VALUES ($1, 'org', $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.nickname, createdAt, input.instanceUrl, input.orgType, encrypt(input.refreshToken), encrypt(input.clientId), input.username ?? null]
  );

  return {
    id, type: "org", nickname: input.nickname, createdAt, lastUsedAt: null,
    instanceUrl: input.instanceUrl, orgType: input.orgType, username: input.username ?? null,
  };
}

const CONNECTION_SUMMARY_COLUMNS = `id, type, nickname,
              created_at as "createdAt", last_used_at as "lastUsedAt",
              instance_url as "instanceUrl", org_type as "orgType",
              remote_url as "remoteUrl", default_branch as "defaultBranch",
              last_error as "lastError", login_username as username,
              min_code_coverage_percent as "minCodeCoveragePercent"`;

export async function listConnections(db: Pool): Promise<ConnectionSummary[]> {
  const result = await db.query<ConnectionSummary>(`SELECT ${CONNECTION_SUMMARY_COLUMNS} FROM connections`);
  return result.rows;
}

export async function getConnectionSummary(db: Pool, id: string): Promise<ConnectionSummary | undefined> {
  const result = await db.query<ConnectionSummary>(`SELECT ${CONNECTION_SUMMARY_COLUMNS} FROM connections WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function deleteConnection(db: Pool, id: string): Promise<void> {
  await db.query(`DELETE FROM connections WHERE id = $1`, [id]);
}

/** Renames a connection (org or git) — just a label, safe at any time. */
export async function renameConnection(db: Pool, id: string, nickname: string): Promise<void> {
  if (!nickname || !nickname.trim()) {
    throw new Error("nickname must not be blank");
  }
  const row = await getConnectionRow(db, id);
  if (!row) throw new Error(`No connection with id ${id}`);
  await db.query(`UPDATE connections SET nickname = $1 WHERE id = $2`, [nickname.trim(), id]);
}

/**
 * Sets (or clears, with null) the minimum aggregate Apex coverage a deploy to this connection
 * must meet — see the coverage gate in engine/deploy.ts. Org connections only: a git target never
 * runs Apex tests, so a threshold there could never be satisfied.
 */
export async function setMinCodeCoveragePercent(db: Pool, id: string, percent: number | null): Promise<void> {
  const row = await getConnectionRow(db, id);
  if (!row) throw new Error(`No connection with id ${id}`);
  if (row.type !== "org") {
    throw new Error("A minimum coverage threshold only applies to an org connection");
  }
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error("minCodeCoveragePercent must be a number between 0 and 100, or null");
  }
  await db.query(`UPDATE connections SET min_code_coverage_percent = $1 WHERE id = $2`, [percent, id]);
}

export async function getConnectionRow(db: Pool, id: string): Promise<any> {
  const result = await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  return result.rows[0];
}

// Two requests for the same connection can land close together (e.g. a page that fetches
// metadata types and loads a diff at the same time). With refresh token rotation enabled,
// Salesforce invalidates a refresh token the instant it's used, so if both requests read the
// same stored token and both try to exchange it, the loser gets invalid_grant — and can leave
// the DB holding a token that's already been superseded, permanently breaking the connection.
// Coalescing concurrent calls into a single in-flight exchange avoids that race entirely.
const inFlightRefreshes = new Map<string, Promise<{ accessToken: string; instanceUrl: string }>>();

export async function getValidAccessToken(
  db: Pool,
  id: string,
  _config: Config
): Promise<{ accessToken: string; instanceUrl: string }> {
  const existing = inFlightRefreshes.get(id);
  if (existing) return existing;

  const exchange = (async () => {
    const row = await getConnectionRow(db, id);
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
      await db.query(`UPDATE connections SET last_error = $1 WHERE id = $2`, [(err as Error).message, id]);
      throw err;
    }

    // Connected Apps with refresh token rotation enabled invalidate the old refresh token as soon
    // as a new one is issued — if we don't persist it here, the next refresh fails with
    // invalid_grant even though nothing else is wrong.
    if (result.refreshToken) {
      await db.query(
        `UPDATE connections SET last_used_at = $1, encrypted_refresh_token = $2, last_error = NULL WHERE id = $3`,
        [new Date().toISOString(), encrypt(result.refreshToken), id]
      );
    } else {
      await db.query(`UPDATE connections SET last_used_at = $1, last_error = NULL WHERE id = $2`, [new Date().toISOString(), id]);
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
export async function reauthorizeOrgConnection(
  db: Pool,
  id: string,
  input: { instanceUrl: string; refreshToken: string; username?: string }
): Promise<void> {
  const row = await getConnectionRow(db, id);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${id}`);
  }
  // Omitting username (e.g. the identity lookup failed) must not blank out whatever was already
  // stored — COALESCE keeps the existing value in that case.
  await db.query(
    `UPDATE connections
     SET instance_url = $1, encrypted_refresh_token = $2, last_error = NULL, last_used_at = $3, login_username = COALESCE($4, login_username)
     WHERE id = $5`,
    [input.instanceUrl, encrypt(input.refreshToken), new Date().toISOString(), input.username ?? null, id]
  );
}

/**
 * Verifies an org connection's stored credentials still work by attempting a token refresh —
 * the same operation every real deploy/diff call already depends on, so success here is a
 * meaningful signal without needing a separate Salesforce API call. Reports failure as a result
 * rather than throwing, so the route handler can hand it straight to the UI.
 */
export async function testOrgConnection(db: Pool, config: Config, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getValidAccessToken(db, id, config);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
