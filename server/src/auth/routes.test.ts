import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createAuthRouter } from "./routes.js";
import { listConnections, getConnectionRow, createOrgConnection } from "../connections/orgConnections.js";
import * as oauth from "./oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "c".repeat(64);

const config: Config = {
  port: 3000,
  databaseUrl: "postgres://unused",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "http://localhost:3000/oauth/callback",
  sfClientId: "3MVG9packaged-client-id",
};

let testDb: TestDb;

function buildApp() {
  const db = testDb.pool;
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(db, config));
  return { app, db };
}

beforeEach(async () => {
  testDb = await openTestDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await testDb.stop();
});

describe("POST /api/connections/org/authorize", () => {
  it("returns a Salesforce authorize URL built with the fixed package client id", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/authorize").send({ nickname: "Prod", orgType: "production" });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://login.salesforce.com/services/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("3MVG9packaged-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/oauth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("uses test.salesforce.com for a sandbox orgType", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/authorize").send({ nickname: "Dev Sandbox", orgType: "sandbox" });
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin).toBe("https://test.salesforce.com");
  });

  it("400s when nickname is missing", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/authorize").send({ orgType: "production" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nickname/i);
  });

  it("400s on an invalid orgType", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/authorize").send({ nickname: "Prod", orgType: "not-a-real-type" });
    expect(res.status).toBe(400);
  });

  it("builds an authorize URL from the existing connection's orgType when re-authorizing, without needing a nickname", async () => {
    const { app, db } = buildApp();
    const existing = await createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9packaged-client-id",
    });

    const res = await request(app).post("/api/connections/org/authorize").send({ connectionId: existing.id });

    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    expect(url.origin).toBe("https://test.salesforce.com");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("404s when re-authorizing an unknown connection id", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/authorize").send({ connectionId: "unknown" });
    expect(res.status).toBe(404);
  });
});

describe("GET /oauth/callback", () => {
  async function startAuthorization(app: express.Express, body: { nickname: string; orgType: "sandbox" | "production" }) {
    const res = await request(app).post("/api/connections/org/authorize").send(body);
    const url = new URL(res.body.authorizeUrl);
    return url.searchParams.get("state")!;
  }

  it("exchanges the code for tokens and stores a new connection on success", async () => {
    const { app, db } = buildApp();
    const state = await startAuthorization(app, { nickname: "Prod", orgType: "production" });

    vi.spyOn(oauth, "exchangeCodeForToken").mockResolvedValue({
      accessToken: "acc",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const res = await request(app).get("/oauth/callback").query({ code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/connections?connected=1");

    const connections = await listConnections(db);
    expect(connections).toHaveLength(1);
    expect(connections[0].nickname).toBe("Prod");
    const row = await getConnectionRow(db, connections[0].id);
    expect(row.encrypted_refresh_token).not.toBe("ref456");
    expect(row.encrypted_client_id).not.toBe("3MVG9packaged-client-id");
  });

  it("redirects with an error and stores nothing when the state is unknown/expired", async () => {
    const { app, db } = buildApp();
    const res = await request(app).get("/oauth/callback").query({ code: "auth-code", state: "not-a-real-state" });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/connections?error=");
    expect(await listConnections(db)).toHaveLength(0);
  });

  it("redirects with an error when Salesforce itself reports an error", async () => {
    const { app, db } = buildApp();
    const state = await startAuthorization(app, { nickname: "Prod", orgType: "production" });

    const res = await request(app).get("/oauth/callback").query({ error: "access_denied", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/connections?error=");
    expect(await listConnections(db)).toHaveLength(0);
  });

  it("redirects with a generic error (not the raw failure detail) when the token exchange fails", async () => {
    const { app, db } = buildApp();
    const state = await startAuthorization(app, { nickname: "Prod", orgType: "production" });
    const sensitive = "invalid_grant: this org has restrictions for admin@example.com";
    vi.spyOn(oauth, "exchangeCodeForToken").mockRejectedValue(new Error(sensitive));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/oauth/callback").query({ code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("admin@example.com");
    expect(res.headers.location).not.toContain("invalid_grant");
    expect(logSpy).toHaveBeenCalledWith("Salesforce org authorization failed", expect.any(Error));
    expect(await listConnections(db)).toHaveLength(0);
  });

  it("cannot reuse the same state twice", async () => {
    const { app } = buildApp();
    const state = await startAuthorization(app, { nickname: "Prod", orgType: "production" });
    vi.spyOn(oauth, "exchangeCodeForToken").mockResolvedValue({
      accessToken: "acc",
      refreshToken: "ref",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    await request(app).get("/oauth/callback").query({ code: "auth-code", state });
    const secondAttempt = await request(app).get("/oauth/callback").query({ code: "auth-code-2", state });

    expect(secondAttempt.headers.location).toContain("/connections?error=");
  });

  it("updates the existing connection's credentials instead of creating a new one when re-authorizing", async () => {
    const { app, db } = buildApp();
    const existing = await createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://old.sandbox.my.salesforce.com",
      refreshToken: "stale-refresh-token",
      clientId: "3MVG9packaged-client-id",
    });
    await db.query(`UPDATE connections SET last_error = 'invalid_grant' WHERE id = $1`, [existing.id]);

    const authRes = await request(app).post("/api/connections/org/authorize").send({ connectionId: existing.id });
    const state = new URL(authRes.body.authorizeUrl).searchParams.get("state")!;

    vi.spyOn(oauth, "exchangeCodeForToken").mockResolvedValue({
      accessToken: "acc",
      refreshToken: "fresh-refresh-token",
      instanceUrl: "https://new.sandbox.my.salesforce.com",
    });

    const res = await request(app).get("/oauth/callback").query({ code: "auth-code", state });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/connections?reconnected=1");

    const connections = await listConnections(db);
    expect(connections).toHaveLength(1);
    expect(connections[0].id).toBe(existing.id);
    expect(connections[0].instanceUrl).toBe("https://new.sandbox.my.salesforce.com");
    expect(connections[0].lastError).toBeFalsy();
  });
});
