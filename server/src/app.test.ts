import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

process.env.ENCRYPTION_KEY = "7".repeat(64); // must be valid hex (0-9/a-f)

let dataDir: string;
let webDistDirs: string[] = [];

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-app-"));
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const dir of webDistDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWebDistDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-webdist-"));
  webDistDirs.push(dir);
  return dir;
}

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfClientId: "3MVG9fake-client-id",
};

describe("createApp", () => {
  it("responds to GET /api/health with status ok", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir);

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("mounts the connections router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir);

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("mounts the auth router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir);

    // A route that only exists on the auth router; a valid body proves the route is
    // reachable and produces a real authorize URL through the whole assembled app.
    const res = await request(app).post("/api/connections/org/authorize").send({ nickname: "Test", orgType: "sandbox" });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("test.salesforce.com");
  });

  it("mounts the engine router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir);

    const res = await request(app).get("/api/deployments");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("mounts the pipelines router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir);

    const res = await request(app).get("/api/pipelines");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("createApp static frontend serving", () => {
  it("serves index.html for a non-API route when webDistDir is provided", async () => {
    const webDistDir = makeWebDistDir();
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir, webDistDir);

    const res = await request(app).get("/connections");
    expect(res.status).toBe(200);
    expect(res.text).toContain("SFCowboy");
  });

  it("does not intercept unmatched /api routes with the SPA fallback", async () => {
    const webDistDir = makeWebDistDir();
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, dataDir, webDistDir);

    const res = await request(app).get("/api/does-not-exist");
    expect(res.text).not.toContain("SFCowboy");
  });
});
