import { describe, it, expect, vi } from "vitest";
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

describe("GET /api/diff/content", () => {
  it("produces a file-level diff when both sides are git connections", async () => {
    const { app, db } = buildApp();
    const sourceGit = createGitConnection(db, { nickname: "Source Repo", remoteUrl: "https://github.com/x/source.git", defaultBranch: "main", authToken: "t" });
    const targetGit = createGitConnection(db, { nickname: "Target Repo", remoteUrl: "https://github.com/x/target.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(gitConnections, "ensureLocalClone").mockImplementation(async (opts: any) =>
      opts.connectionId === sourceGit.id ? "/tmp/source-clone" : "/tmp/target-clone"
    );
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([{ type: "ApexClass", fullName: "MyClass" }]);
    vi.spyOn(gitComponents, "readGitComponentFiles").mockImplementation((dir: string) =>
      dir === "/tmp/source-clone"
        ? [{ path: "/tmp/source-clone/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 2;\n}\n" }]
        : [{ path: "/tmp/target-clone/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 1;\n}\n" }]
    );

    const res = await request(app).get(
      `/api/diff/content?sourceConnectionId=${sourceGit.id}&targetConnectionId=${targetGit.id}&type=ApexClass&fullName=MyClass`
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].path).toBe("/tmp/source-clone/classes/MyClass.cls");
    expect(res.body[0].changes.some((c: any) => c.added && c.value.includes("x = 2"))).toBe(true);
    expect(res.body[0].changes.some((c: any) => c.removed && c.value.includes("x = 1"))).toBe(true);
  });

  it("returns an empty diff when the source side is an org connection (org-side content diffing is out of MVP scope)", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r" });
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "listOrgComponents").mockResolvedValue([{ type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-01" }]);
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([{ type: "ApexClass", fullName: "A" }]);
    vi.spyOn(gitComponents, "readGitComponentFiles").mockReturnValue([{ path: "/tmp/fake-clone/classes/A.cls", content: "public class A {}\n" }]);

    const res = await request(app).get(
      `/api/diff/content?sourceConnectionId=${org.id}&targetConnectionId=${git.id}&type=ApexClass&fullName=A`
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("404s when a connection id doesn't exist", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      "/api/diff/content?sourceConnectionId=missing&targetConnectionId=alsomissing&type=ApexClass&fullName=A"
    );
    expect(res.status).toBe(404);
  });
});
