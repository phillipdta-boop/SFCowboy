import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import {
  createOrgConnection,
  listConnections,
  deleteConnection,
  getValidAccessToken,
  getConnectionRow,
  getConnectionSummary,
  reauthorizeOrgConnection,
  renameConnection,
  setMinCodeCoveragePercent,
  testOrgConnection,
} from "./orgConnections.js";
import { createGitConnection } from "./gitConnections.js";
import * as oauth from "../auth/oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "b".repeat(64);

const config: Config = {
  port: 3000,
  databaseUrl: "postgres://unused",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfClientId: "3MVG9fake-client-id",
};

let testDb: TestDb;

beforeEach(async () => {
  testDb = await openTestDb();
});

afterEach(async () => {
  await testDb.stop();
});

describe("orgConnections", () => {
  it("creates a connection and lists it without exposing the refresh token or client id", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9raw-client-id",
    });
    expect(created.nickname).toBe("Dev Sandbox");

    const list = await listConnections(db);
    expect(list).toHaveLength(1);
    // Checked against the raw snake_case column names (what would actually leak the secret if
    // CONNECTION_SUMMARY_COLUMNS' own SELECT were ever widened to include them), rather than
    // camelCase names that were never used as column aliases in the first place and so could
    // never fail regardless of what the query actually selects.
    expect(Object.keys(list[0])).not.toContain("encrypted_refresh_token");
    expect(Object.keys(list[0])).not.toContain("encrypted_client_id");
    expect(Object.keys(list[0])).not.toContain("client_id");
    expect(list[0].nickname).toBe("Dev Sandbox");

    // Verify that the refresh token and client id are actually encrypted (not plaintext)
    const row = await getConnectionRow(db, created.id);
    expect(row.encrypted_refresh_token).not.toBe("raw-refresh-token");
    expect(row.encrypted_client_id).not.toBe("3MVG9raw-client-id");
  });

  it("deletes a connection", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "QA",
      orgType: "sandbox",
      instanceUrl: "https://myorg--qa.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "client-id",
    });
    await deleteConnection(db, created.id);
    expect(await listConnections(db)).toHaveLength(0);
  });

  it("refreshes an access token using the decrypted refresh token and this connection's own client id", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
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
  });

  // Regression test: Connected Apps with refresh token rotation enabled invalidate the old
  // refresh token as soon as a new one is issued. If the rotated token isn't persisted, the very
  // next refresh attempt fails with invalid_grant even though nothing else is wrong.
  it("persists a rotated refresh token so the next refresh doesn't fail", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
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

    const row = await getConnectionRow(db, created.id);
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
  });

  // Regression test: two requests for the same connection arriving close together (e.g. a page
  // that fetches metadata types and auto-loads a diff at the same time) must not both exchange
  // the current refresh token. With rotation enabled, Salesforce invalidates a refresh token the
  // instant it's used — the loser of that race gets invalid_grant, and worse, can leave the DB
  // holding a token that's already been superseded, permanently breaking the connection.
  it("coalesces concurrent refreshes for the same connection into a single token exchange", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
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

    // With a real (pg) Pool, the getConnectionRow lookup inside getValidAccessToken is a genuine
    // async I/O round trip rather than the synchronous SQLite call it used to be, so the
    // mocked refreshAccessToken's promise executor no longer runs synchronously by this point —
    // wait for it to actually be invoked before resolving it.
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    resolveExchange!({ accessToken: "fresh-access-token", instanceUrl: "https://myorg.my.salesforce.com" });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(firstResult.accessToken).toBe("fresh-access-token");
    expect(secondResult.accessToken).toBe("fresh-access-token");
  });

  it("performs a fresh exchange for a later, non-overlapping call", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
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
  });

  it("does not overwrite the stored refresh token when Salesforce doesn't rotate it", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "stable-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    const before = (await getConnectionRow(db, created.id)).encrypted_refresh_token;

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    await getValidAccessToken(db, created.id, config);

    const after = (await getConnectionRow(db, created.id)).encrypted_refresh_token;
    expect(after).toBe(before);
  });

  it("records the failure on the connection so the Connections page can flag it, without touching the stored refresh token", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    const tokenBefore = (await getConnectionRow(db, created.id)).encrypted_refresh_token;

    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValue(
      new Error("OAuth token exchange failed (400): invalid_grant")
    );

    await expect(getValidAccessToken(db, created.id, config)).rejects.toThrow("invalid_grant");

    const row = await getConnectionRow(db, created.id);
    expect(row.last_error).toContain("invalid_grant");
    expect(row.encrypted_refresh_token).toBe(tokenBefore);
    const list = await listConnections(db);
    expect(list.find((c) => c.id === created.id)?.lastError).toContain("invalid_grant");
  });

  it("clears a previously recorded failure once a refresh succeeds again", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValueOnce(new Error("invalid_grant"));
    await expect(getValidAccessToken(db, created.id, config)).rejects.toThrow();
    expect((await getConnectionRow(db, created.id)).last_error).toBeTruthy();

    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValueOnce({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });
    await getValidAccessToken(db, created.id, config);

    expect((await getConnectionRow(db, created.id)).last_error).toBeNull();
  });
});

describe("reauthorizeOrgConnection", () => {
  it("replaces the stored credentials and clears any recorded failure", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://old.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });
    await db.query(`UPDATE connections SET last_error = 'invalid_grant' WHERE id = $1`, [created.id]);

    await reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "new-refresh-token",
    });

    const row = await getConnectionRow(db, created.id);
    expect(row.instance_url).toBe("https://new.my.salesforce.com");
    expect(row.last_error).toBeNull();

    const spy = vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://new.my.salesforce.com",
    });
    await getValidAccessToken(db, created.id, config);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "new-refresh-token" }));
  });

  it("does not create a new connection or change the connection's id", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://old.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
    });

    await reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "new-refresh-token",
    });

    const list = await listConnections(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("throws for an unknown connection id", async () => {
    const db = testDb.pool;
    await expect(
      reauthorizeOrgConnection(db, "unknown", { instanceUrl: "https://x", refreshToken: "r" })
    ).rejects.toThrow();
  });

  // The username is only known once the user has actually authorized through Salesforce again,
  // so it's optional — omitting it (e.g. the identity lookup failed) must leave whatever username
  // was already stored untouched rather than blanking it out.
  it("updates the stored username when given one, and leaves it untouched when not", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://old.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9this-orgs-client-id",
      username: "phillip.ta@effluence.com.au",
    });

    await reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "new-refresh-token",
    });
    expect((await getConnectionRow(db, created.id)).login_username).toBe("phillip.ta@effluence.com.au");

    await reauthorizeOrgConnection(db, created.id, {
      instanceUrl: "https://new.my.salesforce.com",
      refreshToken: "newer-refresh-token",
      username: "other.user@effluence.com.au",
    });
    expect((await getConnectionRow(db, created.id)).login_username).toBe("other.user@effluence.com.au");
  });
});

describe("renameConnection", () => {
  it("updates the nickname without touching anything else", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Old name", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    await renameConnection(db, created.id, "New name");
    const row = await getConnectionRow(db, created.id);
    expect(row.nickname).toBe("New name");
    expect(row.instance_url).toBe("https://x");
  });

  it("throws for an unknown connection id", async () => {
    const db = testDb.pool;
    await expect(renameConnection(db, "unknown", "New name")).rejects.toThrow();
  });

  it("rejects a blank nickname", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Old name", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    await expect(renameConnection(db, created.id, "  ")).rejects.toThrow(/nickname/i);
  });
});

describe("setMinCodeCoveragePercent", () => {
  it("sets a threshold that then appears on the connection summary", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod", orgType: "production", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    await setMinCodeCoveragePercent(db, created.id, 85);
    expect((await getConnectionSummary(db, created.id))?.minCodeCoveragePercent).toBe(85);
  });

  it("clears a threshold when set to null", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod", orgType: "production", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    await setMinCodeCoveragePercent(db, created.id, 85);
    await setMinCodeCoveragePercent(db, created.id, null);
    expect((await getConnectionSummary(db, created.id))?.minCodeCoveragePercent).toBeNull();
  });

  it("rejects a percentage outside 0-100", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod", orgType: "production", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    await expect(setMinCodeCoveragePercent(db, created.id, 101)).rejects.toThrow(/0 and 100/);
    await expect(setMinCodeCoveragePercent(db, created.id, -1)).rejects.toThrow(/0 and 100/);
  });

  it("rejects a git connection — it never runs Apex tests", async () => {
    const db = testDb.pool;
    const created = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://x", defaultBranch: "main", authToken: "t" });
    await expect(setMinCodeCoveragePercent(db, created.id, 80)).rejects.toThrow(/org connection/i);
  });

  it("throws for an unknown connection id", async () => {
    const db = testDb.pool;
    await expect(setMinCodeCoveragePercent(db, "unknown", 80)).rejects.toThrow();
  });
});

describe("testOrgConnection", () => {
  it("returns ok when a fresh access token can be obtained", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod", orgType: "production", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({ accessToken: "a", instanceUrl: "https://x" });

    await expect(testOrgConnection(db, config, created.id)).resolves.toEqual({ ok: true });
  });

  // Surfaces the failure as a result rather than a thrown error, so the route handler doesn't
  // need a try/catch just to report "the credentials don't work" back to the UI.
  it("returns ok: false with the failure message when the token refresh fails", async () => {
    const db = testDb.pool;
    const created = await createOrgConnection(db, {
      nickname: "Prod", orgType: "production", instanceUrl: "https://x", refreshToken: "r", clientId: "c",
    });
    vi.spyOn(oauth, "refreshAccessToken").mockRejectedValue(new Error("invalid_grant"));

    await expect(testOrgConnection(db, config, created.id)).resolves.toEqual({ ok: false, error: "invalid_grant" });
  });
});
