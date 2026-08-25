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
import { rollbackDeployment } from "./rollback.js";

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

const TEST_LEVELS: TestLevel[] = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];
const ACTIONS: DeployComponentSelection["action"][] = ["add", "modify", "delete"];

interface ValidatedDeploymentBody {
  sourceConnectionId: string;
  targetConnectionId: string;
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly: boolean;
}

/** Validates a deployment request body before any row is written. */
function validateDeploymentBody(
  db: Database.Database,
  body: unknown
): { value: ValidatedDeploymentBody } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { sourceConnectionId, targetConnectionId, components, testLevel, validateOnly } = body as Record<string, unknown>;

  for (const [field, value] of Object.entries({ sourceConnectionId, targetConnectionId })) {
    if (typeof value !== "string" || value === "") return { error: `${field} is required and must be a non-empty string` };
  }
  if (!Array.isArray(components) || components.length === 0) {
    return { error: "components is required and must be a non-empty array" };
  }
  for (const c of components as unknown[]) {
    if (typeof c !== "object" || c === null) return { error: "each component must be an object" };
    const { type, fullName, action } = c as Record<string, unknown>;
    if (typeof type !== "string" || type === "") return { error: "each component needs a non-empty type" };
    if (typeof fullName !== "string" || fullName === "") return { error: "each component needs a non-empty fullName" };
    if (typeof action !== "string" || !ACTIONS.includes(action as DeployComponentSelection["action"])) {
      return { error: `each component's action must be one of: ${ACTIONS.join(", ")}` };
    }
  }
  if (typeof testLevel !== "string" || !TEST_LEVELS.includes(testLevel as TestLevel)) {
    return { error: `testLevel must be one of: ${TEST_LEVELS.join(", ")}` };
  }
  if (validateOnly !== undefined && typeof validateOnly !== "boolean") {
    return { error: "validateOnly must be a boolean" };
  }

  const source = getConnectionRow(db, sourceConnectionId as string);
  if (!source) return { error: "sourceConnectionId does not match a known connection" };
  const target = getConnectionRow(db, targetConnectionId as string);
  if (!target) return { error: "targetConnectionId does not match a known connection" };

  const typed = components as DeployComponentSelection[];
  // Deletion is a destructiveChanges.xml deploy against an org; there's no git equivalent here.
  if (target.type !== "org" && typed.some((c) => c.action === "delete")) {
    return { error: "Deleting components is only supported for org targets" };
  }

  return {
    value: {
      sourceConnectionId: sourceConnectionId as string,
      targetConnectionId: targetConnectionId as string,
      components: typed,
      testLevel: testLevel as TestLevel,
      validateOnly: (validateOnly as boolean | undefined) ?? false,
    },
  };
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
    const validated = validateDeploymentBody(db, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    const id = createDeployment(db, {
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
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

  router.post("/api/deployments/:id/rollback", async (req, res) => {
    try {
      const rollbackId = await rollbackDeployment(db, config, req.params.id);
      res.status(202).json({ id: rollbackId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
