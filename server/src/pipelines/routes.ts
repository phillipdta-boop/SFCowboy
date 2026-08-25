import { Router } from "express";
import type Database from "better-sqlite3";
import { createPipeline, listPipelines, updatePipeline, deletePipeline } from "./pipelines.js";

export function createPipelinesRouter(db: Database.Database): Router {
  const router = Router();

  router.post("/api/pipelines", (req, res) => {
    const { name, connectionIds } = req.body as { name: string; connectionIds: string[] };
    const pipeline = createPipeline(db, { name, connectionIds });
    res.status(201).json(pipeline);
  });

  router.get("/api/pipelines", (_req, res) => {
    res.json(listPipelines(db));
  });

  router.put("/api/pipelines/:id", (req, res) => {
    const { name, connectionIds } = req.body as { name: string; connectionIds: string[] };
    const updated = updatePipeline(db, req.params.id, { name, connectionIds });
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json({ id: req.params.id, name, connectionIds });
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
