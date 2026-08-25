import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createAuthRouter } from "./routes.js";
import { listConnections, getConnectionRow } from "../connections/orgConnections.js";
import * as bootstrap from "./bootstrap.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "c".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter(db, config));
  return { app, db };
}

describe("POST /api/connections/org/bootstrap", () => {
  it("bootstraps a new org connection and stores it, without echoing the password back", async () => {
    const { app, db } = buildApp();
    const bootstrapSpy = vi.spyOn(bootstrap, "bootstrapOrgConnection").mockResolvedValue({
      clientId: "3MVG9auto-generated",
      accessToken: "acc",
      refreshToken: "ref",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
    });

    const res = await request(app).post("/api/connections/org/bootstrap").send({
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      username: "admin@example.com",
      password: "hunter2",
      securityToken: "TOKEN123",
    });

    expect(res.status).toBe(201);
    expect(res.body.nickname).toBe("Dev Sandbox");
    expect(JSON.stringify(res.body)).not.toContain("hunter2");

    expect(bootstrapSpy).toHaveBeenCalledWith({
      orgType: "sandbox",
      username: "admin@example.com",
      password: "hunter2",
      securityToken: "TOKEN123",
      callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
    });

    const connections = listConnections(db);
    expect(connections).toHaveLength(1);
    const row = getConnectionRow(db, connections[0].id);
    expect(row.encrypted_refresh_token).not.toBe("ref");
    expect(row.encrypted_client_id).not.toBe("3MVG9auto-generated");
  });

  it("400s when a required field is missing", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/connections/org/bootstrap").send({ nickname: "Dev", orgType: "sandbox" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it("400s on an invalid orgType", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/connections/org/bootstrap")
      .send({ nickname: "Dev", orgType: "not-a-real-type", username: "u", password: "p" });
    expect(res.status).toBe(400);
  });

  // The failure detail can carry Salesforce error text (which may itself echo back the
  // username), so it stays in the server log; the client only gets a generic message.
  it("returns a generic error (not the raw failure detail) when bootstrapping fails, and stores nothing", async () => {
    const { app, db } = buildApp();
    const sensitive = "INVALID_LOGIN: Invalid username, password, security token for admin@example.com";
    vi.spyOn(bootstrap, "bootstrapOrgConnection").mockRejectedValue(new Error(sensitive));
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).post("/api/connections/org/bootstrap").send({
      nickname: "Dev",
      orgType: "sandbox",
      username: "admin@example.com",
      password: "wrong",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("INVALID_LOGIN");
    expect(JSON.stringify(res.body)).not.toContain("admin@example.com");
    expect(logSpy).toHaveBeenCalledWith("Salesforce org bootstrap failed", expect.any(Error));
    expect(listConnections(db)).toHaveLength(0);

    logSpy.mockRestore();
  });
});
