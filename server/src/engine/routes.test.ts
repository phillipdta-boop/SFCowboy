import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createEngineRouter } from "./routes.js";
import * as sfConnection from "./sfConnection.js";
import * as orgComponents from "./orgComponents.js";
import * as gitConnections from "../connections/gitConnections.js";
import * as gitComponents from "./gitComponents.js";

process.env.ENCRYPTION_KEY = "e".repeat(64);

const config = {
  port: 3000, dbPath: ":memory:", encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
} as any;

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(createEngineRouter(db, config, "/tmp/sfcowboy-data"));
  return { app, db };
}

describe("GET /api/diff", () => {
  it("diffs an org source against a git target", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r" });
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "listOrgComponents").mockResolvedValue([{ type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-01" }]);
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([{ type: "ApexClass", fullName: "B" }]);

    const res = await request(app).get(`/api/diff?sourceConnectionId=${org.id}&targetConnectionId=${git.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "A", status: "added" },
        { type: "ApexClass", fullName: "B", status: "removed" },
      ])
    );
  });

  it("404s when a connection id doesn't exist", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/diff?sourceConnectionId=missing&targetConnectionId=alsomissing");
    expect(res.status).toBe(404);
  });
});
