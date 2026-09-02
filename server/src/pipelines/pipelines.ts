import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
  // Governs how a hop's partial success is handled for every run of this pipeline (see
  // pipelineRuns.ts's deriveComponentPositions): true tracks each component's advancement
  // separately; false holds the whole batch back until a single deploy attempt clears everyone
  // still pending at that hop.
  trackComponentsIndependently: boolean;
}

function rowToPipeline(row: any): Pipeline {
  return {
    id: row.id,
    name: row.name,
    connectionIds: JSON.parse(row.connection_ids),
    status: row.status,
    trackComponentsIndependently: !!row.track_components_independently,
  };
}

const SELECT_COLUMNS = `id, name, connection_ids, status, track_components_independently`;

export async function createPipeline(db: Pool, input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO pipelines (id, name, connection_ids, status, track_components_independently) VALUES ($1, $2, $3, 'active', 1)`,
    [id, input.name, JSON.stringify(input.connectionIds)]
  );
  return { id, name: input.name, connectionIds: input.connectionIds, status: "active", trackComponentsIndependently: true };
}

export async function listPipelines(db: Pool): Promise<Pipeline[]> {
  const result = await db.query(`SELECT ${SELECT_COLUMNS} FROM pipelines`);
  return result.rows.map(rowToPipeline);
}

export async function getPipeline(db: Pool, id: string): Promise<Pipeline | undefined> {
  const result = await db.query(`SELECT ${SELECT_COLUMNS} FROM pipelines WHERE id = $1`, [id]);
  return result.rows[0] ? rowToPipeline(result.rows[0]) : undefined;
}

export async function updatePipeline(
  db: Pool,
  id: string,
  input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }
): Promise<boolean> {
  // Omitting trackComponentsIndependently must leave the stored value untouched (e.g. a plain
  // rename shouldn't silently reset the tracking mode) — COALESCE keeps the existing value when
  // the bound parameter is NULL.
  const trackValue = input.trackComponentsIndependently === undefined ? null : input.trackComponentsIndependently ? 1 : 0;
  const result = await db.query(
    `UPDATE pipelines SET name = $1, connection_ids = $2, track_components_independently = COALESCE($3, track_components_independently) WHERE id = $4`,
    [input.name, JSON.stringify(input.connectionIds), trackValue, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setPipelineStatus(db: Pool, id: string, status: "active" | "closed"): Promise<boolean> {
  const result = await db.query(`UPDATE pipelines SET status = $1 WHERE id = $2`, [status, id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether any run has ever been started on this pipeline.
 *
 * pipeline_runs.pipeline_id is a real FK, so deleting a pipeline that still has runs raises a
 * foreign key violation. Callers check this first so they can refuse with a clear message instead
 * of surfacing a raw constraint error — deleting a pipeline's run history is a separate, more
 * sensitive decision than a plain "delete this pipeline" is allowed to make.
 */
export async function pipelineHasRuns(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM pipeline_runs WHERE pipeline_id = $1 LIMIT 1`, [id]);
  return result.rows.length > 0;
}

export async function deletePipeline(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM pipelines WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
