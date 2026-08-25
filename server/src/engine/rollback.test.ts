import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createDeployment, getDeployment } from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";
import * as sfConnection from "./sfConnection.js";
import * as deployPrimitive from "./deployPrimitive.js";

process.env.ENCRYPTION_KEY = "9".repeat(64);
const config = { sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function succeededDeploymentWithSnapshot(db: any, snapshotPath: string, components: any[]) {
  const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
  const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
  const id = createDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components, testLevel: "NoTestRun", validateOnly: false });
  db.prepare(`UPDATE deployments SET status = 'succeeded', snapshot_path = ? WHERE id = ?`).run(snapshotPath, id);
  return { id, targetId: target.id };
}

describe("rollbackDeployment", () => {
  it("redeploys the pre-deploy snapshot for modified components", async () => {
    const db = freshDb();
    const snapshotPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-snap-")), "snapshot.zip");
    fs.writeFileSync(snapshotPath, "snapshot-zip-content");
    const { id } = succeededDeploymentWithSnapshot(db, snapshotPath, [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    expect(deploySpy).toHaveBeenCalledWith(expect.anything(), Buffer.from("snapshot-zip-content"), expect.objectContaining({ checkOnly: false }), );
    const rollback = getDeployment(db, rollbackId)!;
    expect(rollback.status).toBe("succeeded");
    expect(rollback.is_rollback_of).toBe(id);
  });

  it("issues a destructive-changes deploy for components that were newly added", async () => {
    const db = freshDb();
    const { id } = succeededDeploymentWithSnapshot(db, "", [{ type: "ApexClass", fullName: "NewClass", action: "add" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    const [, zipArg] = deploySpy.mock.calls[0];
    expect(zipArg.toString()).toContain("destructiveChanges");
    expect(getDeployment(db, rollbackId)!.status).toBe("succeeded");
  });

  it("throws and marks the rollback failed when no snapshot is available for modified components", async () => {
    const db = freshDb();
    const { id } = succeededDeploymentWithSnapshot(db, "", [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg");

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/snapshot/);
    expect(deploySpy).not.toHaveBeenCalled();

    const rollback = db.prepare(`SELECT * FROM deployments WHERE is_rollback_of = ?`).get(id) as any;
    expect(rollback.status).toBe("failed");
  });

  it("throws if the original deployment did not succeed", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components: [], testLevel: "NoTestRun", validateOnly: false });

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/did not succeed/);
  });
});
