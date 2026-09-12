import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { requireSupabaseUser } from "./requireSupabaseUser.js";
import type { Config } from "../config.js";

const config: Config = {
  port: 3000,
  databaseUrl: "unused-in-tests",
  encryptionKey: "7".repeat(64),
  oauthCallbackUrl: "https://unused",
  sfClientId: "unused",
  supabaseUrl: "https://not-a-real-project.supabase.co",
  supabaseServiceRoleKey: "unused-in-tests",
  appBaseUrl: "https://unused",
};

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await db.stop();
});

function buildApp() {
  const app = express();
  app.get("/protected", requireSupabaseUser(db.pool, config), (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

describe("requireSupabaseUser", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a malformed Bearer token", async () => {
    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});
