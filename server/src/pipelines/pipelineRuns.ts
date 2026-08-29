import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getPipeline } from "./pipelines.js";

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
      .filter((d) => d.stepIndex === stepIndex && !d.validateOnly)
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

export function createPipelineRun(
  db: Database.Database,
  input: { pipelineId: string; title?: string; components: PipelineRunComponent[] }
): { id: string } {
  const pipeline = getPipeline(db, input.pipelineId);
  if (!pipeline) throw new Error(`No pipeline with id ${input.pipelineId}`);
  if (pipeline.connectionIds.length < 2) throw new Error("Pipeline must have at least two connections to run");
  if (input.components.length === 0) throw new Error("A run needs at least one component");

  const id = randomUUID();
  db.prepare(`INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    input.pipelineId,
    input.title ?? null,
    JSON.stringify(input.components),
    new Date().toISOString()
  );
  return { id };
}

// Bulk-fetches every run's tagged deployments (plus their items) in two queries total, regardless
// of how many runs there are — the same N+1-avoidance pattern already used by listDeployments()
// for the History page.
function loadStepDeploymentsByRun(
  db: Database.Database,
  runIds: string[]
): Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]> {
  const result = new Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>();
  if (runIds.length === 0) return result;

  const placeholders = runIds.map(() => "?").join(",");
  const deploymentRows = db
    .prepare(
      `SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, started_at, finished_at, error_detail FROM deployments WHERE pipeline_run_id IN (${placeholders}) ORDER BY pipeline_step_index ASC, started_at ASC`
    )
    .all(...runIds) as any[];
  if (deploymentRows.length === 0) return result;

  const deploymentIds = deploymentRows.map((d) => d.id);
  const itemPlaceholders = deploymentIds.map(() => "?").join(",");
  const itemRows = db
    .prepare(`SELECT deployment_id, metadata_type, api_name, status FROM deployment_items WHERE deployment_id IN (${itemPlaceholders})`)
    .all(...deploymentIds) as any[];
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

export function listPipelineRuns(db: Database.Database, pipelineId: string): PipelineRunSummary[] {
  const pipeline = getPipeline(db, pipelineId);
  // Tiebreak on rowid too: created_at has only millisecond resolution, so two runs created in
  // quick succession (e.g. back-to-back API calls, or in tests) can land on the identical
  // timestamp — without a tiebreaker, ORDER BY created_at DESC then returns tied rows in their
  // original (ascending) insertion order instead of most-recent-first.
  const runRows = db
    .prepare(`SELECT id, title, component_list, created_at FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(pipelineId) as any[];
  const deploymentsByRun = loadStepDeploymentsByRun(db, runRows.map((r) => r.id));
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

export function getPipelineRunDetail(db: Database.Database, runId: string): PipelineRunDetail | undefined {
  const row = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(runId) as any;
  if (!row) return undefined;
  const pipeline = getPipeline(db, row.pipeline_id);
  if (!pipeline) return undefined;

  const componentList: PipelineRunComponent[] = JSON.parse(row.component_list);
  const deployments = loadStepDeploymentsByRun(db, [runId]).get(runId) ?? [];
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
