import { Router } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { getConnectionRow } from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";
import { listOrgComponents, describeAvailableTypes, type ComponentRef } from "./orgComponents.js";
import { ensureLocalClone } from "../connections/gitConnections.js";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";
import { decrypt } from "../crypto/encryption.js";
import { diffComponents, diffFileContents } from "./diff.js";
import {
  createDraftDeployment,
  attachComponentsAndQueue,
  updateDeploymentTitle,
  deleteDeployment,
  cloneDeployment,
  getDeployment,
  listDeployments,
  runDeployment,
  type DeployComponentSelection,
  type TestLevel,
} from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";

export async function resolveComponents(
  db: Database.Database,
  config: Config,
  dataDir: string,
  connectionId: string,
  types?: string[]
): Promise<{ kind: "org" | "git"; components: ComponentRef[]; sourceDir?: string }> {
  const row = getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return { kind: "org", components: await listOrgComponents(connection, { types }) };
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  const components = listGitComponents(sourceDir);
  return {
    kind: "git",
    components: types && types.length > 0 ? components.filter((c) => types.includes(c.type)) : components,
    sourceDir,
  };
}

export async function resolveAvailableTypes(
  db: Database.Database,
  config: Config,
  dataDir: string,
  connectionId: string
): Promise<string[]> {
  const row = getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return describeAvailableTypes(connection);
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  return Array.from(new Set(listGitComponents(sourceDir).map((c) => c.type))).sort();
}

const TEST_LEVELS: TestLevel[] = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];
const ACTIONS: DeployComponentSelection["action"][] = ["add", "modify", "delete"];

interface ValidatedDraftBody {
  title?: string;
  sourceConnectionId: string;
  targetConnectionId: string;
}

/** Validates a draft-creation request body before any row is written. */
function validateDraftBody(db: Database.Database, body: unknown): { value: ValidatedDraftBody } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { title, sourceConnectionId, targetConnectionId } = body as Record<string, unknown>;

  for (const [field, value] of Object.entries({ sourceConnectionId, targetConnectionId })) {
    if (typeof value !== "string" || value === "") return { error: `${field} is required and must be a non-empty string` };
  }
  if (title !== undefined && typeof title !== "string") {
    return { error: "title must be a string" };
  }

  const source = getConnectionRow(db, sourceConnectionId as string);
  if (!source) return { error: "sourceConnectionId does not match a known connection" };
  const target = getConnectionRow(db, targetConnectionId as string);
  if (!target) return { error: "targetConnectionId does not match a known connection" };

  return {
    value: {
      title: title as string | undefined,
      sourceConnectionId: sourceConnectionId as string,
      targetConnectionId: targetConnectionId as string,
    },
  };
}

interface ValidatedComponentsBody {
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly: boolean;
}

/**
 * Validates a components/options body shared by the run and save-progress endpoints. Running
 * requires at least one component; saving progress doesn't — the user may have unchecked
 * everything mid-edit, and that's a valid state to persist.
 */
function validateComponentsBody(
  targetConnectionType: string | null,
  body: unknown,
  { requireNonEmpty }: { requireNonEmpty: boolean }
): { value: ValidatedComponentsBody } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { components, testLevel, validateOnly } = body as Record<string, unknown>;

  if (!Array.isArray(components) || (requireNonEmpty && components.length === 0)) {
    return {
      error: requireNonEmpty
        ? "components is required and must be a non-empty array"
        : "components is required and must be an array",
    };
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

  const typed = components as DeployComponentSelection[];
  // Deletion is a destructiveChanges.xml deploy against an org; there's no git equivalent here.
  if (targetConnectionType !== "org" && typed.some((c) => c.action === "delete")) {
    return { error: "Deleting components is only supported for org targets" };
  }

  return {
    value: {
      components: typed,
      testLevel: testLevel as TestLevel,
      validateOnly: (validateOnly as boolean | undefined) ?? false,
    },
  };
}

/** Validates the component/options body for attaching to an existing draft and queuing it. */
function validateRunBody(targetConnectionType: string | null, body: unknown): { value: ValidatedComponentsBody } | { error: string } {
  return validateComponentsBody(targetConnectionType, body, { requireNonEmpty: true });
}

/** Validates the component/options body for saving progress on a draft without running it. */
function validateSaveBody(targetConnectionType: string | null, body: unknown): { value: ValidatedComponentsBody } | { error: string } {
  return validateComponentsBody(targetConnectionType, body, { requireNonEmpty: false });
}

export function createEngineRouter(db: Database.Database, config: Config, dataDir: string): Router {
  const router = Router();

  router.get("/api/diff", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const typesParam = req.query.types;
    const types = typeof typesParam === "string" && typesParam.length > 0 ? typesParam.split(",") : undefined;
    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId, types),
        resolveComponents(db, config, dataDir, targetConnectionId, types),
      ]);
      res.json(diffComponents(source.components, target.components));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/metadata-types", async (req, res) => {
    const connectionId = String(req.query.connectionId ?? "");
    try {
      res.json(await resolveAvailableTypes(db, config, dataDir, connectionId));
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
    const validated = validateDraftBody(db, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    const id = createDraftDeployment(db, {
      title: body.title,
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
    });

    res.status(201).json({ id });
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

  router.patch("/api/deployments/:id", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (deployment.status !== "pending") {
      res.status(400).json({ error: "components can only be saved while the deployment is still pending" });
      return;
    }
    const validated = validateSaveBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
    });

    res.status(200).json({ id: req.params.id });
  });

  router.patch("/api/deployments/:id/title", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const body = req.body as { title?: unknown };
    if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string or null" });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() || null : null;
    updateDeploymentTitle(db, req.params.id, title);

    res.status(200).json({ id: req.params.id });
  });

  router.delete("/api/deployments/:id", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    deleteDeployment(db, req.params.id);
    res.status(204).send();
  });

  router.post("/api/deployments/:id/clone", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const id = cloneDeployment(db, req.params.id);
    res.status(201).json({ id });
  });

  router.post("/api/deployments/:id/run", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const validated = validateRunBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
    });

    runDeployment(db, config, dataDir, req.params.id).catch((err) => {
      console.error(`Deployment ${req.params.id} failed unexpectedly`, err);
    });

    res.status(202).json({ id: req.params.id });
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
