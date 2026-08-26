import { describe, it, expect } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, setPipelineStatus } from "./pipelines.js";

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("pipelines", () => {
  it("creates a pipeline defaulting to active status, and lists it", () => {
    const db = freshDb();
    createPipeline(db, { name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"] });
    const list = listPipelines(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"], status: "active" });
  });

  it("closes and reopens a pipeline without touching its name or connections", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Main Pipeline", connectionIds: ["conn1"] });

    const closed = setPipelineStatus(db, created.id, "closed");
    expect(closed).toBe(true);
    expect(listPipelines(db)[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1"], status: "closed" });

    setPipelineStatus(db, created.id, "active");
    expect(listPipelines(db)[0].status).toBe("active");
  });

  it("returns false when setting status on a nonexistent pipeline", () => {
    const db = freshDb();
    expect(setPipelineStatus(db, "does-not-exist", "closed")).toBe(false);
  });

  it("updates a pipeline's name and connection order", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Original", connectionIds: ["conn1", "conn2"] });
    updatePipeline(db, created.id, { name: "Renamed", connectionIds: ["conn2", "conn1"] });
    const list = listPipelines(db);
    expect(list[0]).toMatchObject({ name: "Renamed", connectionIds: ["conn2", "conn1"] });
  });

  it("deletes a pipeline", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "ToDelete", connectionIds: [] });
    deletePipeline(db, created.id);
    expect(listPipelines(db)).toHaveLength(0);
  });
});
