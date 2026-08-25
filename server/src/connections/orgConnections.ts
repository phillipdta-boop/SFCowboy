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
              remote_url as remoteUrl, default_branch as defaultBranch
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

export async function getValidAccessToken(
  db: Database.Database,
  id: string,
  _config: Config
): Promise<{ accessToken: string; instanceUrl: string }> {
  const row = getConnectionRow(db, id);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${id}`);
  }
  const refreshToken = decrypt(row.encrypted_refresh_token);
  const clientId = decrypt(row.encrypted_client_id);
  const loginUrl = row.org_type === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

  const { accessToken, instanceUrl } = await refreshAccessToken({ loginUrl, refreshToken, clientId });

  db.prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  return { accessToken, instanceUrl };
}
