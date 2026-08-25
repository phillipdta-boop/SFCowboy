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
    // Validate before any DB write: an absent field would otherwise reach encrypt(undefined),
    // and a wrong-typed one would be persisted as garbage on the connection row.
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "request body must be a JSON object" });
      return;
    }
    const { nickname, remoteUrl, defaultBranch, authToken } = body as Record<string, unknown>;
    for (const [field, value] of Object.entries({ nickname, remoteUrl, defaultBranch, authToken })) {
      if (typeof value !== "string" || value === "") {
        res.status(400).json({ error: `${field} is required and must be a non-empty string` });
        return;
      }
    }
    const connection = createGitConnection(db, {
      nickname: nickname as string,
      remoteUrl: remoteUrl as string,
      defaultBranch: defaultBranch as string,
      authToken: authToken as string,
    });
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
