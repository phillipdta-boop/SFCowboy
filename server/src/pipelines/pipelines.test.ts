import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, setPipelineStatus, getPipeline } from "./pipelines.js";

describe("pipelines", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a pipeline defaulting to active status, and lists it", async () => {
    db = await openTestDb();
    await createPipeline(db.pool, { name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"] });
    const list = await listPipelines(db.pool);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"], status: "active" });
  });

  it("closes and reopens a pipeline without touching its name or connections", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main Pipeline", connectionIds: ["conn1"] });

    const closed = await setPipelineStatus(db.pool, created.id, "closed");
    expect(closed).toBe(true);
    expect((await listPipelines(db.pool))[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1"], status: "closed" });

    await setPipelineStatus(db.pool, created.id, "active");
    expect((await listPipelines(db.pool))[0].status).toBe("active");
  });

  it("returns false when setting status on a nonexistent pipeline", async () => {
    db = await openTestDb();
    expect(await setPipelineStatus(db.pool, "does-not-exist", "closed")).toBe(false);
  });

  it("updates a pipeline's name and connection order", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Original", connectionIds: ["conn1", "conn2"] });
    await updatePipeline(db.pool, created.id, { name: "Renamed", connectionIds: ["conn2", "conn1"] });
    const list = await listPipelines(db.pool);
    expect(list[0]).toMatchObject({ name: "Renamed", connectionIds: ["conn2", "conn1"] });
  });

  it("deletes a pipeline", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "ToDelete", connectionIds: [] });
    await deletePipeline(db.pool, created.id);
    expect(await listPipelines(db.pool)).toHaveLength(0);
  });

  it("defaults a new pipeline to tracking components independently", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    expect(created.trackComponentsIndependently).toBe(true);
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(true);
  });

  it("updates the tracking mode when explicitly provided", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    await updatePipeline(db.pool, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(false);
  });

  it("leaves the tracking mode untouched when the update omits it", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    await updatePipeline(db.pool, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    await updatePipeline(db.pool, created.id, { name: "Renamed", connectionIds: ["a", "b"] });
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(false);
    expect((await getPipeline(db.pool, created.id))!.name).toBe("Renamed");
  });
});
