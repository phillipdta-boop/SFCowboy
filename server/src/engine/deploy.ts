import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { getConnectionRow } from "../connections/orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "../connections/gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import { buildOrgConnection } from "./sfConnection.js";
import { retrieveOrgZip } from "./orgComponents.js";
import { convertZipToSourceDir, convertSourceDirToZip, stripUnpackagedPrefix } from "./convert.js";
import { deployZipToOrg, type DeployProgress, type DeployResult } from "./deployPrimitive.js";
import { buildDestructiveChangesZip } from "./destructiveChanges.js";
import { rollbackDeployment } from "./rollback.js";
import { analyzeApexZip } from "./staticAnalysis.js";
import type { Config } from "../config.js";

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

/**
 * Creates the deployment record before any components are chosen — a source, a target, and an
 * optional title, so it exists (and can be Saved/committed to) before the user works through the
 * diff to pick what to actually deploy. Starts empty and 'pending'; attachComponentsAndQueue fills
 * in the rest once components are chosen.
 */
export async function createDraftDeployment(
  db: Pool,
  input: {
    title?: string;
    sourceConnectionId: string;
    targetConnectionId: string;
    // Overrides the connection's own default branch for this deployment only — fixed for its
    // lifetime, same as source/target themselves. Null/omitted means "use whatever branch that
    // connection is currently configured with." Meaningless (and never read) for an org connection.
    sourceBranch?: string | null;
    targetBranch?: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO deployments (id, title, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, source_branch, target_branch)
     VALUES ($1, $2, $3, $4, '[]', 'NoTestRun', 'pending', 0, $5, $6, $7)`,
    [id, input.title ?? null, input.sourceConnectionId, input.targetConnectionId, now, input.sourceBranch ?? null, input.targetBranch ?? null]
  );
  return id;
}

/**
 * Attaches the chosen components/options to an existing draft, ready for runDeployment.
 *
 * Replaces (rather than appends to) any components already attached, so this is safe to call
 * repeatedly as the user's selection changes while still editing a draft — e.g. autosaving as
 * they check/uncheck components — without piling up stale deployment_items rows.
 */
export async function attachComponentsAndQueue(
  db: Pool,
  id: string,
  input: {
    components: DeployComponentSelection[];
    testLevel: TestLevel;
    validateOnly: boolean;
    ignoreWarnings?: boolean;
    allowMissingFiles?: boolean;
    autoUpdatePackage?: boolean;
    // The exact Apex test classes to run — only meaningful (and required by Salesforce) when
    // testLevel is RunSpecifiedTests.
    runTests?: string[];
  }
): Promise<void> {
  const targetIdRow = (await db.query(`SELECT target_connection_id FROM deployments WHERE id = $1`, [id])).rows[0];
  const targetRow = await getConnectionRow(db, targetIdRow.target_connection_id);
  const effectiveTestLevel: TestLevel =
    targetRow?.type === "org" && targetRow.org_type === "production" && input.testLevel === "NoTestRun"
      ? "RunLocalTests"
      : input.testLevel;

  await db.query(
    `UPDATE deployments
     SET component_list = $1, test_level = $2, validate_only = $3, ignore_warnings = $4, allow_missing_files = $5, auto_update_package = $6, run_tests = $7
     WHERE id = $8`,
    [
      JSON.stringify(input.components),
      effectiveTestLevel,
      input.validateOnly ? 1 : 0,
      input.ignoreWarnings ? 1 : 0,
      input.allowMissingFiles ? 1 : 0,
      input.autoUpdatePackage ? 1 : 0,
      JSON.stringify(input.runTests ?? []),
      id,
    ]
  );

  await db.query(`DELETE FROM deployment_items WHERE deployment_id = $1`, [id]);
  for (const c of input.components) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), id, c.type, c.fullName, c.action]
    );
  }
}

/** Renames a deployment. Allowed at any status — the title is just a label, not part of what runs. */
export async function updateDeploymentTitle(db: Pool, id: string, title: string | null): Promise<void> {
  const row = (await db.query(`SELECT id FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  await db.query(`UPDATE deployments SET title = $1 WHERE id = $2`, [title, id]);
}

/**
 * Labels who triggered a run — a self-reported display name from the browser (see
 * web/src/displayName.ts), not an authenticated identity. There's no login system here, so this
 * is attribution/bookkeeping only, not access control: anyone using that browser can type any
 * name. Set at run time (not draft-save time), since it describes who actually ran it.
 */
export async function setRunBy(db: Pool, id: string, runBy: string | null): Promise<void> {
  await db.query(`UPDATE deployments SET run_by = $1 WHERE id = $2`, [runBy, id]);
}

/**
 * Schedules a pending draft to run automatically at a future time — see scheduler.ts, which polls
 * for deployments due to fire. runBy is captured now (not at fire time, when nobody is present)
 * since it's the same self-reported attribution setRunBy always was.
 */
export async function scheduleDeployment(db: Pool, id: string, scheduledAt: string, runBy: string | null): Promise<void> {
  const row: any = (await db.query(`SELECT status FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  if (row.status !== "pending") throw new Error(`Only a pending draft can be scheduled (status: ${row.status})`);
  await db.query(`UPDATE deployments SET scheduled_at = $1, run_by = $2 WHERE id = $3`, [scheduledAt, runBy, id]);
}

/** Cancels a pending schedule — the draft itself is untouched and can be run manually or rescheduled. */
export async function cancelSchedule(db: Pool, id: string): Promise<void> {
  const row: any = (await db.query(`SELECT status, scheduled_at FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  if (row.status !== "pending" || !row.scheduled_at) throw new Error("This deployment isn't currently scheduled");
  await db.query(`UPDATE deployments SET scheduled_at = NULL WHERE id = $1`, [id]);
}

/** Marks a deployment as belonging to a specific hop of a pipeline run — see pipelineRuns.ts. */
export async function tagDeploymentToPipelineStep(db: Pool, deploymentId: string, pipelineRunId: string, stepIndex: number): Promise<void> {
  await db.query(`UPDATE deployments SET pipeline_run_id = $1, pipeline_step_index = $2 WHERE id = $3`, [pipelineRunId, stepIndex, deploymentId]);
}

/** Permanently removes a deployment and its per-component items. */
export async function deleteDeployment(db: Pool, id: string): Promise<void> {
  const row = (await db.query(`SELECT id FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  await db.query(`DELETE FROM deployment_items WHERE deployment_id = $1`, [id]);
  await db.query(`DELETE FROM deployments WHERE id = $1`, [id]);
}

/**
 * Duplicates a deployment (any status, including a finished one) into a fresh 'pending' draft
 * with the same source, target, title, and components — ready to review and run again, e.g. to
 * redeploy the same set to another window or retry after fixing something outside SFCowboy.
 */
export async function cloneDeployment(db: Pool, id: string): Promise<string> {
  const original: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!original) throw new Error(`No deployment with id ${id}`);

  const newId = randomUUID();
  const now = new Date().toISOString();
  // package_path is deliberately NOT carried over — cloning re-resolves fresh content from the
  // source connection at run time (or waits for a fresh import), rather than reusing whatever
  // zip the original happened to have on disk.
  await db.query(
    `INSERT INTO deployments (
       id, title, source_connection_id, target_connection_id, component_list, test_level, status,
       validate_only, ignore_warnings, allow_missing_files, auto_update_package, run_tests, started_at,
       source_branch, target_branch
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      newId,
      original.title,
      original.source_connection_id,
      original.target_connection_id,
      original.component_list,
      original.test_level,
      original.validate_only,
      original.ignore_warnings,
      original.allow_missing_files,
      original.auto_update_package,
      original.run_tests,
      now,
      original.source_branch,
      original.target_branch,
    ]
  );

  const items: any[] = (await db.query(`SELECT * FROM deployment_items WHERE deployment_id = $1`, [id])).rows;
  for (const item of items) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), newId, item.metadata_type, item.api_name, item.action]
    );
  }

  return newId;
}

/**
 * Cancels an in-progress deployment. Only meaningful once Salesforce has actually accepted the
 * async job (sf_job_id is set) and the deployment hasn't already finished — cancelDeploy on a
 * completed job has nothing left to cancel.
 */
export async function cancelDeployment(db: Pool, config: Config, id: string): Promise<void> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!deployment) throw new Error(`No deployment with id ${id}`);
  if (deployment.status !== "validating" && deployment.status !== "deploying") {
    throw new Error("Only an in-progress deployment can be cancelled");
  }
  if (!deployment.sf_job_id) {
    throw new Error("The deployment hasn't reached Salesforce yet — nothing to cancel");
  }
  const targetConn: any = await buildOrgConnection(db, deployment.target_connection_id, config);
  await targetConn.metadata.cancelDeploy(deployment.sf_job_id);
}

/** Every pending deployment scheduled to have already fired by `asOf` — see scheduler.ts. */
export async function listDueScheduledDeployments(db: Pool, asOf: Date): Promise<string[]> {
  const rows = (
    await db.query(`SELECT id FROM deployments WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= $1`, [asOf.toISOString()])
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

export async function getDeployment(db: Pool, id: string): Promise<any> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!deployment) return undefined;
  const items = (await db.query(`SELECT * FROM deployment_items WHERE deployment_id = $1`, [id])).rows;
  // The target's connection type travels with the detail payload so callers (the rollback guard
  // and the UI's Roll back button) can tell an org target from a git one without a second lookup.
  const targetRow = await getConnectionRow(db, deployment.target_connection_id);
  return {
    ...deployment,
    components: JSON.parse(deployment.component_list),
    run_tests: JSON.parse(deployment.run_tests),
    items,
    target_connection_type: targetRow?.type ?? null,
  };
}

/**
 * Attaches each deployment's own items in one bulk query rather than one query per row — the
 * History page needs every run's component list, and fetching that per-deployment would turn a
 * single page load into an N+1 (see listOrgComponents' batching fix for the same class of bug).
 */
export async function listDeployments(db: Pool): Promise<any[]> {
  const deployments: any[] = (await db.query(`SELECT * FROM deployments ORDER BY started_at DESC`)).rows;
  if (deployments.length === 0) return deployments;

  const placeholders = deployments.map((_, i) => `$${i + 1}`).join(",");
  const items: any[] = (
    await db.query(`SELECT * FROM deployment_items WHERE deployment_id IN (${placeholders})`, deployments.map((d) => d.id))
  ).rows;

  const itemsByDeployment = new Map<string, any[]>();
  for (const item of items) {
    const bucket = itemsByDeployment.get(item.deployment_id);
    if (bucket) bucket.push(item);
    else itemsByDeployment.set(item.deployment_id, [item]);
  }

  return deployments.map((d) => ({ ...d, items: itemsByDeployment.get(d.id) ?? [] }));
}

async function applyDeployResultToItems(
  db: Pool,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): Promise<void> {
  for (const cr of componentResults) {
    await db.query(
      `UPDATE deployment_items SET status = $1, error_message = $2 WHERE deployment_id = $3 AND metadata_type = $4 AND api_name = $5`,
      [cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName]
    );
  }
}

/**
 * A failed DeployResult's componentResults array includes every component Salesforce touched —
 * successes and failures alike — plus job bookkeeping (jobId/status). Dumping that whole object
 * as error_detail means the UI ends up rendering the raw API payload instead of a reason. This
 * reduces one or more DeployResults down to a short, human-readable line naming just what broke.
 * Pure function — unchanged.
 */
function summarizeDeployFailure(results: DeployResult[]): string {
  const failedComponents = results.flatMap((r) => r.componentResults.filter((c) => !c.success));
  if (failedComponents.length === 0) {
    return `Deploy failed (status: ${results[0]?.status ?? "unknown"})`;
  }
  return failedComponents.map((c) => `${c.type}.${c.fullName}: ${c.errorMessage ?? "failed"}`).join("; ");
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
 *
 * Pure filesystem-reading function — no database access, unchanged from the SQLite version.
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

async function markPendingItemsSucceeded(db: Pool, deploymentId: string, components: DeployComponentSelection[]): Promise<void> {
  for (const c of components) {
    await db.query(
      `UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1 AND metadata_type = $2 AND api_name = $3 AND status = 'pending'`,
      [deploymentId, c.type, c.fullName]
    );
  }
}

export async function runDeployment(db: Pool, config: Config, dataDir: string, deploymentId: string): Promise<void> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [deploymentId])).rows[0];
  const components: DeployComponentSelection[] = JSON.parse(deployment.component_list);
  const targetRow = await getConnectionRow(db, deployment.target_connection_id);

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

    await db.query(`UPDATE deployments SET status = 'validating' WHERE id = $1`, [deploymentId]);

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
    await db.query(`UPDATE deployments SET snapshot_path = $1 WHERE id = $2`, [snapshotPath, deploymentId]);

    // An imported deployment already has its exact content saved to disk (see
    // createImportedDeployment) — reuse it as-is instead of resolving from a source connection,
    // which an import doesn't have. Every other deployment resolves its zip fresh below and
    // persists it to the same place afterward, so it's available to export later too (see the
    // /export/package route) even though this run never needed to re-read it back.
    const packagePath: string = deployment.package_path ?? path.join(dataDir, "packages", `${deploymentId}.zip`);
    let zip: Buffer | null = null;
    if (deployment.package_path && fs.existsSync(deployment.package_path)) {
      zip = fs.readFileSync(deployment.package_path);
    } else if (contentComponents.length > 0) {
      const sourceRow = await getConnectionRow(db, deployment.source_connection_id);
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
          branch: deployment.source_branch ?? sourceRow.default_branch,
          authToken: decrypt(sourceRow.encrypted_auth_token),
        });
        zip = await convertSourceDirToZip(sourceDir, contentComponents);
      }
      if (zip) {
        fs.mkdirSync(path.dirname(packagePath), { recursive: true });
        fs.writeFileSync(packagePath, zip);
        await db.query(`UPDATE deployments SET package_path = $1 WHERE id = $2`, [packagePath, deploymentId]);
      }
    }

    // Advisory only — never affects the deploy's outcome, just persisted for the status panel to
    // show alongside the result. Runs on whatever's about to be deployed, regardless of target
    // type, since it's a property of the source content, not where it's going.
    if (zip) {
      const findings = analyzeApexZip(zip);
      await db.query(`UPDATE deployments SET static_analysis_findings = $1 WHERE id = $2`, [
        findings.length > 0 ? JSON.stringify(findings) : null,
        deploymentId,
      ]);
    }

    await db.query(`UPDATE deployments SET status = 'deploying' WHERE id = $1`, [deploymentId]);

    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const checkOnly = !!deployment.validate_only;
      const deployOptions = {
        testLevel: deployment.test_level,
        checkOnly,
        ignoreWarnings: !!deployment.ignore_warnings,
        allowMissingFiles: !!deployment.allow_missing_files,
        autoUpdatePackage: !!deployment.auto_update_package,
        runTests: JSON.parse(deployment.run_tests) as string[],
      };
      const failures: unknown[] = [];
      let cancelled = false;
      // Whichever of the two deploy calls below actually ran tests — in practice a deployment is
      // almost always one or the other, not both, so "last one with data" is enough to capture.
      let coverageResult: Pick<DeployResult, "coveragePercent" | "codeCoverage"> | undefined;
      const onProgress = (p: DeployProgress) => {
        void db.query(
          `UPDATE deployments SET sf_job_id = $1, components_deployed = $2, components_total = $3, tests_completed = $4, tests_total = $5 WHERE id = $6`,
          [p.jobId, p.numberComponentsDeployed, p.numberComponentsTotal, p.numberTestsCompleted, p.numberTestsTotal, deploymentId]
        );
      };
      const noteIfCancelled = (result: DeployResult) => {
        if (result.status === "Canceled") cancelled = true;
      };
      const noteCoverage = (result: DeployResult) => {
        if (result.coveragePercent !== undefined) coverageResult = result;
      };

      if (zip) {
        const result = await deployZipToOrg(targetConn, zip, deployOptions, undefined, undefined, onProgress);
        await applyDeployResultToItems(db, deploymentId, result.componentResults);
        noteIfCancelled(result);
        noteCoverage(result);
        if (!result.success) failures.push(result);
      }

      if (deleteComponents.length > 0) {
        const destructiveZip = buildDestructiveChangesZip(deleteComponents);
        const result = await deployZipToOrg(targetConn, destructiveZip, deployOptions, undefined, undefined, onProgress);
        await applyDeployResultToItems(db, deploymentId, result.componentResults);
        noteIfCancelled(result);
        noteCoverage(result);
        if (result.success) {
          // Salesforce doesn't always echo a per-component result for a destructive delete;
          // a successful destructive deploy means every requested deletion went through.
          await markPendingItemsSucceeded(db, deploymentId, deleteComponents);
        } else {
          failures.push(result);
        }
      }

      const success = failures.length === 0;
      await db.query(`UPDATE deployments SET coverage_percent = $1, coverage_details = $2 WHERE id = $3`, [
        coverageResult?.coveragePercent ?? null,
        coverageResult?.codeCoverage ? JSON.stringify(coverageResult.codeCoverage) : null,
        deploymentId,
      ]);

      // A custom minimum above Salesforce's own 75% floor (or any minimum at all against a
      // sandbox, which Salesforce doesn't enforce natively) is only knowable once tests have
      // actually run — by definition after checkOnly's dry run, or after a real deploy has
      // already landed the metadata. A validate-only run that fails this gate is a clean block
      // (nothing was ever deployed); a real deploy that fails it gets auto-rolled-back instead of
      // merely relabeled, since the change is already live by the time the coverage number is known.
      const minCoverage = targetRow.min_code_coverage_percent as number | null;
      const gateFailed =
        success && !cancelled && minCoverage != null && coverageResult?.coveragePercent !== undefined && coverageResult.coveragePercent < minCoverage;
      const coverageMessage = gateFailed
        ? `Coverage gate: ${coverageResult!.coveragePercent!.toFixed(1)}% is below the required ${minCoverage}% minimum for this connection.`
        : null;

      if (gateFailed && checkOnly) {
        await db.query(`UPDATE deployments SET status = 'failed', finished_at = $1, error_detail = $2 WHERE id = $3`, [
          new Date().toISOString(),
          JSON.stringify({ message: coverageMessage }),
          deploymentId,
        ]);
      } else if (gateFailed) {
        // Mark 'succeeded' first — rollbackDeployment requires that status — then roll it back;
        // rollbackDeployment itself flips this deployment to 'rolled_back' and creates the
        // reversing deployment. If the rollback attempt itself fails, leave this deployment
        // 'succeeded' (the rollback's own row records that failure) rather than claiming a status
        // that didn't actually happen, but still surface the coverage shortfall that triggered it.
        await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
        try {
          await rollbackDeployment(db, config, deploymentId);
          await db.query(`UPDATE deployments SET error_detail = $1 WHERE id = $2`, [JSON.stringify({ message: coverageMessage }), deploymentId]);
        } catch (rollbackErr) {
          await db.query(`UPDATE deployments SET error_detail = $1 WHERE id = $2`, [
            JSON.stringify({ message: `${coverageMessage} Automatic rollback also failed: ${(rollbackErr as Error).message}` }),
            deploymentId,
          ]);
        }
      } else {
        await db.query(`UPDATE deployments SET status = $1, finished_at = $2, error_detail = $3 WHERE id = $4`, [
          cancelled ? "cancelled" : success ? "succeeded" : "failed",
          new Date().toISOString(),
          success || cancelled ? null : JSON.stringify({ message: summarizeDeployFailure(failures as DeployResult[]) }),
          deploymentId,
        ]);
      }
    } else {
      const targetDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.target_connection_id,
        remoteUrl: targetRow.remote_url,
        branch: deployment.target_branch ?? targetRow.default_branch,
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
      await db.query(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1`, [deploymentId]);
      await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    }
  } catch (err) {
    await db.query(`UPDATE deployments SET status = 'failed', finished_at = $1, error_detail = $2 WHERE id = $3`, [
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      deploymentId,
    ]);
  }
}
