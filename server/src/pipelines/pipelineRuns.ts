import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPipeline } from "./pipelines.js";
import type { Config } from "../config.js";
import { resolveComponents } from "../engine/routes.js";
import { diffComponents } from "../engine/diff.js";
import { createDraftDeployment, attachComponentsAndQueue, setRunBy, runDeployment, tagDeploymentToPipelineStep, type DeployComponentSelection } from "../engine/deploy.js";

export interface PipelineRunComponent {
  type: string;
  fullName: string;
}

export interface StepDeploymentItem {
  metadataType: string;
  apiName: string;
  status: "pending" | "succeeded" | "failed";
}

export interface StepDeployment {
  stepIndex: number;
  status: string;
  validateOnly: boolean;
  finishedAt: string | null;
  items: StepDeploymentItem[];
}

export interface ComponentPosition {
  type: string;
  fullName: string;
  stage: number;
  reachedAt: string | null;
}

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

function itemKey(i: StepDeploymentItem): string {
  return `${i.metadataType}::${i.apiName}`;
}

// Statuses that mean the hop's changes are no longer in the target org, whatever its items say.
// A rollback (see engine/rollback.ts) flips only the DEPLOYMENT's status to 'rolled_back' and
// leaves its deployment_items at 'succeeded', so without this an undone hop would keep showing
// its components as advanced.
const UNDONE_STATUSES = new Set(["rolled_back", "cancelled"]);

// The deployment lifecycle's end states — mirrors the same set the deployment detail page polls
// against. Anything else means a deployment is still on its way to one.
const TERMINAL_DEPLOYMENT_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);

/**
 * Computes each component's current stage in a pipeline run and when it got there, purely from
 * the run's tagged deployments — there is no separate "position" table (see the design spec).
 *
 * A component only advances past step N via a succeeded, non-validate-only deployment tagged to
 * that step: either it has a succeeded item there, or it has NO item there at all (the hop's diff
 * found it already identical, so it needed no action and passes straight through). A failed item
 * leaves it at the same stage, retryable by a later deployment tagged to the same step.
 *
 * trackIndependently=false additionally requires that a SINGLE attempt clear every component
 * still pending at a step before ANY of them advance — even ones that individually succeeded in
 * an attempt that also had a failure stay behind until a fully-clean attempt promotes the whole
 * batch together.
 *
 * Pure function — no database access, unchanged from the SQLite version.
 */
export function deriveComponentPositions(
  components: PipelineRunComponent[],
  deployments: StepDeployment[],
  trackIndependently: boolean
): ComponentPosition[] {
  const positions = new Map<string, ComponentPosition>(
    components.map((c) => [componentKey(c), { type: c.type, fullName: c.fullName, stage: 0, reachedAt: null }])
  );

  const maxStep = deployments.reduce((max, d) => Math.max(max, d.stepIndex), -1);

  for (let stepIndex = 0; stepIndex <= maxStep; stepIndex++) {
    const attempts = deployments
      .filter((d) => d.stepIndex === stepIndex && !d.validateOnly && !UNDONE_STATUSES.has(d.status))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    if (attempts.length === 0) continue;

    const pendingKeys = [...positions.values()].filter((p) => p.stage === stepIndex).map((p) => componentKey(p));
    if (pendingKeys.length === 0) continue;

    if (trackIndependently) {
      for (const attempt of attempts) {
        for (const key of pendingKeys) {
          const pos = positions.get(key)!;
          if (pos.stage !== stepIndex) continue; // an earlier attempt in this same loop already advanced it
          const item = attempt.items.find((i) => itemKey(i) === key);
          const itemCleared = item ? item.status === "succeeded" : attempt.status === "succeeded";
          if (itemCleared) {
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
        }
      }
    } else {
      for (const attempt of attempts) {
        const stillPending = pendingKeys.filter((key) => positions.get(key)!.stage === stepIndex);
        if (stillPending.length === 0) break;
        const allClear = stillPending.every((key) => {
          const item = attempt.items.find((i) => itemKey(i) === key);
          return item ? item.status === "succeeded" : attempt.status === "succeeded";
        });
        if (allClear) {
          for (const key of stillPending) {
            const pos = positions.get(key)!;
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
          break;
        }
      }
    }
  }

  return [...positions.values()];
}

export interface PipelineRunSummary {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentCount: number;
  componentsAtFinalStage: number;
}

export async function createPipelineRun(
  db: Pool,
  input: { pipelineId: string; title?: string; components: PipelineRunComponent[] }
): Promise<{ id: string }> {
  const pipeline = await getPipeline(db, input.pipelineId);
  if (!pipeline) throw new Error(`No pipeline with id ${input.pipelineId}`);
  if (pipeline.connectionIds.length < 2) throw new Error("Pipeline must have at least two connections to run");
  if (input.components.length === 0) throw new Error("A run needs at least one component");

  const id = randomUUID();
  await db.query(
    `INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, input.pipelineId, input.title ?? null, JSON.stringify(input.components), new Date().toISOString()]
  );
  return { id };
}

// Bulk-fetches every run's tagged deployments (plus their items) in two queries total, regardless
// of how many runs there are — the same N+1-avoidance pattern already used by listDeployments()
// for the History page.
async function loadStepDeploymentsByRun(
  db: Pool,
  runIds: string[]
): Promise<Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>> {
  const result = new Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>();
  if (runIds.length === 0) return result;

  const placeholders = runIds.map((_, i) => `$${i + 1}`).join(",");
  const deploymentRows = (
    await db.query(
      `SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, started_at, finished_at, error_detail FROM deployments WHERE pipeline_run_id IN (${placeholders}) ORDER BY pipeline_step_index ASC, started_at ASC`,
      runIds
    )
  ).rows;
  if (deploymentRows.length === 0) return result;

  const deploymentIds = deploymentRows.map((d) => d.id);
  const itemPlaceholders = deploymentIds.map((_, i) => `$${i + 1}`).join(",");
  const itemRows = (
    await db.query(
      `SELECT deployment_id, metadata_type, api_name, status FROM deployment_items WHERE deployment_id IN (${itemPlaceholders})`,
      deploymentIds
    )
  ).rows;
  const itemsByDeployment = new Map<string, StepDeploymentItem[]>();
  for (const item of itemRows) {
    const bucket = itemsByDeployment.get(item.deployment_id);
    const entry = { metadataType: item.metadata_type, apiName: item.api_name, status: item.status };
    if (bucket) bucket.push(entry);
    else itemsByDeployment.set(item.deployment_id, [entry]);
  }

  for (const row of deploymentRows) {
    const stepDeployment: StepDeployment & { id: string; startedAt: string; errorDetail: string | null } = {
      id: row.id,
      stepIndex: row.pipeline_step_index,
      status: row.status,
      validateOnly: !!row.validate_only,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorDetail: row.error_detail,
      items: itemsByDeployment.get(row.id) ?? [],
    };
    const bucket = result.get(row.pipeline_run_id);
    if (bucket) bucket.push(stepDeployment);
    else result.set(row.pipeline_run_id, [stepDeployment]);
  }
  return result;
}

export async function listPipelineRuns(db: Pool, pipelineId: string): Promise<PipelineRunSummary[]> {
  const pipeline = await getPipeline(db, pipelineId);
  // Tiebreak on ctid too: created_at has only millisecond resolution, so two runs created in
  // quick succession (e.g. back-to-back API calls, or in tests) can land on the identical
  // timestamp — without a tiebreaker, ORDER BY created_at DESC then returns tied rows in an
  // unspecified order. ctid is Postgres's physical-row-location pseudo-column, playing the same
  // "stable enough to break ties" role SQLite's rowid did.
  const runRows = (
    await db.query(
      `SELECT id, title, component_list, created_at FROM pipeline_runs WHERE pipeline_id = $1 ORDER BY created_at DESC, ctid DESC`,
      [pipelineId]
    )
  ).rows;
  const deploymentsByRun = await loadStepDeploymentsByRun(db, runRows.map((r) => r.id));
  const finalStage = pipeline ? pipeline.connectionIds.length - 1 : 0;
  const trackIndependently = pipeline?.trackComponentsIndependently ?? true;

  return runRows.map((row) => {
    const components: PipelineRunComponent[] = JSON.parse(row.component_list);
    const positions = deriveComponentPositions(components, deploymentsByRun.get(row.id) ?? [], trackIndependently);
    return {
      id: row.id,
      pipelineId,
      title: row.title,
      createdAt: row.created_at,
      componentCount: components.length,
      componentsAtFinalStage: positions.filter((p) => p.stage >= finalStage).length,
    };
  });
}

export interface PipelineRunDetail {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentList: PipelineRunComponent[];
  connectionIds: string[];
  trackComponentsIndependently: boolean;
  deployments: (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[];
  positions: ComponentPosition[];
}

export async function getPipelineRunDetail(db: Pool, runId: string): Promise<PipelineRunDetail | undefined> {
  const row = (await db.query(`SELECT * FROM pipeline_runs WHERE id = $1`, [runId])).rows[0];
  if (!row) return undefined;
  const pipeline = await getPipeline(db, row.pipeline_id);
  if (!pipeline) return undefined;

  const componentList: PipelineRunComponent[] = JSON.parse(row.component_list);
  const deployments = (await loadStepDeploymentsByRun(db, [runId])).get(runId) ?? [];
  const positions = deriveComponentPositions(componentList, deployments, pipeline.trackComponentsIndependently);

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    title: row.title,
    createdAt: row.created_at,
    componentList,
    connectionIds: pipeline.connectionIds,
    trackComponentsIndependently: pipeline.trackComponentsIndependently,
    deployments,
    positions,
  };
}

function actionForDiffStatus(status: "added" | "modified" | "removed" | "unchanged"): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

/**
 * Records components the hop's diff found already present and identical in both orgs as real,
 * already-succeeded deployment_items — even though they were never sent to Salesforce.
 *
 * Absence of an item can mean two very different things (diffComponents emits no row at all for a
 * component missing from BOTH orgs), and deriveComponentPositions can't tell them apart: it reads
 * a missing item as "confirmed fine here, pass straight through". Writing the confirmation down
 * explicitly makes pass-through mean what it claims, and stops an unchanged component from being
 * held back by an unrelated sibling's failure in the same attempt (which silently turned
 * independent tracking into blocked tracking).
 *
 * 'modify' because nothing is being added or deleted — the component is only being confirmed.
 */
async function recordConfirmedUnchangedItems(db: Pool, deploymentId: string, components: PipelineRunComponent[]): Promise<void> {
  for (const c of components) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, 'modify', 'succeeded')`,
      [randomUUID(), deploymentId, c.type, c.fullName]
    );
  }
}

/**
 * Validates/deploys one hop of a pipeline run. Diffs only the components currently eligible for
 * this step (see deriveComponentPositions), creates a normal deployment tagged to the run/step,
 * and either runs it for real or — if the diff shows nothing actually needs to move — marks it
 * succeeded immediately without ever contacting Salesforce, so the derivation function still has
 * a tagged "this step was checked and cleared" record to read.
 */
export async function deployPipelineStep(
  db: Pool,
  config: Config,
  dataDir: string,
  runId: string,
  stepIndex: number,
  options: { validateOnly: boolean; runBy?: string | null }
): Promise<{ deploymentId: string; skipped: boolean }> {
  const run = await getPipelineRunDetail(db, runId);
  if (!run) throw new Error(`No pipeline run with id ${runId}`);
  if (stepIndex < 0 || stepIndex >= run.connectionIds.length - 1) {
    throw new Error(`step ${stepIndex} is out of range for a pipeline with ${run.connectionIds.length} stages`);
  }

  const eligible = run.positions.filter((p) => p.stage === stepIndex);
  if (eligible.length === 0) {
    throw new Error("No components are eligible for this step yet — they haven't succeeded the previous hop.");
  }

  // The API returns 202 as soon as the deploy is queued, so the buttons re-enable long before the
  // hop finishes. Without this, a second click fires a second deployment at the same target org,
  // concurrently with the first.
  if (run.deployments.some((d) => d.stepIndex === stepIndex && !TERMINAL_DEPLOYMENT_STATUSES.has(d.status))) {
    throw new Error("A deployment is already in progress for this step");
  }

  const sourceId = run.connectionIds[stepIndex];
  const targetId = run.connectionIds[stepIndex + 1];
  const types = [...new Set(eligible.map((c) => c.type))];
  const eligibleKeys = new Set(eligible.map((c) => `${c.type}::${c.fullName}`));

  const [source, target] = await Promise.all([
    resolveComponents(db, config, dataDir, sourceId, types),
    resolveComponents(db, config, dataDir, targetId, types),
  ]);
  const scopedDiff = diffComponents(source.components, target.components).filter((d) => eligibleKeys.has(`${d.type}::${d.fullName}`));
  const actionable = scopedDiff.filter((d) => d.status !== "unchanged");
  const confirmedUnchanged = scopedDiff.filter((d) => d.status === "unchanged").map((d) => ({ type: d.type, fullName: d.fullName }));
  const components: DeployComponentSelection[] = actionable.map((d) => ({
    type: d.type,
    fullName: d.fullName,
    action: actionForDiffStatus(d.status),
  }));

  const deploymentId = await createDraftDeployment(db, {
    title: run.title ? `${run.title} — step ${stepIndex + 1}` : `Pipeline step ${stepIndex + 1}`,
    sourceConnectionId: sourceId,
    targetConnectionId: targetId,
  });
  await tagDeploymentToPipelineStep(db, deploymentId, runId, stepIndex);

  if (components.length === 0) {
    // Every eligible component is already identical at this hop — nothing to deploy, so there's
    // nothing to gain by round-tripping to Salesforce with an empty package.
    await attachComponentsAndQueue(db, deploymentId, { components: [], testLevel: "NoTestRun", validateOnly: options.validateOnly });
    await recordConfirmedUnchangedItems(db, deploymentId, confirmedUnchanged);
    await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    return { deploymentId, skipped: true };
  }

  // Must follow attachComponentsAndQueue, which clears the deployment's items before writing its
  // own — and precede runDeployment, so the confirmations are already on record whatever the real
  // deploy does.
  await attachComponentsAndQueue(db, deploymentId, { components, testLevel: "NoTestRun", validateOnly: options.validateOnly });
  await recordConfirmedUnchangedItems(db, deploymentId, confirmedUnchanged);
  await setRunBy(db, deploymentId, options.runBy ?? null);
  runDeployment(db, config, dataDir, deploymentId).catch((err) => {
    console.error(`Pipeline step deployment ${deploymentId} failed unexpectedly`, err);
  });

  return { deploymentId, skipped: false };
}
