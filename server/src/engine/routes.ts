import { Router } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { getConnectionRow } from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";
import { listOrgComponents, type ComponentRef } from "./orgComponents.js";
import { ensureLocalClone } from "../connections/gitConnections.js";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";
import { decrypt } from "../crypto/encryption.js";
import { diffComponents, diffFileContents } from "./diff.js";
import { createDeployment, getDeployment, listDeployments, runDeployment, type DeployComponentSelection, type TestLevel } from "./deploy.js";

export async function resolveComponents(
  db: Database.Database,
  config: Config,
  dataDir: string,
  connectionId: string
): Promise<{ kind: "org" | "git"; components: ComponentRef[]; sourceDir?: string }> {
  const row = getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return { kind: "org", components: await listOrgComponents(connection) };
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  return { kind: "git", components: listGitComponents(sourceDir), sourceDir };
}

export function createEngineRouter(db: Database.Database, config: Config, dataDir: string): Router {
  const router = Router();

  router.get("/api/diff", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId),
        resolveComponents(db, config, dataDir, targetConnectionId),
      ]);
      res.json(diffComponents(source.components, target.components));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/diff/content", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const type = String(req.query.type ?? "");
    const fullName = String(req.query.fullName ?? "");

    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId),
        resolveComponents(db, config, dataDir, targetConnectionId),
      ]);

      const sourceFiles = source.kind === "git" && source.sourceDir ? readGitComponentFiles(source.sourceDir, type, fullName) : [];
      const targetFiles = target.kind === "git" && target.sourceDir ? readGitComponentFiles(target.sourceDir, type, fullName) : [];

      res.json(diffFileContents(sourceFiles, targetFiles));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments", (req, res) => {
    const body = req.body as {
      sourceConnectionId: string;
      targetConnectionId: string;
      components: DeployComponentSelection[];
      testLevel: TestLevel;
      validateOnly?: boolean;
    };
    const id = createDeployment(db, {
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly ?? false,
    });

    runDeployment(db, config, dataDir, id).catch((err) => {
      console.error(`Deployment ${id} failed unexpectedly`, err);
    });

    res.status(202).json({ id });
  });

  router.get("/api/deployments", (_req, res) => {
    res.json(listDeployments(db));
  });

  router.get("/api/deployments/:id", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    res.json(deployment);
  });

  return router;
}
