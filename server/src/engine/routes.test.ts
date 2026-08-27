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
import * as deploy from "./deploy.js";
import { createDraftDeployment, attachComponentsAndQueue } from "./deploy.js";
import * as rollback from "./rollback.js";

process.env.ENCRYPTION_KEY = "e".repeat(64);

const config = {
  port: 3000, dbPath: ":memory:", encryptionKey: process.env.ENCRYPTION_KEY,
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
} as any;

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createEngineRouter(db, config, "/tmp/sfcowboy-data"));
  return { app, db };
}

describe("GET /api/diff", () => {
  it("diffs an org source against a git target", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r", clientId: "c" });
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "listOrgComponents").mockResolvedValue([{ type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-01" }]);
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([{ type: "ApexClass", fullName: "B" }]);

    const res = await request(app).get(`/api/diff?sourceConnectionId=${org.id}&targetConnectionId=${git.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "A", status: "added", lastModifiedDate: "2026-01-01" },
        { type: "ApexClass", fullName: "B", status: "removed" },
      ])
    );
  });

  it("404s when a connection id doesn't exist", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/diff?sourceConnectionId=missing&targetConnectionId=alsomissing");
    expect(res.status).toBe(404);
  });

  it("passes a comma-separated types filter through to both sides", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r", clientId: "c" });
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const listSpy = vi.spyOn(orgComponents, "listOrgComponents").mockResolvedValue([]);
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([
      { type: "ApexClass", fullName: "B" },
      { type: "CustomObject", fullName: "Excluded" },
    ]);

    const res = await request(app).get(
      `/api/diff?sourceConnectionId=${org.id}&targetConnectionId=${git.id}&types=ApexClass`
    );

    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(expect.anything(), { types: ["ApexClass"] });
    // The git side filters after listing; CustomObject is excluded, ApexClass stays.
    expect(res.body).toEqual([{ type: "ApexClass", fullName: "B", status: "removed" }]);
  });
});

describe("GET /api/metadata-types", () => {
  it("returns the org's describe-able type catalog for an org connection", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r", clientId: "c" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "describeAvailableTypes").mockResolvedValue(["ApexClass", "CustomObject"]);

    const res = await request(app).get(`/api/metadata-types?connectionId=${org.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(["ApexClass", "CustomObject"]);
  });

  it("returns the distinct types present in a git connection's source", async () => {
    const { app, db } = buildApp();
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([
      { type: "ApexClass", fullName: "A" },
      { type: "ApexClass", fullName: "B" },
      { type: "Flow", fullName: "C" },
    ]);

    const res = await request(app).get(`/api/metadata-types?connectionId=${git.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(["ApexClass", "Flow"]);
  });

  it("404s when the connection id doesn't exist", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/metadata-types?connectionId=missing");
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
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r", clientId: "c" });
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

describe("deployment routes", () => {
  it("creates a draft deployment without kicking off runDeployment", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/deployments")
      .send({ title: "Sprint 12", sourceConnectionId: source.id, targetConnectionId: target.id });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(runSpy).not.toHaveBeenCalled();

    const detail = await request(app).get(`/api/deployments/${res.body.id}`);
    expect(detail.body.status).toBe("pending");
    expect(detail.body.title).toBe("Sprint 12");
  });

  it("attaches components to a draft and kicks off runDeployment", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/deployments/${id}/run`)
      .send({
        components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
        testLevel: "NoTestRun",
      });

    expect(res.status).toBe(202);
    expect(res.body.id).toBe(id);
    expect(runSpy).toHaveBeenCalled();
  });

  it("404s a run request for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/deployments/unknown/run")
      .send({ components: [{ type: "ApexClass", fullName: "A", action: "add" }], testLevel: "NoTestRun" });
    expect(res.status).toBe(404);
  });

  it("returns deployment detail by id", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    attachComponentsAndQueue(db, id, { components: [], testLevel: "NoTestRun", validateOnly: false });

    const res = await request(app).get(`/api/deployments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/deployments/unknown");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/deployments/:id", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("saves the component selection to a pending draft without running it", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .patch(`/api/deployments/${id}`)
      .send({
        components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
        testLevel: "NoTestRun",
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(runSpy).not.toHaveBeenCalled();

    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.status).toBe("pending");
    expect(detail.body.components).toEqual([{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);
  });

  it("saves ignoreWarnings, allowMissingFiles, and autoUpdatePackage, defaulting each to false", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({
        components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
        testLevel: "NoTestRun",
        ignoreWarnings: true,
        allowMissingFiles: true,
        autoUpdatePackage: true,
      });

    let detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.ignore_warnings).toBe(1);
    expect(detail.body.allow_missing_files).toBe(1);
    expect(detail.body.auto_update_package).toBe(1);

    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }], testLevel: "NoTestRun" });

    detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.ignore_warnings).toBe(0);
    expect(detail.body.allow_missing_files).toBe(0);
    expect(detail.body.auto_update_package).toBe(0);
  });

  it("saves runTests, defaulting to an empty array", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({
        components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
        testLevel: "RunSpecifiedTests",
        runTests: ["MyClassTest", "OtherClassTest"],
      });

    let detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.run_tests).toEqual(["MyClassTest", "OtherClassTest"]);

    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }], testLevel: "NoTestRun" });

    detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.run_tests).toEqual([]);
  });

  it("allows saving a RunSpecifiedTests draft with no runTests yet, unlike running", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const res = await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }], testLevel: "RunSpecifiedTests" });

    expect(res.status).toBe(200);
  });

  it("rejects a malformed runTests value", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const bad = [
      { components: [], testLevel: "NoTestRun", runTests: "MyClassTest" },
      { components: [], testLevel: "NoTestRun", runTests: [123] },
      { components: [], testLevel: "NoTestRun", runTests: [""] },
    ];
    for (const body of bad) {
      const res = await request(app).patch(`/api/deployments/${id}`).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("replaces the saved selection on a second call rather than accumulating it", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "First", action: "modify" }], testLevel: "NoTestRun" });
    await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "Second", action: "modify" }], testLevel: "NoTestRun" });

    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.components).toEqual([{ type: "ApexClass", fullName: "Second", action: "modify" }]);
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0].api_name).toBe("Second");
  });

  it("allows saving an empty component selection, unlike running", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const res = await request(app).patch(`/api/deployments/${id}`).send({ components: [], testLevel: "NoTestRun" });

    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.components).toEqual([]);
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).patch("/api/deployments/unknown").send({ components: [], testLevel: "NoTestRun" });
    expect(res.status).toBe(404);
  });

  it("rejects saving once the deployment is no longer pending", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    const res = await request(app).patch(`/api/deployments/${id}`).send({ components: [], testLevel: "NoTestRun" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pending/);
  });

  it("rejects a malformed save body", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const res = await request(app)
      .patch(`/api/deployments/${id}`)
      .send({ components: [{ type: "ApexClass", fullName: "A", action: "purge" }], testLevel: "NoTestRun" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe("PATCH /api/deployments/:id/title", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("renames a deployment regardless of its status", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { title: "Old", sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    const res = await request(app).patch(`/api/deployments/${id}/title`).send({ title: "New title" });

    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.title).toBe("New title");
  });

  it("clears the title to null when sent an empty string", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { title: "Old", sourceConnectionId: source.id, targetConnectionId: target.id });

    await request(app).patch(`/api/deployments/${id}/title`).send({ title: "  " });

    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.title).toBeNull();
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).patch("/api/deployments/unknown/title").send({ title: "New" });
    expect(res.status).toBe(404);
  });

  it("rejects a non-string title", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const res = await request(app).patch(`/api/deployments/${id}/title`).send({ title: 123 });

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/deployments/:id", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("deletes a deployment", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const res = await request(app).delete(`/api/deployments/${id}`);

    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/deployments/${id}`)).status).toBe(404);
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).delete("/api/deployments/unknown");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deployments/:id/clone", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("creates a fresh pending draft copied from an existing deployment", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { title: "Sprint 12", sourceConnectionId: source.id, targetConnectionId: target.id });
    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    const res = await request(app).post(`/api/deployments/${id}/clone`);

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(id);

    const clone = await request(app).get(`/api/deployments/${res.body.id}`);
    expect(clone.body.status).toBe("pending");
    expect(clone.body.title).toBe("Sprint 12");
    expect(clone.body.components).toEqual([{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/deployments/unknown/clone");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deployments validation", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("rejects a malformed draft body with 400 and never creates a deployment", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);

    const bad: object[] = [
      { targetConnectionId: target.id },
      { sourceConnectionId: source.id },
      { sourceConnectionId: "unknown", targetConnectionId: target.id },
      { sourceConnectionId: source.id, targetConnectionId: "unknown" },
      { sourceConnectionId: source.id, targetConnectionId: target.id, title: 123 },
    ];

    for (const body of bad) {
      const res = await request(app).post("/api/deployments").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    }

    expect((await request(app).get("/api/deployments")).body).toEqual([]);
  });
});

describe("POST /api/deployments/:id/run validation", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("rejects a malformed body with 400 and never starts a deployment", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const bad: object[] = [
      { testLevel: "NoTestRun" },
      { components: [], testLevel: "NoTestRun" },
      { components: [{ type: "ApexClass", fullName: "A" }], testLevel: "NoTestRun" },
      { components: [{ type: "ApexClass", fullName: "A", action: "purge" }], testLevel: "NoTestRun" },
      { components: [{ type: "ApexClass", fullName: "A", action: "add" }], testLevel: "RunSomeTests" },
    ];

    for (const body of bad) {
      const res = await request(app).post(`/api/deployments/${id}/run`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    }

    expect(runSpy).not.toHaveBeenCalled();
  });

  // Deletion is a destructiveChanges.xml deploy against an org — there is no git equivalent.
  it("rejects a deployment that asks to delete components from a git target", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app).post(`/api/deployments/${id}/run`).send({
      components: [{ type: "ApexClass", fullName: "StaleClass", action: "delete" }],
      testLevel: "NoTestRun",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only supported for org targets/);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("accepts a delete-actioned component when the target is an org", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app).post(`/api/deployments/${id}/run`).send({
      components: [{ type: "ApexClass", fullName: "StaleClass", action: "delete" }],
      testLevel: "NoTestRun",
    });

    expect(res.status).toBe(202);
    expect(runSpy).toHaveBeenCalled();
  });

  it("rejects running RunSpecifiedTests with no runTests", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const bad = [
      { components: [{ type: "ApexClass", fullName: "A", action: "add" }], testLevel: "RunSpecifiedTests" },
      { components: [{ type: "ApexClass", fullName: "A", action: "add" }], testLevel: "RunSpecifiedTests", runTests: [] },
    ];
    for (const body of bad) {
      const res = await request(app).post(`/api/deployments/${id}/run`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/runTests/);
    }
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("runs RunSpecifiedTests when runTests is provided", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app).post(`/api/deployments/${id}/run`).send({
      components: [{ type: "ApexClass", fullName: "A", action: "add" }],
      testLevel: "RunSpecifiedTests",
      runTests: ["MyClassTest"],
    });

    expect(res.status).toBe(202);
    expect(runSpy).toHaveBeenCalled();
    const detail = await request(app).get(`/api/deployments/${id}`);
    expect(detail.body.run_tests).toEqual(["MyClassTest"]);
  });
});

describe("POST /api/deployments/:id/rerun", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("clones a finished deployment and immediately runs it with the currently edited selection", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/deployments/${id}/rerun`)
      .send({
        // A component added in the reopened editor, not present on the original deployment.
        components: [
          { type: "ApexClass", fullName: "MyClass", action: "modify" },
          { type: "ApexClass", fullName: "NewClass", action: "add" },
        ],
        testLevel: "NoTestRun",
        validateOnly: true,
      });

    expect(res.status).toBe(202);
    expect(res.body.id).not.toBe(id);
    expect(runSpy).toHaveBeenCalled();

    const original = await request(app).get(`/api/deployments/${id}`);
    expect(original.body.status).toBe("succeeded");

    const rerun = await request(app).get(`/api/deployments/${res.body.id}`);
    expect(rerun.body.validate_only).toBe(1);
    expect(rerun.body.components).toEqual([
      { type: "ApexClass", fullName: "MyClass", action: "modify" },
      { type: "ApexClass", fullName: "NewClass", action: "add" },
    ]);
  });

  it("rejects re-running a deployment that hasn't finished yet", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/deployments/${id}/rerun`)
      .send({ components: [], testLevel: "NoTestRun", validateOnly: false });

    expect(res.status).toBe(400);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/deployments/unknown/rerun")
      .send({ components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(res.status).toBe(404);
  });

  it("rejects a malformed body the same way /run does", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    const res = await request(app).post(`/api/deployments/${id}/rerun`).send({ components: [] });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/deployments/:id/cancel", () => {
  function orgPair(db: any) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("cancels an in-progress deployment", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'deploying', sf_job_id = 'job1' WHERE id = ?`).run(id);
    const cancelSpy = vi.spyOn(deploy, "cancelDeployment").mockResolvedValue(undefined);

    const res = await request(app).post(`/api/deployments/${id}/cancel`);

    expect(res.status).toBe(202);
    expect(cancelSpy).toHaveBeenCalledWith(db, expect.anything(), id);
  });

  it("surfaces a 400 when the deployment can't be cancelled", async () => {
    const { app, db } = buildApp();
    const { source, target } = orgPair(db);
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);
    vi.spyOn(deploy, "cancelDeployment").mockRejectedValue(new Error("Only an in-progress deployment can be cancelled"));

    const res = await request(app).post(`/api/deployments/${id}/cancel`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in-progress/);
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/deployments/unknown/cancel");
    expect(res.status).toBe(404);
  });
});

describe("rollback route", () => {
  it("triggers a rollback and returns the new deployment id", async () => {
    const { app } = buildApp();
    vi.spyOn(rollback, "rollbackDeployment").mockResolvedValue("rollback-id-123");

    const res = await request(app).post("/api/deployments/some-id/rollback");
    expect(res.status).toBe(202);
    expect(res.body.id).toBe("rollback-id-123");
  });

  it("returns 400 when rollback is not possible", async () => {
    const { app } = buildApp();
    vi.spyOn(rollback, "rollbackDeployment").mockRejectedValue(new Error("did not succeed"));

    const res = await request(app).post("/api/deployments/some-id/rollback");
    expect(res.status).toBe(400);
  });
});
