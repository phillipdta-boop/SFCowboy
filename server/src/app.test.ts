import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

process.env.ENCRYPTION_KEY = "7".repeat(64); // NOTE: was "i" — invalid hex (only 0-9/a-f), see Task 13's ledger entry

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

describe("createApp", () => {
  it("responds to GET /api/health with status ok", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test");

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("mounts the connections router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test");

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
