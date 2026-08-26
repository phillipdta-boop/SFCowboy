import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection, listConnections, deleteConnection, getValidAccessToken, getConnectionRow } from "./orgConnections.js";
import * as oauth from "../auth/oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "b".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfPackageClientId: "3MVG9fake-client-id",
  sfPackageInstallUrl: "https://login.salesforce.com/packaging/installPackage.apexp?p0=04tFAKE",
};

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("orgConnections", () => {
  it("creates a connection and lists it without exposing the refresh token or client id", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9raw-client-id",
    });
    expect(created.nickname).toBe("Dev Sandbox");

    const list = listConnections(db);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("encryptedRefreshToken");
    expect(list[0]).not.toHaveProperty("clientId");
    expect(list[0].nickname).toBe("Dev Sandbox");

    // Verify that the refresh token and client id are actually encrypted (not plaintext)
    const row = getConnectionRow(db, created.id);
    expect(row.encrypted_refresh_token).not.toBe("raw-refresh-token");
    expect(row.encrypted_client_id).not.toBe("3MVG9raw-client-id");
    db.close();
  });

  it("deletes a connection", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "QA",
      orgType: "sandbox",
      instanceUrl: "https://myorg--qa.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "client-id",
    });
    deleteConnection(db, created.id);
    expect(listConnections(db)).toHaveLength(0);
    db.close();
  });

  it("refreshes an access token using the decrypted refresh token and this connection's own client id", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    const spy = vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const result = await getValidAccessToken(db, created.id, config);

    expect(result.accessToken).toBe("fresh-access-token");
    expect(spy).toHaveBeenCalledWith({
      loginUrl: "https://login.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    db.close();
  });
});
