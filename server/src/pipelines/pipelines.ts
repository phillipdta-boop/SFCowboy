import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
}

export function createPipeline(db: Database.Database, input: { name: string; connectionIds: string[] }): Pipeline {
  const id = randomUUID();
  db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES (?, ?, ?)`).run(id, input.name, JSON.stringify(input.connectionIds));
  return { id, name: input.name, connectionIds: input.connectionIds };
}

export function listPipelines(db: Database.Database): Pipeline[] {
  return db
    .prepare(`SELECT id, name, connection_ids FROM pipelines`)
    .all()
    .map((row: any) => ({ id: row.id, name: row.name, connectionIds: JSON.parse(row.connection_ids) }));
}

export function updatePipeline(db: Database.Database, id: string, input: { name: string; connectionIds: string[] }): void {
  db.prepare(`UPDATE pipelines SET name = ?, connection_ids = ? WHERE id = ?`).run(input.name, JSON.stringify(input.connectionIds), id);
}

export function deletePipeline(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
}
