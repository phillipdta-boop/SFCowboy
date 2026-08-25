import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getConnectionRow } from "../connections/orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "../connections/gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import { buildOrgConnection } from "./sfConnection.js";
import { retrieveOrgZip } from "./orgComponents.js";
import { convertZipToSourceDir, convertSourceDirToZip, stripUnpackagedPrefix } from "./convert.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import { buildDestructiveChangesZip } from "./destructiveChanges.js";
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
  // The target's connection type travels with the detail payload so callers (the rollback guard
  // and the UI's Roll back button) can tell an org target from a git one without a second lookup.
  const targetRow = getConnectionRow(db, deployment.target_connection_id);
  return {
    ...deployment,
    components: JSON.parse(deployment.component_list),
    items,
    target_connection_type: targetRow?.type ?? null,
  };
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

/**
 * Resolves the package directory a git target's source should be written into.
 *
 * SDR's source-format converter prefixes its output with `main/default`, so the converter's
 * output directory must be the package directory itself (`<clone>/force-app`) to land files at
 * the SFDX-standard `<clone>/force-app/main/default/...`. Passing the clone root instead writes
 * a stray `<clone>/main/default/...` tree, which then gets committed to the user's repo and makes
 * every later diff see each component twice.
 *
 * Reads `packageDirectories` from the clone's `sfdx-project.json`, preferring the entry flagged
 * `default`, and falls back to the SFDX convention `force-app` when the file or field is absent.
 */
export function resolvePackageDir(cloneDir: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cloneDir, "sfdx-project.json"), "utf-8"));
    const dirs: unknown = parsed?.packageDirectories;
    if (Array.isArray(dirs)) {
      const usable = dirs.filter((d: any) => d && typeof d.path === "string" && d.path.length > 0);
      const chosen = usable.find((d: any) => d.default) ?? usable[0];
      if (chosen) return chosen.path as string;
    }
  } catch {
    // Missing or unreadable sfdx-project.json — fall through to the SFDX default.
  }
  return "force-app";
}

function markPendingItemsSucceeded(db: Database.Database, deploymentId: string, components: DeployComponentSelection[]): void {
  for (const c of components) {
    db.prepare(
      `UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = ? AND metadata_type = ? AND api_name = ? AND status = 'pending'`
    ).run(deploymentId, c.type, c.fullName);
  }
}

export async function runDeployment(db: Database.Database, config: Config, dataDir: string, deploymentId: string): Promise<void> {
  const deployment: any = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(deploymentId);
  const components: DeployComponentSelection[] = JSON.parse(deployment.component_list);
  const targetRow = getConnectionRow(db, deployment.target_connection_id);
  const sourceRow = getConnectionRow(db, deployment.source_connection_id);

  // Components the user asked to REMOVE from the target never appear in the source, so they can't
  // ride along in the source zip — they need their own destructiveChanges.xml deploy. Splitting
  // them out here also stops convertSourceDirToZip's missing-component check from failing the
  // whole deployment over a component that is missing on purpose.
  const contentComponents = components.filter((c) => c.action !== "delete");
  const deleteComponents = components.filter((c) => c.action === "delete");

  try {
    if (deleteComponents.length > 0 && targetRow.type !== "org") {
      throw new Error("Deleting components is only supported for org targets");
    }

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

    let zip: Buffer | null = null;
    if (contentComponents.length > 0) {
      if (sourceRow.type === "org") {
        const sourceConn = await buildOrgConnection(db, deployment.source_connection_id, config);
        // A retrieve nests everything under `unpackaged/`; the deploy below needs package.xml at
        // the zip root, and convertZipToSourceDir wants a plain metadata-format tree.
        zip = stripUnpackagedPrefix(await retrieveOrgZip(sourceConn, contentComponents));
      } else {
        const sourceDir = await ensureLocalClone({
          dataDir,
          connectionId: deployment.source_connection_id,
          remoteUrl: sourceRow.remote_url,
          branch: sourceRow.default_branch,
          authToken: decrypt(sourceRow.encrypted_auth_token),
        });
        zip = await convertSourceDirToZip(sourceDir, contentComponents);
      }
    }

    db.prepare(`UPDATE deployments SET status = 'deploying' WHERE id = ?`).run(deploymentId);

    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const checkOnly = !!deployment.validate_only;
      const failures: unknown[] = [];

      if (zip) {
        const result = await deployZipToOrg(targetConn, zip, { testLevel: deployment.test_level, checkOnly });
        applyDeployResultToItems(db, deploymentId, result.componentResults);
        if (!result.success) failures.push(result);
      }

      if (deleteComponents.length > 0) {
        const destructiveZip = buildDestructiveChangesZip(deleteComponents);
        const result = await deployZipToOrg(targetConn, destructiveZip, { testLevel: deployment.test_level, checkOnly });
        applyDeployResultToItems(db, deploymentId, result.componentResults);
        if (result.success) {
          // Salesforce doesn't always echo a per-component result for a destructive delete;
          // a successful destructive deploy means every requested deletion went through.
          markPendingItemsSucceeded(db, deploymentId, deleteComponents);
        } else {
          failures.push(result);
        }
      }

      const success = failures.length === 0;
      db.prepare(`UPDATE deployments SET status = ?, finished_at = ?, error_detail = ? WHERE id = ?`).run(
        success ? "succeeded" : "failed",
        new Date().toISOString(),
        success ? null : JSON.stringify(failures.length === 1 ? failures[0] : failures),
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
      if (zip) {
        await convertZipToSourceDir(zip, path.join(targetDir, resolvePackageDir(targetDir)));
      }
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
