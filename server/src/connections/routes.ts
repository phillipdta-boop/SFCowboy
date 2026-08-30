import { Router } from "express";
import type Database from "better-sqlite3";
import {
  listConnections,
  getConnectionSummary,
  deleteConnection,
  getConnectionRow,
  renameConnection,
  setMinCodeCoveragePercent,
  testOrgConnection,
} from "./orgConnections.js";
import { createGitConnection, testGitConnection } from "./gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import type { Config } from "../config.js";

export function createConnectionsRouter(db: Database.Database, config: Config): Router {
  const router = Router();

  router.get("/api/connections", (_req, res) => {
    res.json(listConnections(db));
  });

  router.get("/api/connections/:id", (req, res) => {
    const connection = getConnectionSummary(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    res.json(connection);
  });

  router.patch("/api/connections/:id", (req, res) => {
    const connection = getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    const { nickname, minCodeCoveragePercent } = req.body as { nickname?: unknown; minCodeCoveragePercent?: unknown };
    if (typeof nickname !== "string" || !nickname.trim()) {
      res.status(400).json({ error: "nickname is required and must be a non-empty string" });
      return;
    }
    if (minCodeCoveragePercent !== undefined && minCodeCoveragePercent !== null && typeof minCodeCoveragePercent !== "number") {
      res.status(400).json({ error: "minCodeCoveragePercent must be a number or null when provided" });
      return;
    }
    try {
      renameConnection(db, req.params.id, nickname);
      if (minCodeCoveragePercent !== undefined) {
        setMinCodeCoveragePercent(db, req.params.id, minCodeCoveragePercent);
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json({ id: req.params.id });
  });

  router.post("/api/connections/:id/test", async (req, res) => {
    const connection = getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    const result =
      connection.type === "org"
        ? await testOrgConnection(db, config, req.params.id)
        : await testGitConnection({
            remoteUrl: connection.remote_url,
            authToken: connection.encrypted_auth_token ? decrypt(connection.encrypted_auth_token) : undefined,
          });
    res.json(result);
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
