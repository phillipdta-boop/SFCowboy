import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

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

export function createPipeline(db: Database.Database, input: { name: string; connectionIds: string[] }): Pipeline {
  const id = randomUUID();
  db.prepare(`INSERT INTO pipelines (id, name, connection_ids, status, track_components_independently) VALUES (?, ?, ?, 'active', 1)`).run(
    id,
    input.name,
    JSON.stringify(input.connectionIds)
  );
  return { id, name: input.name, connectionIds: input.connectionIds, status: "active", trackComponentsIndependently: true };
}

export function listPipelines(db: Database.Database): Pipeline[] {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM pipelines`).all().map(rowToPipeline);
}

export function getPipeline(db: Database.Database, id: string): Pipeline | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM pipelines WHERE id = ?`).get(id) as any;
  return row ? rowToPipeline(row) : undefined;
}

export function updatePipeline(
  db: Database.Database,
  id: string,
  input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }
): boolean {
  // Omitting trackComponentsIndependently must leave the stored value untouched (e.g. a plain
  // rename shouldn't silently reset the tracking mode) — COALESCE keeps the existing value when
  // the bound parameter is NULL.
  const trackValue = input.trackComponentsIndependently === undefined ? null : input.trackComponentsIndependently ? 1 : 0;
  const result = db
    .prepare(
      `UPDATE pipelines SET name = ?, connection_ids = ?, track_components_independently = COALESCE(?, track_components_independently) WHERE id = ?`
    )
    .run(input.name, JSON.stringify(input.connectionIds), trackValue, id);
  return result.changes > 0;
}

export function setPipelineStatus(db: Database.Database, id: string, status: "active" | "closed"): boolean {
  const result = db.prepare(`UPDATE pipelines SET status = ? WHERE id = ?`).run(status, id);
  return result.changes > 0;
}

/**
 * Whether any run has ever been started on this pipeline.
 *
 * pipeline_runs.pipeline_id is a real FK, so deleting a pipeline that still has runs raises
 * SQLITE_CONSTRAINT_FOREIGNKEY. Callers check this first so they can refuse with a clear message
 * instead of surfacing a raw constraint error — deleting a pipeline's run history is a separate,
 * more sensitive decision than a plain "delete this pipeline" is allowed to make.
 */
export function pipelineHasRuns(db: Database.Database, id: string): boolean {
  return db.prepare(`SELECT 1 FROM pipeline_runs WHERE pipeline_id = ? LIMIT 1`).get(id) !== undefined;
}

export function deletePipeline(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  return result.changes > 0;
}
