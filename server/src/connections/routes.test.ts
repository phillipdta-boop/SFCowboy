// server/src/connections/routes.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "./orgConnections.js";
import { createConnectionsRouter } from "./routes.js";

process.env.ENCRYPTION_KEY = "8".repeat(64); // NOTE: was "h" — invalid hex (only 0-9/a-f), see Task 13's ledger entry

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createConnectionsRouter(db));
  return { app, db };
}

describe("connections routes", () => {
  it("lists connections", async () => {
    const { app, db } = buildApp();
    createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nickname).toBe("Dev");
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
    const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
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
});
