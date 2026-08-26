import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
}

export function createPipeline(db: Database.Database, input: { name: string; connectionIds: string[] }): Pipeline {
  const id = randomUUID();
  db.prepare(`INSERT INTO pipelines (id, name, connection_ids, status) VALUES (?, ?, ?, 'active')`).run(
    id,
    input.name,
    JSON.stringify(input.connectionIds)
  );
  return { id, name: input.name, connectionIds: input.connectionIds, status: "active" };
}

export function listPipelines(db: Database.Database): Pipeline[] {
  return db
    .prepare(`SELECT id, name, connection_ids, status FROM pipelines`)
    .all()
    .map((row: any) => ({ id: row.id, name: row.name, connectionIds: JSON.parse(row.connection_ids), status: row.status }));
}

export function getPipeline(db: Database.Database, id: string): Pipeline | undefined {
  const row = db.prepare(`SELECT id, name, connection_ids, status FROM pipelines WHERE id = ?`).get(id) as any;
  if (!row) return undefined;
  return { id: row.id, name: row.name, connectionIds: JSON.parse(row.connection_ids), status: row.status };
}

export function updatePipeline(db: Database.Database, id: string, input: { name: string; connectionIds: string[] }): boolean {
  const result = db.prepare(`UPDATE pipelines SET name = ?, connection_ids = ? WHERE id = ?`).run(input.name, JSON.stringify(input.connectionIds), id);
  return result.changes > 0;
}

export function setPipelineStatus(db: Database.Database, id: string, status: "active" | "closed"): boolean {
  const result = db.prepare(`UPDATE pipelines SET status = ? WHERE id = ?`).run(status, id);
  return result.changes > 0;
}

export function deletePipeline(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  return result.changes > 0;
}
