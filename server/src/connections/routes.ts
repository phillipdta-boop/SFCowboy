import { Router } from "express";
import type Database from "better-sqlite3";
import { listConnections, deleteConnection, getConnectionRow } from "./orgConnections.js";
import { createGitConnection } from "./gitConnections.js";

export function createConnectionsRouter(db: Database.Database): Router {
  const router = Router();

  router.get("/api/connections", (_req, res) => {
    res.json(listConnections(db));
  });

  router.post("/api/connections/git", (req, res) => {
    const { nickname, remoteUrl, defaultBranch, authToken } = req.body as {
      nickname: string;
      remoteUrl: string;
      defaultBranch: string;
      authToken: string;
    };
    const connection = createGitConnection(db, { nickname, remoteUrl, defaultBranch, authToken });
    res.status(201).json(connection);
  });

  router.delete("/api/connections/:id", (req, res) => {
    const connection = getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    deleteConnection(db, req.params.id);
    res.status(204).send();
  });

  return router;
}
