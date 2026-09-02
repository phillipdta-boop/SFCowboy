import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import AdmZip from "adm-zip";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createOrgConnection, setMinCodeCoveragePercent } from "../connections/orgConnections.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createPipeline } from "../pipelines/pipelines.js";
import {
  createDraftDeployment,
  attachComponentsAndQueue,
  updateDeploymentTitle,
  deleteDeployment,
  cloneDeployment,
  cancelDeployment,
  setRunBy,
  scheduleDeployment,
  cancelSchedule,
  listDueScheduledDeployments,
  getDeployment,
  listDeployments,
  runDeployment,
  resolvePackageDir,
  tagDeploymentToPipelineStep,
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
let testDb: TestDb;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-deploy-"));
});

// vitest doesn't restore spies between tests by default; without this a module mocked in one test
// (e.g. convertZipToSourceDir) stays mocked in the next, which would silently defeat the tests
// below that deliberately exercise the real implementation.
beforeEach(async () => {
  vi.restoreAllMocks();
  testDb = await openTestDb();
});

afterEach(async () => {
  await testDb.stop();
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

// Most tests below (runDeployment, listDeployments, etc.) only care about ending up with a fully
// formed deployment ready to run — not about the create/attach split itself, which has its own
// dedicated tests below. This keeps their setup a one-liner.
async function createFullDeployment(
  db: Pool,
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
    sourceBranch?: string;
    targetBranch?: string;
  }
): Promise<string> {
  const id = await createDraftDeployment(db, {
    title: input.title,
    sourceConnectionId: input.sourceConnectionId,
    targetConnectionId: input.targetConnectionId,
    sourceBranch: input.sourceBranch,
    targetBranch: input.targetBranch,
  });
  await attachComponentsAndQueue(db, id, {
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
  it("stores a pending deployment with no components yet", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("pending");
    expect(deployment.components).toEqual([]);
    expect(deployment.items).toHaveLength(0);
  });

  it("stores the given title, or null when omitted", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const titled = await createDraftDeployment(db, { title: "Sprint 12 release", sourceConnectionId: source.id, targetConnectionId: target.id });
    expect((await getDeployment(db, titled))!.title).toBe("Sprint 12 release");

    const untitled = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    expect((await getDeployment(db, untitled))!.title).toBeNull();
  });

  it("stores an explicit branch override per side, or null when omitted", async () => {
    const db = testDb.pool;
    const source = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://x", defaultBranch: "main", authToken: "t" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });

    const withBranch = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, sourceBranch: "release/2026-08" });
    expect((await getDeployment(db, withBranch))!.source_branch).toBe("release/2026-08");
    expect((await getDeployment(db, withBranch))!.target_branch).toBeNull();

    const withoutBranch = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    expect((await getDeployment(db, withoutBranch))!.source_branch).toBeNull();
  });
});

/** A root-rooted (non-retrieve) mdapi-format zip, as an uploaded package would look. */
function mdapiFormatZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("package.xml", Buffer.from(PACKAGE_XML));
  zip.addFile("classes/MyClass.cls", Buffer.from(APEX_BODY));
  zip.addFile("classes/MyClass.cls-meta.xml", Buffer.from(APEX_META));
  return zip.toBuffer();
}

/** Writes a zip to disk and records it as a deployment's package_path directly — a stand-in for
 * what runDeployment itself persists there after resolving content from source. */
async function setPackagePath(db: Pool, deploymentId: string, zip: Buffer): Promise<string> {
  const packagePath = path.join(dataDir, "packages", `${deploymentId}.zip`);
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, zip);
  await db.query(`UPDATE deployments SET package_path = $1 WHERE id = $2`, [packagePath, deploymentId]);
  return packagePath;
}

describe("attachComponentsAndQueue", () => {
  it("adds the components and a deployment_item per component to an existing draft", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("pending");
    expect(deployment.items).toHaveLength(1);
  });

  it("forces RunLocalTests when the target is a production org", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "Prod", orgType: "production", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    expect((await getDeployment(db, id))!.test_level).toBe("RunLocalTests");
  });

  // Called repeatedly as the user's selection changes while still editing a draft (autosave) —
  // each call must replace the previous selection, not pile duplicate items on top of it.
  it("replaces the previous component selection rather than appending to it when called again", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "First", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "Second", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.items).toHaveLength(1);
    expect(deployment.items[0].api_name).toBe("Second");
    expect(deployment.components).toEqual([{ type: "ApexClass", fullName: "Second", action: "modify" }]);
  });

  it("stores ignoreWarnings, allowMissingFiles, and autoUpdatePackage, defaulting each to false when omitted", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });
    let deployment = (await getDeployment(db, id))!;
    expect(deployment.ignore_warnings).toBe(0);
    expect(deployment.allow_missing_files).toBe(0);
    expect(deployment.auto_update_package).toBe(0);

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
      ignoreWarnings: true,
      allowMissingFiles: true,
      autoUpdatePackage: true,
    });
    deployment = (await getDeployment(db, id))!;
    expect(deployment.ignore_warnings).toBe(1);
    expect(deployment.allow_missing_files).toBe(1);
    expect(deployment.auto_update_package).toBe(1);
  });

  it("stores runTests as a parsed array, defaulting to empty when omitted", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunSpecifiedTests",
      validateOnly: false,
    });
    expect((await getDeployment(db, id))!.run_tests).toEqual([]);

    await attachComponentsAndQueue(db, id, {
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunSpecifiedTests",
      validateOnly: false,
      runTests: ["MyClassTest", "OtherClassTest"],
    });
    expect((await getDeployment(db, id))!.run_tests).toEqual(["MyClassTest", "OtherClassTest"]);
  });
});

describe("updateDeploymentTitle", () => {
  it("renames a deployment regardless of its status", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { title: "Old title", sourceConnectionId: source.id, targetConnectionId: target.id });
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [id]);

    await updateDeploymentTitle(db, id, "New title");

    expect((await getDeployment(db, id))!.title).toBe("New title");
  });

  it("throws for an unknown deployment id", async () => {
    const db = testDb.pool;
    await expect(updateDeploymentTitle(db, "unknown", "New title")).rejects.toThrow();
  });
});

describe("deleteDeployment", () => {
  it("removes the deployment and its items", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    await deleteDeployment(db, id);

    expect(await getDeployment(db, id)).toBeUndefined();
    expect((await db.query(`SELECT * FROM deployment_items WHERE deployment_id = $1`, [id])).rows).toHaveLength(0);
  });

  it("throws for an unknown deployment id", async () => {
    const db = testDb.pool;
    await expect(deleteDeployment(db, "unknown")).rejects.toThrow();
  });
});

describe("cloneDeployment", () => {
  it("carries over the source/target branch overrides", async () => {
    const db = testDb.pool;
    const source = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://x", defaultBranch: "main", authToken: "t" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const originalId = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, sourceBranch: "release/2026-08" });

    const cloneId = await cloneDeployment(db, originalId);

    expect((await getDeployment(db, cloneId))!.source_branch).toBe("release/2026-08");
  });

  it("does NOT carry over a normal deployment's package_path — re-running should re-resolve fresh content from its source", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const originalId = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await db.query(`UPDATE deployments SET package_path = '/tmp/some-old-package.zip' WHERE id = $1`, [originalId]);

    const cloneId = await cloneDeployment(db, originalId);

    expect((await getDeployment(db, cloneId))!.package_path).toBeNull();
  });

  it("does NOT carry over package_path regardless of how it was set on the original", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const originalId = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    await setPackagePath(db, originalId, mdapiFormatZip());

    const cloneId = await cloneDeployment(db, originalId);

    expect((await getDeployment(db, originalId))!.package_path).toBeTruthy();
    expect((await getDeployment(db, cloneId))!.package_path).toBeNull();
  });

  it("creates a fresh pending draft with the same source, target, title, and components", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const originalId = await createFullDeployment(db, {
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
    await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), originalId]);
    await db.query(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1`, [originalId]);

    const cloneId = await cloneDeployment(db, originalId);

    expect(cloneId).not.toBe(originalId);
    const clone = (await getDeployment(db, cloneId))!;
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
    expect((await getDeployment(db, originalId))!.status).toBe("succeeded");
  });

  it("never carries the original's run_by over — a fresh draft hasn't been run yet", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await setRunBy(db, id, "Phillip");

    const cloneId = await cloneDeployment(db, id);

    expect((await getDeployment(db, cloneId))!.run_by).toBeNull();
  });

  it("throws for an unknown deployment id", async () => {
    const db = testDb.pool;
    await expect(cloneDeployment(db, "unknown")).rejects.toThrow();
  });
});

describe("cancelDeployment", () => {
  async function orgPair(db: Pool) {
    return {
      source: await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" }),
      target: await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" }),
    };
  }

  it("cancels the Salesforce job for an in-progress deployment that has one", async () => {
    const db = testDb.pool;
    const { source, target } = await orgPair(db);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await db.query(`UPDATE deployments SET status = 'deploying', sf_job_id = $1 WHERE id = $2`, ["0Af000000deploy", id]);

    const cancelDeploy = vi.fn().mockResolvedValue({ done: true });
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({ metadata: { cancelDeploy } } as any);

    await cancelDeployment(db, config, id);

    expect(cancelDeploy).toHaveBeenCalledWith("0Af000000deploy");
  });

  it("refuses to cancel a deployment that isn't in progress", async () => {
    const db = testDb.pool;
    const { source, target } = await orgPair(db);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [id]);

    await expect(cancelDeployment(db, config, id)).rejects.toThrow(/in-progress/);
  });

  it("refuses to cancel before Salesforce has assigned a job id", async () => {
    const db = testDb.pool;
    const { source, target } = await orgPair(db);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await db.query(`UPDATE deployments SET status = 'validating' WHERE id = $1`, [id]);

    await expect(cancelDeployment(db, config, id)).rejects.toThrow(/nothing to cancel/);
  });
});

describe("setRunBy", () => {
  it("stores who ran the deployment", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    await setRunBy(db, id, "Phillip");

    expect((await getDeployment(db, id))!.run_by).toBe("Phillip");
  });

  it("clears it back to null", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    await setRunBy(db, id, "Phillip");
    await setRunBy(db, id, null);

    expect((await getDeployment(db, id))!.run_by).toBeNull();
  });
});

describe("scheduleDeployment / cancelSchedule / listDueScheduledDeployments", () => {
  async function pendingDraft(db: Pool): Promise<string> {
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    return createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
  }

  it("sets scheduled_at and run_by (attribution captured at schedule time) on a pending draft", async () => {
    const db = testDb.pool;
    const id = await pendingDraft(db);

    await scheduleDeployment(db, id, "2026-09-01T09:00:00.000Z", "Phillip");

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.scheduled_at).toBe("2026-09-01T09:00:00.000Z");
    expect(deployment.run_by).toBe("Phillip");
  });

  it("rejects scheduling a deployment that isn't pending", async () => {
    const db = testDb.pool;
    const id = await pendingDraft(db);
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [id]);

    await expect(scheduleDeployment(db, id, "2026-09-01T09:00:00.000Z", null)).rejects.toThrow(/pending/i);
  });

  it("throws for an unknown deployment id", async () => {
    const db = testDb.pool;
    await expect(scheduleDeployment(db, "unknown", "2026-09-01T09:00:00.000Z", null)).rejects.toThrow();
  });

  it("cancels a schedule, leaving the draft itself untouched", async () => {
    const db = testDb.pool;
    const id = await pendingDraft(db);
    await scheduleDeployment(db, id, "2026-09-01T09:00:00.000Z", "Phillip");

    await cancelSchedule(db, id);

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.scheduled_at).toBeNull();
    expect(deployment.status).toBe("pending");
  });

  it("rejects cancelling when nothing is scheduled", async () => {
    const db = testDb.pool;
    const id = await pendingDraft(db);
    await expect(cancelSchedule(db, id)).rejects.toThrow(/isn't currently scheduled/i);
  });

  it("lists only pending deployments whose scheduled time has already passed", async () => {
    const db = testDb.pool;
    const due = await pendingDraft(db);
    const notYetDue = await pendingDraft(db);
    const noSchedule = await pendingDraft(db);
    const alreadyRan = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    await scheduleDeployment(db, notYetDue, "2099-01-01T00:00:00.000Z", null);
    await scheduleDeployment(db, alreadyRan, "2026-01-01T00:00:00.000Z", null);
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [alreadyRan]);
    void noSchedule;

    const dueIds = await listDueScheduledDeployments(db, new Date("2026-06-01T00:00:00.000Z"));

    expect(dueIds).toEqual([due]);
  });
});

describe("tagDeploymentToPipelineStep", () => {
  it("sets pipeline_run_id and pipeline_step_index on the deployment row", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    // deployments.pipeline_run_id carries a real FK to pipeline_runs(id), so the tagged id must
    // reference an actual run rather than an arbitrary string.
    const pipeline = await createPipeline(db, { name: "Main", connectionIds: [source.id, target.id] });
    // This inserts the one row this test needs directly, mirroring createPipelineRun's own INSERT
    // exactly, to keep this test focused on tagDeploymentToPipelineStep's own contract.
    const runId = randomUUID();
    await db.query(
      `INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [runId, pipeline.id, null, JSON.stringify([{ type: "ApexClass", fullName: "MyClass" }]), new Date().toISOString()]
    );

    await tagDeploymentToPipelineStep(db, id, runId, 2);

    const row = (await getDeployment(db, id))!;
    expect(row.pipeline_run_id).toBe(runId);
    expect(row.pipeline_step_index).toBe(2);
  });
});

describe("getDeployment", () => {
  it("reports the target connection's type alongside the deployment", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    expect((await getDeployment(db, id))!.target_connection_type).toBe("git");
  });
});

describe("runDeployment", () => {
  it("deploys org-to-org: snapshots the target, retrieves from source, deploys, and marks succeeded", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeTruthy();
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("passes the stored ignoreWarnings/allowMissingFiles/autoUpdatePackage options through to the deploy call", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    await runDeployment(db, config, dataDir, id);

    // onProgress is deliberately fire-and-forget (`void db.query(...)`), so the persisted values
    // aren't guaranteed to be visible the instant runDeployment's own await resolves — wait for
    // them to show up rather than asserting immediately.
    await vi.waitFor(async () => {
      const deployment = (await getDeployment(db, id))!;
      expect(deployment.sf_job_id).toBe("0Af000000deploy");
      expect(deployment.components_deployed).toBe(1);
      expect(deployment.components_total).toBe(1);
    });
  });

  it("marks the deployment 'cancelled' rather than 'failed' when Salesforce reports the job as Canceled", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("cancelled");
  });

  // Regression guard for the retrieve-vs-deploy zip-shape mismatch: retrieveOrgZip returns a zip
  // nested under `unpackaged/`, but deployZipToOrg deploys with `singlePackage: true`, which needs
  // package.xml at the ROOT. Every org-source deploy failed against a real org before this.
  it("normalises the retrieve-format source zip so package.xml is at the zip root before deploying", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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
    const db = testDb.pool;
    const source = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeNull();
    expect(entryNames(deploySpy.mock.calls[0][1] as Buffer)).toContain("package.xml");
  });

  it("clones the git source at its overridden branch instead of the connection's own default", async () => {
    const db = testDb.pool;
    const source = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "NewClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
      sourceBranch: "release/2026-08",
    });

    const cloneSpy = vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertSourceDirToZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    expect(cloneSpy).toHaveBeenCalledWith(expect.objectContaining({ branch: "release/2026-08" }));
  });

  it("deploys org-to-git: retrieves from the org source, converts and pushes to the git target, marks succeeded, and marks all items succeeded", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("clones the git target at its overridden branch instead of the connection's own default", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
      targetBranch: "staging",
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const cloneSpy = vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertZipToSourceDir").mockResolvedValue(undefined);
    vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);

    await runDeployment(db, config, dataDir, id);

    expect(cloneSpy).toHaveBeenCalledWith(expect.objectContaining({ branch: "staging" }));
  });

  // Regression guard: SDR's source converter prefixes output with `main/default`, so handing it
  // the clone ROOT wrote `<clone>/main/default/...` — a stray tree committed into the user's repo
  // that also made every subsequent diff see each component twice.
  it("writes org-to-git output under the target repo's package directory, not the clone root", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
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

    expect((await getDeployment(db, id))!.status).toBe("succeeded");
    expect(fs.existsSync(path.join(cloneDir, "force-app", "main", "default", "classes", "MyClass.cls"))).toBe(true);
    // Nothing may be written to the stray `<clone>/main` tree.
    expect(fs.existsSync(path.join(cloneDir, "main"))).toBe(false);

    fs.rmSync(cloneDir, { recursive: true, force: true });
  });

  // Regression guard: a "delete" component is absent from the source by definition, so it used to
  // vanish silently from an org-source deploy (which then reported success) or blow up the whole
  // deployment on the git-source path. It now gets its own destructiveChanges.xml deploy.
  it("issues a real destructive-changes deploy for delete-actioned components", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    const deleted = deployment.items.find((i: any) => i.api_name === "StaleClass");
    expect(deleted.status).toBe("succeeded");
  });

  it("marks the deployment failed when the destructive-changes deploy fails", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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
    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("failed");
    expect(deployment.items[0].status).toBe("failed");
    // error_detail must be a short, human-readable reason — not the raw DeployResult payload
    // (which would include every successful component alongside the failed one, plus job
    // bookkeeping like jobId/status).
    expect(JSON.parse(deployment.error_detail).message).toBe("ApexClass.StaleClass: cannot delete");
  });

  it("fails a deployment that asks to delete components from a git target", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "StaleClass", action: "delete" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const pushSpy = vi.spyOn(gitConnections, "commitAllAndPush").mockResolvedValue(undefined);

    await runDeployment(db, config, dataDir, id);

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toMatch(/only supported for org targets/);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("marks the deployment failed and records the error when the deploy throws", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockRejectedValue(new Error("token expired"));

    await runDeployment(db, config, dataDir, id);

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toBe("token expired");
  });
});

describe("runDeployment — coverage gate", () => {
  it("persists the coverage percentage and per-class details even when no gate is configured", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
      coveragePercent: 42,
      codeCoverage: [{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 6 }],
    });

    await runDeployment(db, config, dataDir, id);

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.coverage_percent).toBe(42);
    expect(JSON.parse(deployment.coverage_details)).toEqual([{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 6 }]);
  });

  it("does not gate a real deploy when coverage is at or above the target's minimum", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    await setMinCodeCoveragePercent(db, target.id, 80);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
      coveragePercent: 80,
      codeCoverage: [{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 2 }],
    });

    await runDeployment(db, config, dataDir, id);

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.error_detail).toBeNull();
  });

  it("blocks a validate-only run whose coverage falls below the target's minimum, without touching the org", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    await setMinCodeCoveragePercent(db, target.id, 80);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests", validateOnly: true,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
      coveragePercent: 60,
      codeCoverage: [{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 4 }],
    });

    await runDeployment(db, config, dataDir, id);

    expect(deploySpy).toHaveBeenCalledTimes(1); // never redeployed/rolled back — it was a dry run
    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toMatch(/Coverage gate: 60.*80/);
  });

  it("auto-rolls-back a real deploy whose coverage falls below the target's minimum", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    await setMinCodeCoveragePercent(db, target.id, 80);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    // Every deployZipToOrg call (the main deploy AND the rollback's own reverse deploy) reports
    // the same low coverage — coverage is only ever read from the FIRST call by the gate check, so
    // this is enough to exercise both without needing to distinguish which call is which.
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
      coveragePercent: 60,
      codeCoverage: [{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 4 }],
    });

    await runDeployment(db, config, dataDir, id);

    const original = (await getDeployment(db, id))!;
    expect(original.status).toBe("rolled_back");
    expect(JSON.parse(original.error_detail).message).toMatch(/Coverage gate: 60.*80/);
    expect(original.coverage_percent).toBe(60);

    const all = await listDeployments(db);
    const rollbackRow = all.find((d) => d.is_rollback_of === id);
    expect(rollbackRow).toBeTruthy();
    expect(rollbackRow!.status).toBe("succeeded");
  });

  it("leaves the deployment 'succeeded' with both failures explained when the auto-rollback attempt itself fails", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    await setMinCodeCoveragePercent(db, target.id, 80);
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "RunLocalTests", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    vi.spyOn(deployPrimitive, "deployZipToOrg")
      // 1st call: the main deploy — succeeds, but under the coverage threshold.
      .mockResolvedValueOnce({
        success: true,
        jobId: "0Af000000deploy",
        status: "Succeeded",
        componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
        coveragePercent: 60,
        codeCoverage: [{ name: "MyClass", numLocations: 10, numLocationsNotCovered: 4 }],
      })
      // 2nd call: rollbackDeployment's own reverse deploy — fails.
      .mockResolvedValueOnce({
        success: false,
        jobId: "0Af000000rollback",
        status: "Failed",
        componentResults: [{ type: "ApexClass", fullName: "MyClass", success: false, errorMessage: "org is locked" }],
      });

    await runDeployment(db, config, dataDir, id);

    const original = (await getDeployment(db, id))!;
    expect(original.status).toBe("succeeded");
    const message = JSON.parse(original.error_detail).message;
    expect(message).toMatch(/Coverage gate: 60.*80/);
    expect(message).toMatch(/Automatic rollback also failed/);
  });
});

describe("runDeployment — static analysis", () => {
  it("persists findings for the content actually being deployed, without affecting the outcome", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      // APEX_BODY ("public class MyClass {}") has no sharing declaration, so retrieveFormatZip's
      // content is expected to trip the missing-sharing rule once deployed.
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.status).toBe("succeeded");
    const findings = JSON.parse(deployment.static_analysis_findings);
    expect(findings).toContainEqual(expect.objectContaining({ file: "classes/MyClass.cls", rule: "missing-sharing" }));
  });

  it("leaves static_analysis_findings null when nothing is flagged", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const cleanZip = (() => {
      const zip = new AdmZip();
      zip.addFile("unpackaged/package.xml", Buffer.from(PACKAGE_XML));
      zip.addFile("unpackaged/classes/MyClass.cls", Buffer.from("public with sharing class MyClass {}"));
      zip.addFile("unpackaged/classes/MyClass.cls-meta.xml", Buffer.from(APEX_META));
      return zip.toBuffer();
    })();

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(cleanZip);
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    expect((await getDeployment(db, id))!.static_analysis_findings).toBeNull();
  });
});

describe("runDeployment — package_path", () => {
  it("persists the resolved zip as package_path, so it can be exported later", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
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

    const deployment = (await getDeployment(db, id))!;
    expect(deployment.package_path).toBeTruthy();
    expect(fs.existsSync(deployment.package_path)).toBe(true);
    // The resolved zip is normalized (unpackaged/ prefix stripped) before it's saved.
    expect(entryNames(fs.readFileSync(deployment.package_path))).toContain("classes/MyClass.cls");
  });

  it("reuses an already-set package_path instead of resolving from the source connection", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
    const uploaded = mdapiFormatZip();
    await setPackagePath(db, id, uploaded);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const retrieveSpy = vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(retrieveFormatZip());
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, dataDir, id);

    expect((await getDeployment(db, id))!.status).toBe("succeeded");
    // No source connection to retrieve from — the deploy must have used the uploaded zip as-is.
    expect(retrieveSpy).not.toHaveBeenCalled();
    expect(deploySpy).toHaveBeenCalledWith(expect.anything(), uploaded, expect.anything(), undefined, undefined, expect.any(Function));
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
  it("returns deployments most-recent first", async () => {
    const db = testDb.pool;
    const a = await createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = await createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    await createFullDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(await listDeployments(db)).toHaveLength(1);
  });

  // The History page lists every deployed component per run — that needs each row's items, but
  // fetching them one deployment at a time (an N+1 query per row) is exactly the kind of
  // per-item round trip this codebase has already paid for once (see listOrgComponents' batching
  // fix). A single bulk query grouped in memory avoids repeating that mistake here.
  it("attaches each deployment's own components, without mixing them across rows", async () => {
    const db = testDb.pool;
    const a = await createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = await createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    const first = await createFullDeployment(db, {
      sourceConnectionId: a.id, targetConnectionId: b.id,
      components: [{ type: "ApexClass", fullName: "First", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    const second = await createFullDeployment(db, {
      sourceConnectionId: a.id, targetConnectionId: b.id,
      components: [{ type: "ApexClass", fullName: "Second", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    const deployments = await listDeployments(db);
    const firstRow = deployments.find((d) => d.id === first)!;
    const secondRow = deployments.find((d) => d.id === second)!;
    expect(firstRow.items).toEqual([expect.objectContaining({ metadata_type: "ApexClass", api_name: "First" })]);
    expect(secondRow.items).toEqual([expect.objectContaining({ metadata_type: "ApexClass", api_name: "Second" })]);
  });

  it("gives a deployment with no components an empty items array, not undefined", async () => {
    const db = testDb.pool;
    const a = await createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r", clientId: "c" });
    const b = await createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r", clientId: "c" });
    await createFullDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect((await listDeployments(db))[0].items).toEqual([]);
  });
});
