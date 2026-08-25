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

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body[0].name).toBe("Renamed");
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
});
