import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { buildOrgConnection } from "./sfConnection.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import { stripUnpackagedPrefix } from "./convert.js";
import { buildDestructiveChangesZip } from "./destructiveChanges.js";
import { getDeployment, type DeployComponentSelection } from "./deploy.js";
import type { Config } from "../config.js";

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

export async function rollbackDeployment(db: Database.Database, config: Config, deploymentId: string): Promise<string> {
  const original = getDeployment(db, deploymentId);
  if (!original) throw new Error(`No deployment with id ${deploymentId}`);
  if (original.status !== "succeeded") {
    throw new Error(`Cannot roll back a deployment that did not succeed (status: ${original.status})`);
  }
  // Both guards must reject BEFORE the rollback row is inserted below, otherwise every rejected
  // attempt leaves a junk history entry behind.
  if (original.validate_only) {
    // A validate-only run is a dry run: it never changed the target. "Rolling it back" would be a
    // real, destructive deploy — redeploying the snapshot and deleting components the dry run
    // never actually created.
    throw new Error("Cannot roll back a validate-only (dry run) deployment — it never changed the target");
  }
  if (original.target_connection_type !== "org") {
    // Rollback redeploys a metadata zip to an org; there is no equivalent for a git target
    // (the original deployment was a commit, which is reverted in git, not here).
    throw new Error("Cannot roll back a deployment whose target is not an org connection");
  }

  const components: DeployComponentSelection[] = original.components;
  const existingComponents = components.filter((c) => c.action !== "add");
  const addedComponents = components.filter((c) => c.action === "add");

  const rollbackId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, is_rollback_of)
     VALUES (?, ?, ?, ?, ?, 'deploying', 0, ?, ?)`
  ).run(rollbackId, original.target_connection_id, original.target_connection_id, JSON.stringify(components), original.test_level, now, deploymentId);

  for (const c of components) {
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(randomUUID(), rollbackId, c.type, c.fullName, c.action === "add" ? "delete" : c.action);
  }

  try {
    const targetConn = await buildOrgConnection(db, original.target_connection_id, config);

    if (existingComponents.length > 0) {
      if (!original.snapshot_path || !fs.existsSync(original.snapshot_path)) {
        throw new Error("No snapshot available to roll back to");
      }
      // The snapshot is raw retrieve output (everything nested under `unpackaged/`), but the
      // deploy below needs package.xml at the zip root.
      const snapshotZip = stripUnpackagedPrefix(fs.readFileSync(original.snapshot_path));
      const result = await deployZipToOrg(targetConn, snapshotZip, { testLevel: original.test_level, checkOnly: false });
      applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deploy of prior versions failed");
    }

    if (addedComponents.length > 0) {
      const destructiveZip = buildDestructiveChangesZip(addedComponents);
      const result = await deployZipToOrg(targetConn, destructiveZip, { testLevel: original.test_level, checkOnly: false });
      applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deletion of newly added components failed");
    }

    db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), rollbackId);
    // Transition the ORIGINAL deployment to 'rolled_back' too, not just the new rollback row:
    // it's what makes the re-rollback guard above (`original.status !== "succeeded"`) trip, so a
    // double-click or client retry can't fire a second real deploy at the live org. Only on
    // rollback SUCCESS — a failed rollback leaves the original 'succeeded' and retryable.
    db.prepare(`UPDATE deployments SET status = 'rolled_back' WHERE id = ?`).run(deploymentId);
  } catch (err) {
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = ?, error_detail = ? WHERE id = ?`).run(
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      rollbackId
    );
    throw err;
  }

  return rollbackId;
}
