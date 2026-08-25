import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createAuthRouter } from "./routes.js";
import { listConnections } from "../connections/orgConnections.js";
import * as oauth from "./oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "c".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(createAuthRouter(db, config));
  return { app, db };
}

describe("auth routes", () => {
  it("redirects to the Salesforce authorize URL on start", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/connections/org/start?nickname=Dev&orgType=sandbox");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://test.salesforce.com/services/oauth2/authorize");
  });

  it("creates a connection on a valid callback", async () => {
    const { app, db } = buildApp();
    vi.spyOn(oauth, "exchangeCodeForTokens").mockResolvedValue({
      accessToken: "acc",
      refreshToken: "ref",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
    });

    const start = await request(app).get("/api/connections/org/start?nickname=Dev&orgType=sandbox");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    const callback = await request(app).get(`/oauth/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    expect(listConnections(db)).toHaveLength(1);
  });

  it("rejects a callback with an unknown state", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/oauth/callback?code=abc&state=unknown");
    expect(res.status).toBe(400);
  });
});
