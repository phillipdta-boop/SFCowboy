import { Router } from "express";
import type Database from "better-sqlite3";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, getPipeline, setPipelineStatus } from "./pipelines.js";

/**
 * Validates a pipeline request body BEFORE anything is written.
 *
 * Without this, a missing/wrong-typed `connectionIds` reaches `JSON.stringify(undefined)` and the
 * literal string "undefined" is persisted to `pipelines.connection_ids`. Every later
 * `GET /api/pipelines` then calls `JSON.parse("undefined")`, which throws — permanently breaking
 * the pipelines list until someone hand-edits the DB row.
 */
function validatePipelineBody(body: unknown): { name: string; connectionIds: string[] } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { name, connectionIds } = body as { name?: unknown; connectionIds?: unknown };
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required and must be a non-empty string" };
  if (!Array.isArray(connectionIds) || connectionIds.some((id) => typeof id !== "string")) {
    return { error: "connectionIds is required and must be an array of strings" };
  }
  return { name, connectionIds: connectionIds as string[] };
}

export function createPipelinesRouter(db: Database.Database): Router {
  const router = Router();

  router.post("/api/pipelines", (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const pipeline = createPipeline(db, validated);
    res.status(201).json(pipeline);
  });

  router.get("/api/pipelines", (_req, res) => {
    res.json(listPipelines(db));
  });

  router.put("/api/pipelines/:id", (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { name, connectionIds } = validated;
    const updated = updatePipeline(db, req.params.id, { name, connectionIds });
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(getPipeline(db, req.params.id));
  });

  router.patch("/api/pipelines/:id/status", (req, res) => {
    const { status } = req.body as { status?: unknown };
    if (status !== "active" && status !== "closed") {
      res.status(400).json({ error: "status is required and must be 'active' or 'closed'" });
      return;
    }
    const updated = setPipelineStatus(db, req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(getPipeline(db, req.params.id));
  });

  router.delete("/api/pipelines/:id", (req, res) => {
    const deleted = deletePipeline(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
