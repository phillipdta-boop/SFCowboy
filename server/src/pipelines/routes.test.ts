import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createPipelinesRouter } from "./routes.js";

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createPipelinesRouter(db));
  return { app, db };
}

describe("pipelines routes", () => {
  it("creates a pipeline via POST and lists it via GET", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
    expect(created.status).toBe(201);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe("Main");
  });

  it("updates a pipeline via PUT", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });
    const res = await request(app).put(`/api/pipelines/${created.body.id}`).send({ name: "Renamed", connectionIds: ["a", "b"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Renamed", connectionIds: ["a", "b"], status: "active" });

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body[0].name).toBe("Renamed");
  });

  it("closes a pipeline via PATCH .../status, and reopens it", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });

    const closed = await request(app).patch(`/api/pipelines/${created.body.id}/status`).send({ status: "closed" });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ id: created.body.id, name: "Main", connectionIds: ["a"], status: "closed" });

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body[0].status).toBe("closed");

    const reopened = await request(app).patch(`/api/pipelines/${created.body.id}/status`).send({ status: "active" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe("active");
  });

  it("rejects PATCH .../status with an invalid status as 400", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: [] });
    const res = await request(app).patch(`/api/pipelines/${created.body.id}/status`).send({ status: "archived" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 404 when PATCHing .../status on a nonexistent pipeline", async () => {
    const { app } = buildApp();
    const res = await request(app).patch("/api/pipelines/nonexistent-id/status").send({ status: "closed" });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "pipeline not found");
  });

  it("deletes a pipeline via DELETE", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: [] });
    const res = await request(app).delete(`/api/pipelines/${created.body.id}`);
    expect(res.status).toBe(204);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body).toHaveLength(0);
  });

  it("returns 404 when updating a nonexistent pipeline", async () => {
    const { app } = buildApp();
    const res = await request(app).put("/api/pipelines/nonexistent-id").send({ name: "Updated", connectionIds: [] });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "pipeline not found");
  });

  it("returns 404 when deleting a nonexistent pipeline", async () => {
    const { app } = buildApp();
    const res = await request(app).delete("/api/pipelines/nonexistent-id");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error", "pipeline not found");
  });

  it("fetches a single pipeline by id", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

    const res = await request(app).get(`/api/pipelines/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Main");
    expect(res.body.trackComponentsIndependently).toBe(true);
  });

  it("returns 404 for a single-pipeline lookup on an unknown id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/pipelines/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("updates the tracking mode via PUT when provided", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

    const res = await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });

    expect(res.status).toBe(200);
    expect(res.body.trackComponentsIndependently).toBe(false);
  });

  it("leaves the tracking mode unchanged via PUT when omitted", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
    await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });

    const res = await request(app).put(`/api/pipelines/${created.body.id}`).send({ name: "Renamed", connectionIds: ["a", "b"] });
    expect(res.body.trackComponentsIndependently).toBe(false);
    expect(res.body.name).toBe("Renamed");
  });
});

// Regression guard for persistent DB corruption: a missing/wrong-typed connectionIds used to reach
// JSON.stringify(undefined) and store the literal string "undefined". The next GET /api/pipelines
// then did JSON.parse("undefined"), which throws — breaking the list for every future request.
describe("pipelines route body validation", () => {
  const badBodies: [string, object][] = [
    ["missing connectionIds", { name: "Main" }],
    ["connectionIds not an array", { name: "Main", connectionIds: "a,b" }],
    ["connectionIds containing non-strings", { name: "Main", connectionIds: ["a", 7] }],
    ["missing name", { connectionIds: [] }],
    ["blank name", { name: "   ", connectionIds: [] }],
    ["name not a string", { name: 42, connectionIds: [] }],
  ];

  for (const [label, body] of badBodies) {
    it(`rejects POST with ${label} as 400 and persists nothing`, async () => {
      const { app } = buildApp();
      const res = await request(app).post("/api/pipelines").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();

      // The list must still be readable — this is exactly what the original bug broke.
      const listed = await request(app).get("/api/pipelines");
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([]);
    });
  }

  it("rejects PUT with a malformed body as 400 and leaves the stored pipeline intact", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });

    const res = await request(app).put(`/api/pipelines/${created.body.id}`).send({ name: "Renamed" });
    expect(res.status).toBe(400);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{ id: created.body.id, name: "Main", connectionIds: ["a"], status: "active", trackComponentsIndependently: true }]);
  });

  it("validates the body before the 404 check, so a malformed PUT to an unknown id is still a 400", async () => {
    const { app } = buildApp();
    const res = await request(app).put("/api/pipelines/nonexistent-id").send({ name: "Updated" });
    expect(res.status).toBe(400);
  });

  it("rejects PUT with an invalid trackComponentsIndependently type (string) as 400", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });

    const res = await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a"], trackComponentsIndependently: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();

    // Verify pipeline remains unchanged
    const fetched = await request(app).get(`/api/pipelines/${created.body.id}`);
    expect(fetched.body.trackComponentsIndependently).toBe(true);
  });

  it("rejects PUT with an invalid trackComponentsIndependently type (number) as 400", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });

    const res = await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a"], trackComponentsIndependently: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();

    // Verify pipeline remains unchanged
    const fetched = await request(app).get(`/api/pipelines/${created.body.id}`);
    expect(fetched.body.trackComponentsIndependently).toBe(true);
  });
});
