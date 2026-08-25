import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getConnectionRow } from "../connections/orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "../connections/gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import { buildOrgConnection } from "./sfConnection.js";
import { retrieveOrgZip } from "./orgComponents.js";
import { convertZipToSourceDir, convertSourceDirToZip } from "./convert.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import type { Config } from "../config.js";

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

export function createDeployment(
  db: Database.Database,
  input: {
    sourceConnectionId: string;
    targetConnectionId: string;
    components: DeployComponentSelection[];
    testLevel: TestLevel;
    validateOnly: boolean;
  }
): string {
  const targetRow = getConnectionRow(db, input.targetConnectionId);
  const effectiveTestLevel: TestLevel =
    targetRow?.type === "org" && targetRow.org_type === "production" && input.testLevel === "NoTestRun"
      ? "RunLocalTests"
      : input.testLevel;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, input.sourceConnectionId, input.targetConnectionId, JSON.stringify(input.components), effectiveTestLevel, input.validateOnly ? 1 : 0, now);

  for (const c of input.components) {
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(randomUUID(), id, c.type, c.fullName, c.action);
  }
  return id;
}

export function getDeployment(db: Database.Database, id: string): any {
  const deployment: any = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(id);
  if (!deployment) return undefined;
  const items = db.prepare(`SELECT * FROM deployment_items WHERE deployment_id = ?`).all(id);
  return { ...deployment, components: JSON.parse(deployment.component_list), items };
}

export function listDeployments(db: Database.Database): any[] {
  return db.prepare(`SELECT * FROM deployments ORDER BY started_at DESC`).all();
}

function applyDeployResultToItems(
  db: Database.Database,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): void {
  for (const cr of componentResults) {
    db.prepare(
      `UPDATE deployment_items SET status = ?, error_message = ? WHERE deployment_id = ? AND metadata_type = ? AND api_name = ?`
    ).run(cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName);
  }
}

export async function runDeployment(db: Database.Database, config: Config, dataDir: string, deploymentId: string): Promise<void> {
  const deployment: any = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(deploymentId);
  const components: DeployComponentSelection[] = JSON.parse(deployment.component_list);
  const targetRow = getConnectionRow(db, deployment.target_connection_id);
  const sourceRow = getConnectionRow(db, deployment.source_connection_id);

  try {
    db.prepare(`UPDATE deployments SET status = 'validating' WHERE id = ?`).run(deploymentId);

    let snapshotPath: string | null = null;
    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const existing = components.filter((c) => c.action !== "add");
      if (existing.length > 0) {
        const snapshotZip = await retrieveOrgZip(targetConn, existing);
        snapshotPath = path.join(dataDir, "snapshots", `${deploymentId}.zip`);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, snapshotZip);
      }
    }
    db.prepare(`UPDATE deployments SET snapshot_path = ? WHERE id = ?`).run(snapshotPath, deploymentId);

    let zip: Buffer;
    if (sourceRow.type === "org") {
      const sourceConn = await buildOrgConnection(db, deployment.source_connection_id, config);
      zip = await retrieveOrgZip(sourceConn, components);
    } else {
      const sourceDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.source_connection_id,
        remoteUrl: sourceRow.remote_url,
        branch: sourceRow.default_branch,
        authToken: decrypt(sourceRow.encrypted_auth_token),
      });
      zip = await convertSourceDirToZip(sourceDir, components);
    }

    db.prepare(`UPDATE deployments SET status = 'deploying' WHERE id = ?`).run(deploymentId);

    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const result = await deployZipToOrg(targetConn, zip, { testLevel: deployment.test_level, checkOnly: !!deployment.validate_only });
      applyDeployResultToItems(db, deploymentId, result.componentResults);
      db.prepare(`UPDATE deployments SET status = ?, finished_at = ?, error_detail = ? WHERE id = ?`).run(
        result.success ? "succeeded" : "failed",
        new Date().toISOString(),
        result.success ? null : JSON.stringify(result),
        deploymentId
      );
    } else {
      const targetDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.target_connection_id,
        remoteUrl: targetRow.remote_url,
        branch: targetRow.default_branch,
        authToken: decrypt(targetRow.encrypted_auth_token),
      });
      await convertZipToSourceDir(zip, targetDir);
      await commitAllAndPush({
        dataDir,
        connectionId: deployment.target_connection_id,
        message: `SFCowboy deployment ${deploymentId}`,
        authToken: decrypt(targetRow.encrypted_auth_token),
      });
      db.prepare(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = ?`).run(deploymentId);
      db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), deploymentId);
    }
  } catch (err) {
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = ?, error_detail = ? WHERE id = ?`).run(
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      deploymentId
    );
  }
}
