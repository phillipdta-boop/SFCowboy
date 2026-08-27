import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import {
  createOrgConnection,
  listConnections,
  deleteConnection,
  getValidAccessToken,
  getConnectionRow,
  reauthorizeOrgConnection,
} from "./orgConnections.js";
import * as oauth from "../auth/oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "b".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfClientId: "3MVG9fake-client-id",
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

  // Regression test: Connected Apps with refresh token rotation enabled invalidate the old
  // refresh token as soon as a new one is issued. If the rotated token isn't persisted, the very
  // next refresh attempt fails with invalid_grant even though nothing else is wrong.
  it("persists a rotated refresh token so the next refresh doesn't fail", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "original-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValueOnce({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "rotated-refresh-token",
    });

    await getValidAccessToken(db, created.id, config);

    const row = getConnectionRow(db, created.id);
    expect(row.encrypted_refresh_token).not.toBe("original-refresh-token");

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValueOnce({
      accessToken: "second-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    await getValidAccessToken(db, created.id, config);

    const secondSpy = vi.mocked(oauth.refreshAccessToken);
    expect(secondSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshToken: "rotated-refresh-token" })
    );
    db.close();
  });

  // Regression test: two requests for the same connection arriving close together (e.g. a page
  // that fetches metadata types and auto-loads a diff at the same time) must not both exchange
  // the current refresh token. With rotation enabled, Salesforce invalidates a refresh token the
  // instant it's used — the loser of that race gets invalid_grant, and worse, can leave the DB
  // holding a token that's already been superseded, permanently breaking the connection.
  it("coalesces concurrent refreshes for the same connection into a single token exchange", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "original-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    let resolveExchange: (value: { accessToken: string; instanceUrl: string; refreshToken?: string }) => void;
    const spy = vi.spyOn(oauth, "refreshAccessToken").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExchange = resolve;
        })
    );

    const first = getValidAccessToken(db, created.id, config);
    const second = getValidAccessToken(db, created.id, config);

    resolveExchange!({ accessToken: "fresh-access-token", instanceUrl: "https://myorg.my.salesforce.com" });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(firstResult.accessToken).toBe("fresh-access-token");
    expect(secondResult.accessToken).toBe("fresh-access-token");
    db.close();
  });

  it("performs a fresh exchange for a later, non-overlapping call", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "original-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    const spy = vi
      .spyOn(oauth, "refreshAccessToken")
      .mockResolvedValueOnce({ accessToken: "first-access-token", instanceUrl: "https://myorg.my.salesforce.com" })
      .mockResolvedValueOnce({ accessToken: "second-access-token", instanceUrl: "https://myorg.my.salesforce.com" });

    await getValidAccessToken(db, created.id, config);
    await getValidAccessToken(db, created.id, config);

    expect(spy).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("does not overwrite the stored refresh token when Salesforce doesn't rotate it", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "stable-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    const before = getConnectionRow(db, created.id).encrypted_refresh_token;

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    await getValidAccessToken(db, created.id, config);

    const after = getConnectionRow(db, created.id).encrypted_refresh_token;
    expect(after).toBe(before);
    db.close();
  });

  it("records the failure on the connection so the Connections page can flag it, without touching the stored refresh token", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    const tokenBefore = getConnectionRow(db, created.id).encrypted_refresh_token;

    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValue(
      new Error("OAuth token exchange failed (400): invalid_grant")
    );

    await expect(getValidAccessToken(db, created.id, config)).rejects.toThrow("invalid_grant");

    const row = getConnectionRow(db, created.id);
    expect(row.last_error).toContain("invalid_grant");
    expect(row.encrypted_refresh_token).toBe(tokenBefore);
    expect(listConnections(db).find((c) => c.id === created.id)?.lastError).toContain("invalid_grant");
    db.close();
  });

  it("clears a previously recorded failure once a refresh succeeds again", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValueOnce(new Error("invalid_grant"));
    await expect(getValidAccessToken(db, created.id, config)).rejects.toThrow();
    expect(getConnectionRow(db, created.id).last_error).toBeTruthy();

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValueOnce({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });
    await getValidAccessToken(db, created.id, config);

    expect(getConnectionRow(db, created.id).last_error).toBeNull();
    db.close();
  });
});

describe("reauthorizeOrgConnection", () => {
  it("replaces the stored credentials and clears any recorded failure", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://old.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    db.prepare(`UPDATE connections SET last_error = 'invalid_grant' WHERE id = ?`).run(created.id);

    reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "new-refresh-token",
    });

    const row = getConnectionRow(db, created.id);
    expect(row.instance_url).toBe("https://new.my.salesforce.com");
    expect(row.last_error).toBeNull();

    const spy = vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://new.my.salesforce.com",
    });
    await getValidAccessToken(db, created.id, config);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "new-refresh-token" }));
    db.close();
  });

  it("does not create a new connection or change the connection's id", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://old.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "new-refresh-token",
    });

    expect(listConnections(db)).toHaveLength(1);
    expect(listConnections(db)[0].id).toBe(created.id);
    db.close();
  });

  it("throws for an unknown connection id", () => {
    const db = freshDb();
    expect(() =>
      reauthorizeOrgConnection(db, "unknown", { instanceUrl: "https://x", refreshToken: "r" })
    ).toThrow();
    db.close();
  });
});
