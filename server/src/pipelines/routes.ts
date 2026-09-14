import { Router } from "express";
import type { Pool } from "pg";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, getPipeline, setPipelineStatus, pipelineHasRuns } from "./pipelines.js";
import type { Config } from "../config.js";
import { createPipelineRun, listPipelineRuns, getPipelineRunDetail, deployPipelineStep, updatePipelineRunTitle } from "./pipelineRuns.js";
import { requireSupabaseUser } from "../users/requireSupabaseUser.js";
import { TEST_LEVELS } from "../engine/routes.js";
import type { TestLevel } from "../engine/deploy.js";

/**
 * Validates a pipeline step deploy body — same options a manual deployment's Options tab exposes
 * (see validateComponentsBody in engine/routes.ts), minus `components`, which a pipeline step
 * always derives itself from the live diff rather than accepting from the client.
 */
function validateStepDeployBody(
  body: unknown
):
  | {
      value: {
        validateOnly: boolean;
        testLevel?: TestLevel;
        ignoreWarnings?: boolean;
        allowMissingFiles?: boolean;
        autoUpdatePackage?: boolean;
        runTests?: string[];
      };
    }
  | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { validateOnly, testLevel, ignoreWarnings, allowMissingFiles, autoUpdatePackage, runTests } = body as Record<string, unknown>;

  if (typeof validateOnly !== "boolean") return { error: "validateOnly is required and must be a boolean" };
  if (testLevel !== undefined && (typeof testLevel !== "string" || !TEST_LEVELS.includes(testLevel as TestLevel))) {
    return { error: `testLevel must be one of: ${TEST_LEVELS.join(", ")}` };
  }
  for (const [field, value] of Object.entries({ ignoreWarnings, allowMissingFiles, autoUpdatePackage })) {
    if (value !== undefined && typeof value !== "boolean") return { error: `${field} must be a boolean` };
  }
  if (runTests !== undefined && (!Array.isArray(runTests) || runTests.some((t) => typeof t !== "string" || t === ""))) {
    return { error: "runTests must be an array of non-empty strings" };
  }
  if (testLevel === "RunSpecifiedTests" && (!Array.isArray(runTests) || runTests.length === 0)) {
    return { error: "runTests is required and must be a non-empty array when testLevel is RunSpecifiedTests" };
  }

  return {
    value: {
      validateOnly,
      testLevel: testLevel as TestLevel | undefined,
      ignoreWarnings: ignoreWarnings as boolean | undefined,
      allowMissingFiles: allowMissingFiles as boolean | undefined,
      autoUpdatePackage: autoUpdatePackage as boolean | undefined,
      runTests: runTests as string[] | undefined,
    },
  };
}

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

export function createPipelinesRouter(db: Pool, config: Config, dataDir: string): Router {
  const router = Router();
  const auth = requireSupabaseUser(db, config);

  router.post("/api/pipelines", async (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const pipeline = await createPipeline(db, validated);
    res.status(201).json(pipeline);
  });

  router.get("/api/pipelines", async (_req, res) => {
    res.json(await listPipelines(db));
  });

  router.get("/api/pipelines/:id", async (req, res) => {
    const pipeline = await getPipeline(db, req.params.id);
    if (!pipeline) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.json(pipeline);
  });

  router.put("/api/pipelines/:id", async (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { name, connectionIds, trackComponentsIndependently } = validated;
    const existing = await getPipeline(db, req.params.id);
    if (!existing) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    // A run's stage semantics (source/target connection per hop, final stage) are read live off
    // the pipeline's connectionIds — see getPipelineRunDetail in pipelineRuns.ts. Letting the
    // sequence change under an existing run would silently reinterpret every deployment already
    // tagged to a step index, so it's blocked the same way deleting a pipeline with runs is.
    const connectionsChanged = JSON.stringify(existing.connectionIds) !== JSON.stringify(connectionIds);
    if (connectionsChanged && (await pipelineHasRuns(db, req.params.id))) {
      res.status(409).json({ error: "This pipeline has run history, so its connections can't be changed" });
      return;
    }
    const updated = await updatePipeline(db, req.params.id, { name, connectionIds, trackComponentsIndependently });
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(await getPipeline(db, req.params.id));
  });

  router.patch("/api/pipelines/:id/status", async (req, res) => {
    const { status } = req.body as { status?: unknown };
    if (status !== "active" && status !== "closed") {
      res.status(400).json({ error: "status is required and must be 'active' or 'closed'" });
      return;
    }
    const updated = await setPipelineStatus(db, req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(await getPipeline(db, req.params.id));
  });

  router.delete("/api/pipelines/:id", async (req, res) => {
    if (await pipelineHasRuns(db, req.params.id)) {
      res.status(409).json({ error: "This pipeline has runs and can't be deleted" });
      return;
    }
    const deleted = await deletePipeline(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/api/pipelines/:id/runs", async (req, res) => {
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
      const run = await createPipelineRun(db, {
        pipelineId: req.params.id,
        title: body.title as string | undefined,
        components: body.components as { type: string; fullName: string }[],
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/pipelines/:id/runs", async (req, res) => {
    res.json(await listPipelineRuns(db, req.params.id));
  });

  router.get("/api/pipeline-runs/:runId", async (req, res) => {
    const detail = await getPipelineRunDetail(db, req.params.runId);
    if (!detail) {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.json(detail);
  });

  router.patch("/api/pipeline-runs/:runId/title", async (req, res) => {
    const body = req.body as { title?: unknown };
    if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string or null" });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() || null : null;
    try {
      await updatePipelineRunTitle(db, req.params.runId, title);
    } catch {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.status(200).json({ id: req.params.runId });
  });

  router.post("/api/pipeline-runs/:runId/steps/:stepIndex/deploy", auth, async (req, res) => {
    const stepIndex = Number(req.params.stepIndex);
    const validated = validateStepDeployBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    try {
      const result = await deployPipelineStep(db, config, dataDir, req.params.runId, stepIndex, {
        ...validated.value,
        runBy: req.user!.name,
        runByUserId: req.user!.id,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
