import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import AdmZip from "adm-zip";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createDraftDeployment, attachComponentsAndQueue, getDeployment } from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";
import * as sfConnection from "./sfConnection.js";
import * as deployPrimitive from "./deployPrimitive.js";

process.env.ENCRYPTION_KEY = "9".repeat(64);
const config = { oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

let testDb: TestDb;

beforeEach(async () => {
  vi.restoreAllMocks();
  testDb = await openTestDb();
});

afterEach(async () => {
  await testDb.stop();
});

async function createFullDeployment(
  db: Pool,
  input: { sourceConnectionId: string; targetConnectionId: string; components: any[]; testLevel: string; validateOnly: boolean }
): Promise<string> {
  const id = await createDraftDeployment(db, { sourceConnectionId: input.sourceConnectionId, targetConnectionId: input.targetConnectionId });
  await attachComponentsAndQueue(db, id, { components: input.components, testLevel: input.testLevel as any, validateOnly: input.validateOnly });
  return id;
}

const SNAPSHOT_APEX = "public class MyClass { Integer previous = 1; }";

/** A snapshot on disk is raw retrieve output: everything nested under `unpackaged/`. */
function writeRetrieveFormatSnapshot(): string {
  const snapshotPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-snap-")), "snapshot.zip");
  const zip = new AdmZip();
  zip.addFile("unpackaged/package.xml", Buffer.from("<Package/>"));
  zip.addFile("unpackaged/classes/MyClass.cls", Buffer.from(SNAPSHOT_APEX));
  fs.writeFileSync(snapshotPath, zip.toBuffer());
  return snapshotPath;
}

async function succeededDeploymentWithSnapshot(db: Pool, snapshotPath: string, components: any[]) {
  const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
  const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
  const id = await createFullDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components, testLevel: "NoTestRun", validateOnly: false });
  await db.query(`UPDATE deployments SET status = 'succeeded', snapshot_path = $1 WHERE id = $2`, [snapshotPath, id]);
  return { id, targetId: target.id };
}

describe("rollbackDeployment", () => {
  it("redeploys the pre-deploy snapshot for modified components", async () => {
    const db = testDb.pool;
    const snapshotPath = writeRetrieveFormatSnapshot();
    const { id } = await succeededDeploymentWithSnapshot(db, snapshotPath, [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][2]).toEqual(expect.objectContaining({ checkOnly: false }));
    const rollback = (await getDeployment(db, rollbackId))!;
    expect(rollback.status).toBe("succeeded");
    expect(rollback.is_rollback_of).toBe(id);
    expect((await getDeployment(db, id))!.status).toBe("rolled_back");
  });

  // Regression guard: the snapshot is retrieve output (`unpackaged/`-rooted), but deployZipToOrg
  // deploys with `singlePackage: true`, which needs package.xml at the ROOT. Every rollback
  // failed against a real org before this.
  it("normalises the retrieve-format snapshot so package.xml is at the zip root before redeploying", async () => {
    const db = testDb.pool;
    const snapshotPath = writeRetrieveFormatSnapshot();
    const { id } = await succeededDeploymentWithSnapshot(db, snapshotPath, [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await rollbackDeployment(db, config, id);

    const deployed = new AdmZip(deploySpy.mock.calls[0][1] as Buffer);
    const names = deployed.getEntries().map((e) => e.entryName);
    expect(names).toContain("package.xml");
    expect(names).toContain("classes/MyClass.cls");
    expect(names.some((n) => n.startsWith("unpackaged/"))).toBe(false);
    expect(deployed.readAsText("classes/MyClass.cls")).toBe(SNAPSHOT_APEX);
  });

  it("issues a destructive-changes deploy for components that were newly added, with correct XML content", async () => {
    const db = testDb.pool;
    const { id } = await succeededDeploymentWithSnapshot(db, "", [{ type: "ApexClass", fullName: "NewClass", action: "add" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    const [, zipArg] = deploySpy.mock.calls[0];
    expect(zipArg.toString()).toContain("destructiveChanges");

    const zip = new AdmZip(zipArg as Buffer);
    const destructiveChangesXml = zip.getEntry("destructiveChanges.xml")!.getData().toString("utf-8");
    expect(destructiveChangesXml).toContain("<members>NewClass</members>");
    expect(destructiveChangesXml).toContain("<name>ApexClass</name>");
    // members must be nested inside the ApexClass <types> block, not merely present anywhere in the file
    expect(destructiveChangesXml).toMatch(/<types>\s*<members>NewClass<\/members>\s*<name>ApexClass<\/name>\s*<\/types>/);
    expect(zip.getEntry("package.xml")).toBeTruthy();

    expect((await getDeployment(db, rollbackId))!.status).toBe("succeeded");
    expect((await getDeployment(db, id))!.status).toBe("rolled_back");
  });

  it("throws when attempting to roll back a deployment that has already been rolled back", async () => {
    const db = testDb.pool;
    const snapshotPath = writeRetrieveFormatSnapshot();
    const { id } = await succeededDeploymentWithSnapshot(db, snapshotPath, [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      jobId: "0Af000000deploy",
      status: "Succeeded",
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await rollbackDeployment(db, config, id);
    expect((await getDeployment(db, id))!.status).toBe("rolled_back");

    deploySpy.mockClear();
    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/did not succeed/);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("throws and marks the rollback failed when no snapshot is available for modified components", async () => {
    const db = testDb.pool;
    const { id } = await succeededDeploymentWithSnapshot(db, "", [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg");

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/snapshot/);
    expect(deploySpy).not.toHaveBeenCalled();

    const rollback = (await db.query(`SELECT * FROM deployments WHERE is_rollback_of = $1`, [id])).rows[0] as any;
    expect(rollback.status).toBe("failed");
  });

  it("throws if the original deployment did not succeed", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components: [], testLevel: "NoTestRun", validateOnly: false });

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/did not succeed/);
  });

  // Regression guard: a validate-only run ends 'succeeded' too, but it never touched the target.
  // Rolling one back would be a REAL destructive deploy against metadata a dry run never changed.
  it("refuses to roll back a validate-only deployment, without writing a rollback row", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: true,
    });
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [id]);

    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg");

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/validate-only/);
    expect(deploySpy).not.toHaveBeenCalled();
    // Nothing may be persisted: a rejected attempt must not leave junk history behind.
    const count = (await db.query(`SELECT COUNT(*)::int AS n FROM deployments WHERE is_rollback_of = $1`, [id])).rows[0];
    expect(count).toEqual({ n: 0 });
    expect((await getDeployment(db, id))!.status).toBe("succeeded");
  });

  // Regression guard: a git-target deployment used to crash partway through rollback, after the
  // rollback row had already been inserted — a junk history entry on every attempt.
  it("refuses to roll back a deployment whose target is a git connection, without writing a rollback row", async () => {
    const db = testDb.pool;
    const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const id = await createFullDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });
    await db.query(`UPDATE deployments SET status = 'succeeded' WHERE id = $1`, [id]);

    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg");

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/not an org connection/);
    expect(deploySpy).not.toHaveBeenCalled();
    const count = (await db.query(`SELECT COUNT(*)::int AS n FROM deployments WHERE is_rollback_of = $1`, [id])).rows[0];
    expect(count).toEqual({ n: 0 });
  });
});
