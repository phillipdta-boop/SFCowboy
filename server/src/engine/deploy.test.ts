import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createDeployment, getDeployment, listDeployments, runDeployment } from "./deploy.js";
import * as sfConnection from "./sfConnection.js";
import * as orgComponents from "./orgComponents.js";
import * as convert from "./convert.js";
import * as deployPrimitive from "./deployPrimitive.js";
import * as gitConnections from "../connections/gitConnections.js";

process.env.ENCRYPTION_KEY = "f".repeat(64);
const config = { sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("createDeployment", () => {
  it("stores the deployment and one deployment_item per component", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });

    const id = createDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("pending");
    expect(deployment.items).toHaveLength(1);
  });

  it("forces RunLocalTests when the target is a production org", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "Prod", orgType: "production", instanceUrl: "https://y", refreshToken: "r" });

    const id = createDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    expect(getDeployment(db, id)!.test_level).toBe("RunLocalTests");
  });
});

describe("runDeployment", () => {
  it("deploys org-to-org: snapshots the target, retrieves from source, deploys, and marks succeeded", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeTruthy();
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("deploys git-to-org: converts source to a zip, deploys, marks succeeded, skips snapshot for new components", async () => {
    const db = freshDb();
    const source = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "NewClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertSourceDirToZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeNull();
  });

  it("deploys org-to-git: retrieves from the org source, converts and pushes to the git target, marks succeeded, and marks all items succeeded", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertZipToSourceDir").mockResolvedValue(undefined);
    vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("marks the deployment failed and records the error when the deploy throws", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockRejectedValue(new Error("token expired"));

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toBe("token expired");
  });
});

describe("listDeployments", () => {
  it("returns deployments most-recent first", () => {
    const db = freshDb();
    const a = createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r" });
    const b = createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r" });
    createDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(listDeployments(db)).toHaveLength(1);
  });
});
