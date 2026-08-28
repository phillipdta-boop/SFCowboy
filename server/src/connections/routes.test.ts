// server/src/connections/routes.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection, getConnectionRow } from "./orgConnections.js";
import { createGitConnection } from "./gitConnections.js";
import * as gitConnections from "./gitConnections.js";
import { createConnectionsRouter } from "./routes.js";
import * as oauth from "../auth/oauth.js";
import { vi } from "vitest";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "8".repeat(64); // NOTE: was "h" — invalid hex (only 0-9/a-f), see Task 13's ledger entry

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
  sfClientId: "3MVG9fake-client-id",
};

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createConnectionsRouter(db, config));
  return { app, db };
}

describe("connections routes", () => {
  it("lists connections", async () => {
    const { app, db } = buildApp();
    createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nickname).toBe("Dev");
  });

  it("fetches a single connection by id", async () => {
    const { app, db } = buildApp();
    const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });

    const res = await request(app).get(`/api/connections/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.nickname).toBe("Dev");
    expect(res.body).not.toHaveProperty("encryptedRefreshToken");
  });

  it("returns 404 for a single connection lookup on an unknown id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/connections/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("creates a git connection via POST", async () => {
    const { app } = buildApp();
    const authToken = "ghp_abc";
    const res = await request(app)
      .post("/api/connections/git")
      .send({ nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("git");
    expect(res.body).not.toHaveProperty("encryptedAuthToken");
    expect(JSON.stringify(res.body)).not.toContain(authToken);
  });

  it("deletes a connection", async () => {
    const { app, db } = buildApp();
    const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const res = await request(app).delete(`/api/connections/${created.id}`);
    expect(res.status).toBe(204);

    const listed = await request(app).get("/api/connections");
    expect(listed.body).toHaveLength(0);
  });

  it("returns 404 when deleting a nonexistent connection", async () => {
    const { app } = buildApp();
    const res = await request(app).delete("/api/connections/nonexistent-id");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("connection not found");
  });

  // Without validation an absent field reaches encrypt(undefined), and a wrong-typed one gets
  // persisted as garbage on the connection row.
  const badGitBodies: [string, object][] = [
    ["missing authToken", { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main" }],
    ["missing remoteUrl", { nickname: "Repo", defaultBranch: "main", authToken: "t" }],
    ["missing nickname", { remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" }],
    ["missing defaultBranch", { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", authToken: "t" }],
    ["wrong-typed remoteUrl", { nickname: "Repo", remoteUrl: 7, defaultBranch: "main", authToken: "t" }],
  ];

  for (const [label, body] of badGitBodies) {
    it(`rejects POST /api/connections/git with ${label} as 400 and writes nothing`, async () => {
      const { app } = buildApp();
      const res = await request(app).post("/api/connections/git").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();

      const listed = await request(app).get("/api/connections");
      expect(listed.body).toEqual([]);
    });
  }

  describe("PATCH /api/connections/:id", () => {
    it("renames a connection", async () => {
      const { app, db } = buildApp();
      const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });

      const res = await request(app).patch(`/api/connections/${created.id}`).send({ nickname: "Dev (renamed)" });

      expect(res.status).toBe(200);
      expect(getConnectionRow(db, created.id).nickname).toBe("Dev (renamed)");
    });

    it("returns 404 for an unknown connection", async () => {
      const { app } = buildApp();
      const res = await request(app).patch("/api/connections/nonexistent-id").send({ nickname: "New" });
      expect(res.status).toBe(404);
    });

    it("rejects a missing or blank nickname as 400, writing nothing", async () => {
      const { app, db } = buildApp();
      const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });

      for (const body of [{}, { nickname: "" }, { nickname: "   " }, { nickname: 7 }]) {
        const res = await request(app).patch(`/api/connections/${created.id}`).send(body);
        expect(res.status).toBe(400);
      }
      expect(getConnectionRow(db, created.id).nickname).toBe("Dev");
    });
  });

  describe("POST /api/connections/:id/test", () => {
    it("tests an org connection by refreshing its token", async () => {
      const { app, db } = buildApp();
      const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
      vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({ accessToken: "a", instanceUrl: "https://x" });

      const res = await request(app).post(`/api/connections/${created.id}/test`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("reports a failed org token refresh without a 500", async () => {
      const { app, db } = buildApp();
      const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
      vi.spyOn(oauth, "refreshAccessToken").mockRejectedValue(new Error("invalid_grant"));

      const res = await request(app).post(`/api/connections/${created.id}/test`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, error: "invalid_grant" });
    });

    it("tests a git connection via testGitConnection, decrypting its stored auth token", async () => {
      const { app, db } = buildApp();
      const created = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "ghp_rawtoken" });
      const spy = vi.spyOn(gitConnections, "testGitConnection").mockResolvedValue({ ok: true });

      const res = await request(app).post(`/api/connections/${created.id}/test`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith({ remoteUrl: "https://github.com/x/y.git", authToken: "ghp_rawtoken" });
    });

    it("returns 404 for an unknown connection", async () => {
      const { app } = buildApp();
      const res = await request(app).post("/api/connections/nonexistent-id/test");
      expect(res.status).toBe(404);
    });
  });
});
