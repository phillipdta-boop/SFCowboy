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
    updatePipeline(db, req.params.id, { name, connectionIds });
    res.status(200).json({ id: req.params.id, name, connectionIds });
  });

  router.delete("/api/pipelines/:id", (req, res) => {
    deletePipeline(db, req.params.id);
    res.status(204).send();
  });

  return router;
}
