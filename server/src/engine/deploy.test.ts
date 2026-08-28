import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import AdmZip from "adm-zip";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createGitConnection } from "../connections/gitConnections.js";
import {
  createDraftDeployment,
  attachComponentsAndQueue,
  updateDeploymentTitle,
  deleteDeployment,
  cloneDeployment,
  cancelDeployment,
  setRunBy,
  getDeployment,
  listDeployments,
  runDeployment,
  resolvePackageDir,
  type DeployComponentSelection,
  type TestLevel,
} from "./deploy.js";
import * as sfConnection from "./sfConnection.js";
import * as orgComponents from "./orgComponents.js";
import * as convert from "./convert.js";
import * as deployPrimitive from "./deployPrimitive.js";
import * as gitConnections from "../connections/gitConnections.js";

process.env.ENCRYPTION_KEY = "f".repeat(64);
const config = { oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-deploy-"));
});

// vitest doesn't restore spies between tests by default; without this a module mocked in one test
// (e.g. convertZipToSourceDir) stays mocked in the next, which would silently defeat the tests
// below that deliberately exercise the real implementation.
beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const APEX_BODY = "public class MyClass {}";
const APEX_META = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`;
const PACKAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>MyClass</members>\n    <name>ApexClass</name>\n  </types>\n  <version>61.0</version>\n</Package>\n`;

/**
 * A zip shaped like real Metadata API *retrieve* output: everything nested under a single
 * `unpackaged/` folder. Confirmed against the installed SDR, whose retrieve extraction reads
 * these zips with `zipTreeLocation: "unpackaged"`.
 */
function retrieveFormatZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("unpackaged/package.xml", Buffer.from(PACKAGE_XML));
  zip.addFile("unpackaged/classes/MyClass.cls", Buffer.from(APEX_BODY));
  zip.addFile("unpackaged/classes/MyClass.cls-meta.xml", Buffer.from(APEX_META));
  return zip.toBuffer();
}

function entryNames(zipBuffer: Buffer): string[] {
  return new AdmZip(zipBuffer).getEntries().map((e) => e.entryName);
}

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

// Most tests below (runDeployment, listDeployments, etc.) only care about ending up with a fully
// formed deployment ready to run — not about the create/attach split itself, which has its own
// dedicated tests below. This keeps their setup a one-liner.
function createFullDeployment(
  db: Database.Database,
  input: {
    sourceConnectionId: string;
    targetConnectionId: string;
    components: DeployComponentSelection[];
    testLevel: TestLevel;
    validateOnly: boolean;
    title?: string;
    ignoreWarnings?: boolean;
    allowMissingFiles?: boolean;
    autoUpdatePackage?: boolean;
    runTests?: string[];
  }
): string {
  const id = createDraftDeployment(db, {
    title: input.title,
    sourceConnectionId: input.sourceConnectionId,
    targetConnectionId: input.targetConnectionId,
  });
  attachComponentsAndQueue(db, id, {
    components: input.components,
    testLevel: input.testLevel,
    validateOnly: input.validateOnly,
    ignoreWarnings: input.ignoreWarnings,
    allowMissingFiles: input.allowMissingFiles,
    autoUpdatePackage: input.autoUpdatePackage,
    runTests: input.runTests,
  });
  return id;
}

describe("createDraftDeployment", () => {
  it("stores a pending deployment with no components yet", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("pending");
    expect(deployment.components).toEqual([]);
    expect(deployment.items).toHaveLength(0);
  });

  it("stores the given title, or null when omitted", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const titled = createDraftDeployment(db, { title: "Sprint 12 release", sourceConnectionId: source.id, targetConnectionId: target.id });
    expect(getDeployment(db, titled)!.title).toBe("Sprint 12 release");

    const untitled = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    expect(getDeployment(db, untitled)!.title).toBeNull();
  });
});

describe("attachComponentsAndQueue", () => {
  it("adds the components and a deployment_item per component to an existing draft", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    attachComponentsAndQueue(db, id, {
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
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "Prod", orgType: "production", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    expect(getDeployment(db, id)!.test_level).toBe("RunLocalTests");
  });

  // Called repeatedly as the user's selection changes while still editing a draft (autosave) —
  // each call must replace the previous selection, not pile duplicate items on top of it.
  it("replaces the previous component selection rather than appending to it when called again", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "First", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "Second", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    const deployment = getDeployment(db, id)!;
    expect(deployment.items).toHaveLength(1);
    expect(deployment.items[0].api_name).toBe("Second");
    expect(deployment.components).toEqual([{ type: "ApexClass", fullName: "Second", action: "modify" }]);
  });

  it("stores ignoreWarnings, allowMissingFiles, and autoUpdatePackage, defaulting each to false when omitted", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    let deployment = getDeployment(db, id)!;
    expect(deployment.ignore_warnings).toBe(0);
    expect(deployment.allow_missing_files).toBe(0);
    expect(deployment.auto_update_package).toBe(0);

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
      ignoreWarnings: true,
      allowMissingFiles: true,
      autoUpdatePackage: true,
    });
    deployment = getDeployment(db, id)!;
    expect(deployment.ignore_warnings).toBe(1);
    expect(deployment.allow_missing_files).toBe(1);
    expect(deployment.auto_update_package).toBe(1);
  });

  it("stores runTests as a parsed array, defaulting to empty when omitted", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunSpecifiedTests",
      validateOnly: false,
    });
    expect(getDeployment(db, id)!.run_tests).toEqual([]);

    attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunSpecifiedTests",
      validateOnly: false,
      runTests: ["MyClassTest", "OtherClassTest"],
    });
    expect(getDeployment(db, id)!.run_tests).toEqual(["MyClassTest", "OtherClassTest"]);
  });
});

describe("updateDeploymentTitle", () => {
  it("renames a deployment regardless of its status", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { title: "Old title", sourceConnectionId: source.id, targetConnectionId: target.id });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    updateDeploymentTitle(db, id, "New title");

    expect(getDeployment(db, id)!.title).toBe("New title");
  });

  it("throws for an unknown deployment id", () => {
    const db = freshDb();
    expect(() => updateDeploymentTitle(db, "unknown", "New title")).toThrow();
  });
});

describe("deleteDeployment", () => {
  it("removes the deployment and its items", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    deleteDeployment(db, id);

    expect(getDeployment(db, id)).toBeUndefined();
    expect(db.prepare(`SELECT * FROM deployment_items WHERE deployment_id = ?`).all(id)).toHaveLength(0);
  });

  it("throws for an unknown deployment id", () => {
    const db = freshDb();
    expect(() => deleteDeployment(db, "unknown")).toThrow();
  });
});

describe("cloneDeployment", () => {
  it("creates a fresh pending draft with the same source, target, title, and components", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const originalId = createFullDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests",
      validateOnly: true,
      title: "Sprint 12",
      ignoreWarnings: true,
      allowMissingFiles: true,
      autoUpdatePackage: true,
      runTests: ["MyClassTest"],
    });
    db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), originalId);
    db.prepare(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = ?`).run(originalId);

    const cloneId = cloneDeployment(db, originalId);

    expect(cloneId).not.toBe(originalId);
    const clone = getDeployment(db, cloneId)!;
    expect(clone.status).toBe("pending");
    expect(clone.title).toBe("Sprint 12");
    expect(clone.source_connection_id).toBe(source.id);
    expect(clone.target_connection_id).toBe(target.id);
    expect(clone.test_level).toBe("RunLocalTests");
    expect(clone.validate_only).toBe(1);
    expect(clone.finished_at).toBeNull();
    expect(clone.components).toEqual([{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);
    expect(clone.items).toHaveLength(1);
    expect(clone.items[0].status).toBe("pending");
    expect(clone.ignore_warnings).toBe(1);
    expect(clone.allow_missing_files).toBe(1);
    expect(clone.auto_update_package).toBe(1);
    expect(clone.run_tests).toEqual(["MyClassTest"]);

    // The original is untouched.
    expect(getDeployment(db, originalId)!.status).toBe("succeeded");
  });

  it("never carries the original's run_by over — a fresh draft hasn't been run yet", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    setRunBy(db, id, "Phillip");

    const cloneId = cloneDeployment(db, id);

    expect(getDeployment(db, cloneId)!.run_by).toBeNull();
  });

  it("throws for an unknown deployment id", () => {
    const db = freshDb();
    expect(() => cloneDeployment(db, "unknown")).toThrow();
  });
});

describe("cancelDeployment", () => {
  function orgPair(db: Database.Database) {
    return {
      source: createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("cancels the Salesforce job for an in-progress deployment that has one", async () => {
    const db = freshDb();
    const { source, target } = orgPair(db);
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    db.prepare(`UPDATE deployments SET status = 'deploying', sf_job_id = ? WHERE id = ?`).run("0Af000000deploy", id);

    const cancelDeploy = vi.fn().mockResolvedValue({ done: true });
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({ metadata: { cancelDeploy } } as any);

    await cancelDeployment(db, config, id);

    expect(cancelDeploy).toHaveBeenCalledWith("0Af000000deploy");
  });

  it("refuses to cancel a deployment that isn't in progress", async () => {
    const db = freshDb();
    const { source, target } = orgPair(db);
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    db.prepare(`UPDATE deployments SET status = 'succeeded' WHERE id = ?`).run(id);

    await expect(cancelDeployment(db, config, id)).rejects.toThrow(/in-progress/);
  });

  it("refuses to cancel before Salesforce has assigned a job id", async () => {
    const db = freshDb();
    const { source, target } = orgPair(db);
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    db.prepare(`UPDATE deployments SET status = 'validating' WHERE id = ?`).run(id);

    await expect(cancelDeployment(db, config, id)).rejects.toThrow(/nothing to cancel/);
  });
});

describe("setRunBy", () => {
  it("stores who ran the deployment", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    setRunBy(db, id, "Phillip");

    expect(getDeployment(db, id)!.run_by).toBe("Phillip");
  });

  it("clears it back to null", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    setRunBy(db, id, "Phillip");
    setRunBy(db, id, null);

    expect(getDeployment(db, id)!.run_by).toBeNull();
  });
});

describe("getDeployment", () => {
  it("reports the target connection's type alongside the deployment", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    expect(getDeployment(db, id)!.target_connection_type).toBe("git");
  });
});

describe("runDeployment", () => {
  it("deploys org-to-org: snapshots the target, retrieves from source, deploys, and marks succeeded", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeTruthy();
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("passes the stored ignoreWarnings/allowMissingFiles/autoUpdatePackage options through to the deploy call", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
      ignoreWarnings: true, allowMissingFiles: true, autoUpdatePackage: true,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    expect(deploySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ ignoreWarnings: true, allowMissingFiles: true, autoUpdatePackage: true }),
      undefined,
      undefined,
      expect.any(Function)
    );
  });

  it("passes the stored runTests list through to the deploy call", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunSpecifiedTests", validateOnly: false,
      runTests: ["MyClassTest", "OtherClassTest"],
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    expect(deploySpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ runTests: ["MyClassTest", "OtherClassTest"] }),
      undefined,
      undefined,
      expect.any(Function)
    );
  });

  it("persists live progress and the Salesforce job id as deployZipToOrg reports it", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockImplementation(async (_conn, _zip, _opts, _poll, _timeout, onProgress) => {
      onProgress?.({ jobId: "0Af000000deploy", numberComponentsDeployed: 0, numberComponentsTotal: 1, numberTestsCompleted: 0, numberTestsTotal: 0 });
      onProgress?.({ jobId: "0Af000000deploy", numberComponentsDeployed: 1, numberComponentsTotal: 1, numberTestsCompleted: 0, numberTestsTotal: 0 });
      return {
        success: true,
        jobId: "0Af000000deploy",
        status: "Succeeded",
        componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
      };
    });

    const runPromise = runDeployment(db, config, dataDir, id);
    await runPromise;

    const deployment = getDeployment(db, id)!;
    expect(deployment.sf_job_id).toBe("0Af000000deploy");
    expect(deployment.components_deployed).toBe(1);
    expect(deployment.components_total).toBe(1);
  });

  it("marks the deployment 'cancelled' rather than 'failed' when Salesforce reports the job as Canceled", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: false,
      jobId: "0Af000000deploy",
      status: "Canceled",
      componentResults: [],
    });

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("cancelled");
  });

  // Regression guard for the retrieve-vs-deploy zip-shape mismatch: retrieveOrgZip returns a zip
  // nested under `unpackaged/`, but deployZipToOrg deploys with `singlePackage: true`, which needs
  // package.xml at the ROOT. Every org-source deploy failed against a real org before this.
  it("normalises the retrieve-format source zip so package.xml is at the zip root before deploying", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    const [, deployedZip] = deploySpy.mock.calls[0];
    const names = entryNames(deployedZip as Buffer);
    expect(names).toContain("package.xml");
    expect(names).toContain("classes/MyClass.cls");
    expect(names.some((n) => n.startsWith("unpackaged/"))).toBe(false);
    // Content must survive the re-zip untouched.
    expect(new AdmZip(deployedZip as Buffer).readAsText("classes/MyClass.cls")).toBe(APEX_BODY);
  });

  it("deploys git-to-org: converts source to a zip, deploys, marks succeeded, skips snapshot for new components", async () => {
    const db = freshDb();
    const source = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "NewClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    // convertSourceDirToZip already emits a root-rooted metadata-format zip; it must be passed
    // through to the deploy untouched.
    const gitSourceZip = (() => {
      const zip = new AdmZip();
      zip.addFile("package.xml", Buffer.from(PACKAGE_XML));
      zip.addFile("classes/NewClass.cls", Buffer.from(APEX_BODY));
      return zip.toBuffer();
    })();
    vi.spyOn(convert, "convertSourceDirToZip").mockResolvedValue(gitSourceZip);
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeNull();
    expect(entryNames(deploySpy.mock.calls[0][1] as Buffer)).toContain("package.xml");
  });

  it("deploys org-to-git: retrieves from the org source, converts and pushes to the git target, marks succeeded, and marks all items succeeded", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertZipToSourceDir").mockResolvedValue(undefined);
    vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.items[0].status).toBe("succeeded");
  });

  // Regression guard: SDR's source converter prefixes output with `main/default`, so handing it
  // the clone ROOT wrote `<clone>/main/default/...` — a stray tree committed into the user's repo
  // that also made every subsequent diff see each component twice.
  it("writes org-to-git output under the target repo's package directory, not the clone root", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-clone-"));
    fs.writeFileSync(
      path.join(cloneDir, "sfdx-project.json"),
      JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "61.0" })
    );

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue(cloneDir);
    vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);
    // convertZipToSourceDir runs for real here — the whole point is where SDR puts the files.

    await runDeployment(db, config, dataDir, id);

    expect(getDeployment(db, id)!.status).toBe("succeeded");
    expect(fs.existsSync(path.join(cloneDir, "force-app", "main", "default", "classes", "MyClass.cls"))).toBe(true);
    // Nothing may be written to the stray `<clone>/main` tree.
    expect(fs.existsSync(path.join(cloneDir, "main"))).toBe(false);

    fs.rmSync(cloneDir, { recursive: true, force: true });
  });

  // Regression guard: a "delete" component is absent from the source by definition, so it used to
  // vanish silently from an org-source deploy (which then reported success) or blow up the whole
  // deployment on the git-source path. It now gets its own destructiveChanges.xml deploy.
  it("issues a real destructive-changes deploy for delete-actioned components", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [
        { type: "ApexClass", fullName: "MyClass", action: "modify" },
        { type: "ApexClass", fullName: "StaleClass", action: "delete" },
      ],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const retrieveSpy = vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    // Two deploys: the content zip, then the destructive one.
    expect(deploySpy).toHaveBeenCalledTimes(2);
    const destructiveZip = new AdmZip(deploySpy.mock.calls[1][1] as Buffer);
    const destructiveXml = destructiveZip.getEntry("destructiveChanges.xml")!.getData().toString("utf-8");
    expect(destructiveXml).toMatch(/<types>\s*<members>StaleClass<\/members>\s*<name>ApexClass<\/name>\s*<\/types>/);
    expect(destructiveXml).not.toContain("MyClass<");
    expect(destructiveZip.getEntry("package.xml")).toBeTruthy();

    // The delete component must not be requested from the source — it isn't there.
    const sourceRetrieveCall = retrieveSpy.mock.calls.at(-1)!;
    expect(sourceRetrieveCall[1]).toEqual([{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    const deleted = deployment.items.find((i: any) => i.api_name === "StaleClass");
    expect(deleted.status).toBe("succeeded");
  });

  it("marks the deployment failed when the destructive-changes deploy fails", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "StaleClass", action: "delete" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: false,
      jobId: "0Af000000deploy",
      status: "Failed",
      componentResults: [{ type: "ApexClass", fullName: "StaleClass", success: false, errorMessage: "cannot delete" }],
    });

    await runDeployment(db, config, dataDir, id);

    // Only the destructive deploy runs — there is no content to deploy.
    expect(deploySpy).toHaveBeenCalledTimes(1);
    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("failed");
    expect(deployment.items[0].status).toBe("failed");
    // error_detail must be a short, human-readable reason — not the raw DeployResult payload
    // (which would include every successful component alongside the failed one, plus job
    // bookkeeping like jobId/status).
    expect(JSON.parse(deployment.error_detail).message).toBe("ApexClass.StaleClass: cannot delete");
  });

  it("fails a deployment that asks to delete components from a git target", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "StaleClass", action: "delete" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const pushSpy = vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toMatch(/only supported for org targets/);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("marks the deployment failed and records the error when the deploy throws", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockRejectedValue(new Error("token expired"));

    await runDeployment(db, config, dataDir, id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toBe("token expired");
  });
});

describe("resolvePackageDir", () => {
  it("reads the default package directory from sfdx-project.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-pkgdir-"));
    fs.writeFileSync(
      path.join(dir, "sfdx-project.json"),
      JSON.stringify({ packageDirectories: [{ path: "unpackaged-src" }, { path: "my-app", default: true }] })
    );
    expect(resolvePackageDir(dir)).toBe("my-app");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to force-app when sfdx-project.json is missing or has no packageDirectories", () => {
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-pkgdir-"));
    expect(resolvePackageDir(missing)).toBe("force-app");

    fs.writeFileSync(path.join(missing, "sfdx-project.json"), JSON.stringify({ sourceApiVersion: "61.0" }));
    expect(resolvePackageDir(missing)).toBe("force-app");

    fs.rmSync(missing, { recursive: true, force: true });
  });
});

describe("listDeployments", () => {
  it("returns deployments most-recent first", () => {
    const db = freshDb();
    const a = createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    createFullDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(listDeployments(db)).toHaveLength(1);
  });

  // The History page lists every deployed component per run — that needs each row's items, but
  // fetching them one deployment at a time (an N+1 query per row) is exactly the kind of
  // per-item round trip this codebase has already paid for once (see listOrgComponents' batching
  // fix). A single bulk query grouped in memory avoids repeating that mistake here.
  it("attaches each deployment's own components, without mixing them across rows", () => {
    const db = freshDb();
    const a = createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    const first = createFullDeployment(db, {
      sourceConnectionId: a.id, targetConnectionId: b.id,
      components: [{ type: "ApexClass", fullName: "First", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    const second = createFullDeployment(db, {
      sourceConnectionId: a.id, targetConnectionId: b.id,
      components: [{ type: "ApexClass", fullName: "Second", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const deployments = listDeployments(db);
    const firstRow = deployments.find((d) => d.id === first)!;
    const secondRow = deployments.find((d) => d.id === second)!;
    expect(firstRow.items).toEqual([expect.objectContaining({ metadata_type: "ApexClass", api_name: "First" })]);
    expect(secondRow.items).toEqual([expect.objectContaining({ metadata_type: "ApexClass", api_name: "Second" })]);
  });

  it("gives a deployment with no components an empty items array, not undefined", () => {
    const db = freshDb();
    const a = createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    createFullDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(listDeployments(db)[0].items).toEqual([]);
  });
});
