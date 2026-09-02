import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { openTestDb, type TestDb } from "./db/testDb.js";
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
  databaseUrl: "unused-in-tests",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfClientId: "3MVG9fake-client-id",
};

let testDb: TestDb;

beforeEach(async () => {
  testDb = await openTestDb();
});

afterEach(async () => {
  // The error-middleware test below deliberately ends its own testDb.pool early (to force a
  // real rejected promise inside a real route handler), so testDb.stop() calling pool.end()
  // again here would reject with "Called end on pool more than once". Tolerate that one case;
  // any other failure from stop() should still fail the test as before.
  await testDb.stop().catch((err: unknown) => {
    if (err instanceof Error && err.message.includes("Called end on pool more than once")) return;
    throw err;
  });
});

describe("createApp", () => {
  it("responds to GET /api/health with status ok", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("mounts the connections router", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("mounts the auth router", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    // A route that only exists on the auth router; a valid body proves the route is
    // reachable and produces a real authorize URL through the whole assembled app.
    const res = await request(app).post("/api/connections/org/authorize").send({ nickname: "Test", orgType: "sandbox" });
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain("test.salesforce.com");
  });

  it("mounts the engine router", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    const res = await request(app).get("/api/deployments");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("mounts the pipelines router", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    const res = await request(app).get("/api/pipelines");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("createApp error handling", () => {
  it("responds 500 instead of crashing when an async route handler's promise rejects", async () => {
    const app = createApp(testDb.pool, config, dataDir);

    // Force a real rejected promise inside a real route handler: GET /api/connections calls
    // listConnections(db), a genuine async DB query with no try/catch of its own. Ending the
    // pool first makes that query reject for real, exercising express-async-errors (imported
    // at the top of app.ts) forwarding the rejection to the terminal error middleware. Without
    // either the import or the middleware (or if the middleware lost a parameter, or were
    // registered above a router), this would crash the process instead of yielding a 500.
    await testDb.pool.end();

    const res = await request(app).get("/api/connections");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});

describe("createApp static frontend serving", () => {
  it("serves index.html for a non-API route when webDistDir is provided", async () => {
    const webDistDir = makeWebDistDir();
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const app = createApp(testDb.pool, config, dataDir, webDistDir);

    const res = await request(app).get("/connections");
    expect(res.status).toBe(200);
    expect(res.text).toContain("SFCowboy");
  });

  it("does not intercept unmatched /api routes with the SPA fallback", async () => {
    const webDistDir = makeWebDistDir();
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const app = createApp(testDb.pool, config, dataDir, webDistDir);

    const res = await request(app).get("/api/does-not-exist");
    expect(res.text).not.toContain("SFCowboy");
  });
});
