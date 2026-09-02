import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Pool } from "pg";
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
  cancelDeployment,
  setRunBy,
  scheduleDeployment,
  cancelSchedule,
  getDeployment,
  listDeployments,
  runDeployment,
  type DeployComponentSelection,
  type TestLevel,
} from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);

// runBy is a self-reported display name from the browser (see web/src/displayName.ts), not an
// authenticated identity — this validates its shape only (a plain optional string), the same
// leniency the autosave/save path already gives other optional fields.
function extractRunBy(body: unknown): { value: string | null } | { error: string } {
  const { runBy } = (body ?? {}) as Record<string, unknown>;
  if (runBy === undefined || runBy === null) return { value: null };
  if (typeof runBy !== "string") return { error: "runBy must be a string" };
  const trimmed = runBy.trim();
  return { value: trimmed.length > 0 ? trimmed : null };
}

export async function resolveComponents(
  db: Pool,
  config: Config,
  dataDir: string,
  connectionId: string,
  types?: string[],
  // Overrides the connection's own default branch for this one call — used to keep a diff the
  // user is reviewing on the same branch a deployment created with that override will actually
  // read from/push to. Ignored for an org connection (there's no branch concept there).
  branchOverride?: string
): Promise<{ kind: "org" | "git"; components: ComponentRef[]; sourceDir?: string }> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return { kind: "org", components: await listOrgComponents(connection, { types }) };
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: branchOverride ?? row.default_branch,
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
  db: Pool,
  config: Config,
  dataDir: string,
  connectionId: string,
  branchOverride?: string
): Promise<string[]> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return describeAvailableTypes(connection);
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: branchOverride ?? row.default_branch,
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
  sourceBranch?: string;
  targetBranch?: string;
}

/** Validates a draft-creation request body before any row is written. */
async function validateDraftBody(db: Pool, body: unknown): Promise<{ value: ValidatedDraftBody } | { error: string }> {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { title, sourceConnectionId, targetConnectionId, sourceBranch, targetBranch } = body as Record<string, unknown>;

  for (const [field, value] of Object.entries({ sourceConnectionId, targetConnectionId })) {
    if (typeof value !== "string" || value === "") return { error: `${field} is required and must be a non-empty string` };
  }
  if (title !== undefined && typeof title !== "string") {
    return { error: "title must be a string" };
  }

  const source = await getConnectionRow(db, sourceConnectionId as string);
  if (!source) return { error: "sourceConnectionId does not match a known connection" };
  const target = await getConnectionRow(db, targetConnectionId as string);
  if (!target) return { error: "targetConnectionId does not match a known connection" };

  for (const [field, value, row] of [
    ["sourceBranch", sourceBranch, source],
    ["targetBranch", targetBranch, target],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") return { error: `${field} must be a non-empty string when provided` };
    if (row.type !== "git") return { error: `${field} only applies to a git connection` };
  }

  return {
    value: {
      title: title as string | undefined,
      sourceConnectionId: sourceConnectionId as string,
      targetConnectionId: targetConnectionId as string,
      sourceBranch: sourceBranch as string | undefined,
      targetBranch: targetBranch as string | undefined,
    },
  };
}

interface ValidatedComponentsBody {
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly: boolean;
  ignoreWarnings: boolean;
  allowMissingFiles: boolean;
  autoUpdatePackage: boolean;
  runTests: string[];
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
  const { components, testLevel, validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage, runTests } = body as Record<string, unknown>;

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
  for (const [field, value] of Object.entries({ validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage })) {
    if (value !== undefined && typeof value !== "boolean") {
      return { error: `${field} must be a boolean` };
    }
  }
  if (runTests !== undefined && (!Array.isArray(runTests) || runTests.some((t) => typeof t !== "string" || t === ""))) {
    return { error: "runTests must be an array of non-empty strings" };
  }
  // Salesforce requires an explicit test list for this test level — without one, a real deploy
  // request would just fail with a less helpful error from the Metadata API itself.
  if (requireNonEmpty && testLevel === "RunSpecifiedTests" && (!Array.isArray(runTests) || runTests.length === 0)) {
    return { error: "runTests is required and must be a non-empty array when testLevel is RunSpecifiedTests" };
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
      ignoreWarnings: (ignoreWarnings as boolean | undefined) ?? false,
      allowMissingFiles: (allowMissingFiles as boolean | undefined) ?? false,
      autoUpdatePackage: (autoUpdatePackage as boolean | undefined) ?? false,
      runTests: (runTests as string[] | undefined) ?? [],
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

export function createEngineRouter(db: Pool, config: Config, dataDir: string): Router {
  const router = Router();

  router.get("/api/diff", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const typesParam = req.query.types;
    const types = typeof typesParam === "string" && typesParam.length > 0 ? typesParam.split(",") : undefined;
    const sourceBranch = typeof req.query.sourceBranch === "string" ? req.query.sourceBranch : undefined;
    const targetBranch = typeof req.query.targetBranch === "string" ? req.query.targetBranch : undefined;
    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId, types, sourceBranch),
        resolveComponents(db, config, dataDir, targetConnectionId, types, targetBranch),
      ]);
      res.json(diffComponents(source.components, target.components));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/metadata-types", async (req, res) => {
    const connectionId = String(req.query.connectionId ?? "");
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    try {
      res.json(await resolveAvailableTypes(db, config, dataDir, connectionId, branch));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/diff/content", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const type = String(req.query.type ?? "");
    const fullName = String(req.query.fullName ?? "");
    const sourceBranch = typeof req.query.sourceBranch === "string" ? req.query.sourceBranch : undefined;
    const targetBranch = typeof req.query.targetBranch === "string" ? req.query.targetBranch : undefined;

    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId, undefined, sourceBranch),
        resolveComponents(db, config, dataDir, targetConnectionId, undefined, targetBranch),
      ]);

      const sourceFiles = source.kind === "git" && source.sourceDir ? readGitComponentFiles(source.sourceDir, type, fullName) : [];
      const targetFiles = target.kind === "git" && target.sourceDir ? readGitComponentFiles(target.sourceDir, type, fullName) : [];

      res.json(diffFileContents(sourceFiles, targetFiles));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments", async (req, res) => {
    const validated = await validateDraftBody(db, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    const id = await createDraftDeployment(db, {
      title: body.title,
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
      sourceBranch: body.sourceBranch,
      targetBranch: body.targetBranch,
    });

    res.status(201).json({ id });
  });

  router.get("/api/deployments", async (_req, res) => {
    res.json(await listDeployments(db));
  });

  router.get("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    res.json(deployment);
  });

  router.get("/api/deployments/:id/export", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    // Plain text, one component per line, in Salesforce's own metadata path convention —
    // "Type/FullName" — with fullName used exactly as Salesforce gives it, dots and all, so a
    // nested component (e.g. a CustomField's fullName is already "Object__c.Field__c") comes
    // through as "CustomField/Object__c.Field__c" without any special-casing per metadata level.
    // This is also the format the Import Components tab reads back in (see DeploymentEditor.tsx).
    const lines = deployment.components.map((c: { type: string; fullName: string }) => `${c.type}/${c.fullName}`);
    res.setHeader("Content-Disposition", `attachment; filename="deployment-${req.params.id}-components.txt"`);
    res.setHeader("Content-Type", "text/plain");
    res.send(lines.join("\n"));
  });

  router.get("/api/deployments/:id/export/package", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (!deployment.package_path || !fs.existsSync(deployment.package_path)) {
      res.status(404).json({ error: "No metadata package is available for this deployment" });
      return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="deployment-${req.params.id}-package.zip"`);
    res.setHeader("Content-Type", "application/zip");
    res.sendFile(path.resolve(deployment.package_path));
  });

  router.patch("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
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
    await attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });

    res.status(200).json({ id: req.params.id });
  });

  router.patch("/api/deployments/:id/title", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
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
    await updateDeploymentTitle(db, req.params.id, title);

    res.status(200).json({ id: req.params.id });
  });

  router.delete("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    await deleteDeployment(db, req.params.id);
    res.status(204).send();
  });

  router.post("/api/deployments/:id/clone", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const id = await cloneDeployment(db, req.params.id);
    res.status(201).json({ id });
  });

  router.post("/api/deployments/:id/run", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const validated = validateRunBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const runByResult = extractRunBy(req.body);
    if ("error" in runByResult) {
      res.status(400).json({ error: runByResult.error });
      return;
    }
    const body = validated.value;
    await attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });
    await setRunBy(db, req.params.id, runByResult.value);

    runDeployment(db, config, dataDir, req.params.id).catch((err) => {
      console.error(`Deployment ${req.params.id} failed unexpectedly`, err);
    });

    res.status(202).json({ id: req.params.id });
  });

  // Re-running a finished deployment: the frontend keeps its component editor open on the
  // original deployment's own page rather than making the user click through to a separate draft
  // first, so this takes the CURRENTLY edited selection directly (same body shape as /run) and
  // clones+attaches+runs it as a new row in one step — producing its own entry in the deployment
  // history without disturbing the original's result.
  router.post("/api/deployments/:id/rerun", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (!TERMINAL_STATUSES.has(deployment.status)) {
      res.status(400).json({ error: "Only a finished deployment can be re-run; use Deploy/Validate on a pending draft instead" });
      return;
    }
    const validated = validateRunBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const runByResult = extractRunBy(req.body);
    if ("error" in runByResult) {
      res.status(400).json({ error: runByResult.error });
      return;
    }
    const body = validated.value;
    const newId = await cloneDeployment(db, req.params.id);
    await attachComponentsAndQueue(db, newId, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });
    await setRunBy(db, newId, runByResult.value);

    runDeployment(db, config, dataDir, newId).catch((err) => {
      console.error(`Deployment ${newId} failed unexpectedly`, err);
    });

    res.status(202).json({ id: newId });
  });

  router.post("/api/deployments/:id/cancel", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    try {
      await cancelDeployment(db, config, req.params.id);
      res.status(202).json({ id: req.params.id });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments/:id/schedule", async (req, res) => {
    const { scheduledAt, runBy } = req.body as { scheduledAt?: unknown; runBy?: unknown };
    if (typeof scheduledAt !== "string" || Number.isNaN(Date.parse(scheduledAt))) {
      res.status(400).json({ error: "scheduledAt is required and must be a valid ISO timestamp" });
      return;
    }
    if (runBy !== undefined && runBy !== null && typeof runBy !== "string") {
      res.status(400).json({ error: "runBy must be a string when provided" });
      return;
    }
    try {
      await scheduleDeployment(db, req.params.id, scheduledAt, (runBy as string | null | undefined) ?? null);
      res.status(200).json(await getDeployment(db, req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments/:id/schedule/cancel", async (req, res) => {
    try {
      await cancelSchedule(db, req.params.id);
      res.status(200).json(await getDeployment(db, req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
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
