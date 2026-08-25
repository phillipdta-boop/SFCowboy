import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection, listConnections, deleteConnection, getValidAccessToken } from "./orgConnections.js";
import * as oauth from "../auth/oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "b".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("orgConnections", () => {
  it("creates a connection and lists it without exposing the refresh token", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });
    expect(created.nickname).toBe("Dev Sandbox");

    const list = listConnections(db);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("encryptedRefreshToken");
    expect(list[0].nickname).toBe("Dev Sandbox");
    db.close();
  });

  it("deletes a connection", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "QA",
      orgType: "sandbox",
      instanceUrl: "https://myorg--qa.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });
    deleteConnection(db, created.id);
    expect(listConnections(db)).toHaveLength(0);
    db.close();
  });

  it("refreshes an access token using the decrypted refresh token", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });

    const spy = vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const result = await getValidAccessToken(db, created.id, config);

    expect(result.accessToken).toBe("fresh-access-token");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ loginUrl: "https://login.salesforce.com", refreshToken: "raw-refresh-token" })
    );
    db.close();
  });
});
