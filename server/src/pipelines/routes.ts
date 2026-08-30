import { Router } from "express";
import type Database from "better-sqlite3";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, getPipeline, setPipelineStatus, pipelineHasRuns } from "./pipelines.js";
import type { Config } from "../config.js";
import { createPipelineRun, listPipelineRuns, getPipelineRunDetail, deployPipelineStep } from "./pipelineRuns.js";

/**
 * Validates a pipeline request body BEFORE anything is written.
 *
 * Without this, a missing/wrong-typed `connectionIds` reaches `JSON.stringify(undefined)` and the
 * literal string "undefined" is persisted to `pipelines.connection_ids`. Every later
 * `GET /api/pipelines` then calls `JSON.parse("undefined")`, which throws — permanently breaking
 * the pipelines list until someone hand-edits the DB row.
 */
function validatePipelineBody(
  body: unknown
): { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { name, connectionIds, trackComponentsIndependently } = body as {
    name?: unknown;
    connectionIds?: unknown;
    trackComponentsIndependently?: unknown;
  };
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required and must be a non-empty string" };
  if (!Array.isArray(connectionIds) || connectionIds.some((id) => typeof id !== "string")) {
    return { error: "connectionIds is required and must be an array of strings" };
  }
  if (trackComponentsIndependently !== undefined && typeof trackComponentsIndependently !== "boolean") {
    return { error: "trackComponentsIndependently must be a boolean when provided" };
  }
  return { name, connectionIds: connectionIds as string[], trackComponentsIndependently: trackComponentsIndependently as boolean | undefined };
}

export function createPipelinesRouter(db: Database.Database, config: Config, dataDir: string): Router {
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

  router.get("/api/pipelines/:id", (req, res) => {
    const pipeline = getPipeline(db, req.params.id);
    if (!pipeline) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.json(pipeline);
  });

  router.put("/api/pipelines/:id", (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { name, connectionIds, trackComponentsIndependently } = validated;
    const existing = getPipeline(db, req.params.id);
    if (!existing) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    // A run's stage semantics (source/target connection per hop, final stage) are read live off
    // the pipeline's connectionIds — see getPipelineRunDetail in pipelineRuns.ts. Letting the
    // sequence change under an existing run would silently reinterpret every deployment already
    // tagged to a step index, so it's blocked the same way deleting a pipeline with runs is.
    const connectionsChanged = JSON.stringify(existing.connectionIds) !== JSON.stringify(connectionIds);
    if (connectionsChanged && pipelineHasRuns(db, req.params.id)) {
      res.status(409).json({ error: "This pipeline has run history, so its connections can't be changed" });
      return;
    }
    const updated = updatePipeline(db, req.params.id, { name, connectionIds, trackComponentsIndependently });
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
    if (pipelineHasRuns(db, req.params.id)) {
      res.status(409).json({ error: "This pipeline has runs and can't be deleted" });
      return;
    }
    const deleted = deletePipeline(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/api/pipelines/:id/runs", (req, res) => {
    const body = req.body as { title?: unknown; components?: unknown };
    if (
      !Array.isArray(body.components) ||
      body.components.some((c) => typeof c !== "object" || c === null || typeof (c as any).type !== "string" || typeof (c as any).fullName !== "string")
    ) {
      res.status(400).json({ error: "components is required and must be an array of { type, fullName }" });
      return;
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string when provided" });
      return;
    }
    try {
      const run = createPipelineRun(db, {
        pipelineId: req.params.id,
        title: body.title as string | undefined,
        components: body.components as { type: string; fullName: string }[],
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/pipelines/:id/runs", (req, res) => {
    res.json(listPipelineRuns(db, req.params.id));
  });

  router.get("/api/pipeline-runs/:runId", (req, res) => {
    const detail = getPipelineRunDetail(db, req.params.runId);
    if (!detail) {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.json(detail);
  });

  router.post("/api/pipeline-runs/:runId/steps/:stepIndex/deploy", async (req, res) => {
    const stepIndex = Number(req.params.stepIndex);
    const body = req.body as { validateOnly?: unknown; runBy?: unknown };
    if (typeof body.validateOnly !== "boolean") {
      res.status(400).json({ error: "validateOnly is required and must be a boolean" });
      return;
    }
    if (body.runBy !== undefined && body.runBy !== null && typeof body.runBy !== "string") {
      res.status(400).json({ error: "runBy must be a string when provided" });
      return;
    }
    try {
      const result = await deployPipelineStep(db, config, dataDir, req.params.runId, stepIndex, {
        validateOnly: body.validateOnly,
        runBy: (body.runBy as string | null | undefined) ?? null,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
