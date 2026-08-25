import { randomUUID } from "node:crypto";
import fs from "node:fs";
import AdmZip from "adm-zip";
import type Database from "better-sqlite3";
import { buildOrgConnection } from "./sfConnection.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import { getDeployment, type DeployComponentSelection } from "./deploy.js";
import type { Config } from "../config.js";

function buildDestructiveChangesZip(components: DeployComponentSelection[]): Buffer {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.fullName);
  }
  const typesXml = Array.from(byType.entries())
    .map(
      ([name, members]) =>
        `  <types>\n${members.map((m) => `    <members>${m}</members>`).join("\n")}\n    <name>${name}</name>\n  </types>`
    )
    .join("\n");

  const destructiveChangesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n</Package>\n`;
  const emptyPackageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>61.0</version>\n</Package>\n`;

  const zip = new AdmZip();
  zip.addFile("destructiveChanges.xml", Buffer.from(destructiveChangesXml));
  zip.addFile("package.xml", Buffer.from(emptyPackageXml));
  return zip.toBuffer();
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

export async function rollbackDeployment(db: Database.Database, config: Config, deploymentId: string): Promise<string> {
  const original = getDeployment(db, deploymentId);
  if (!original) throw new Error(`No deployment with id ${deploymentId}`);
  if (original.status !== "succeeded") {
    throw new Error(`Cannot roll back a deployment that did not succeed (status: ${original.status})`);
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
      const snapshotZip = fs.readFileSync(original.snapshot_path);
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
