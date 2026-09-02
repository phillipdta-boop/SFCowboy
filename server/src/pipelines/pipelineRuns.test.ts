import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveComponentPositions, type StepDeployment } from "./pipelineRuns.js";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createPipeline, updatePipeline } from "./pipelines.js";
import { createPipelineRun, listPipelineRuns, getPipelineRunDetail, deployPipelineStep } from "./pipelineRuns.js";
import * as engineRoutes from "../engine/routes.js";
import * as deploy from "../engine/deploy.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "e".repeat(64);

const COMPONENTS = [
  { type: "ApexClass", fullName: "A" },
  { type: "ApexClass", fullName: "B" },
];

describe("deriveComponentPositions", () => {
  it("leaves every component at stage 0 with no deployments yet", () => {
    const result = deriveComponentPositions(COMPONENTS, [], true);
    expect(result).toEqual([
      { type: "ApexClass", fullName: "A", stage: 0, reachedAt: null },
      { type: "ApexClass", fullName: "B", stage: 0, reachedAt: null },
    ]);
  });

  it("advances a component past a step it succeeded in", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "succeeded" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result).toEqual([
      { type: "ApexClass", fullName: "A", stage: 1, reachedAt: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "B", stage: 1, reachedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("treats a component absent from a step's deployment as an automatic pass-through (already unchanged there)", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
        // B was already identical at this hop, so the diff never selected it — no item for B here.
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "B")).toEqual({
      type: "ApexClass",
      fullName: "B",
      stage: 1,
      reachedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("never advances a component past a step where its item failed", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "failed" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")).toEqual({ type: "ApexClass", fullName: "A", stage: 0, reachedAt: null });
  });

  // A rollback flips only the deployment's status; its items stay 'succeeded'. Reading the items
  // alone would keep an undone hop's components looking advanced.
  it("ignores a rolled-back deployment — its succeeded items never advance anyone", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "rolled_back",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.every((p) => p.stage === 0)).toBe(true);
  });

  it("ignores a cancelled deployment — it never advances anyone", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "cancelled",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.every((p) => p.stage === 0)).toBe(true);
  });

  it("ignores a validate-only deployment entirely — it never advances anyone", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: true,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.every((p) => p.stage === 0)).toBe(true);
  });

  it("in independent mode, a later retry can advance a component that failed an earlier attempt at the same step", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "failed" }],
      },
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")).toEqual({
      type: "ApexClass",
      fullName: "A",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("in independent mode, one component's failure at a step never blocks another component that succeeded the same step", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")!.stage).toBe(0);
    expect(result.find((p) => p.fullName === "B")!.stage).toBe(1);
  });

  it("in blocked mode, one component's failure holds back even the components that individually succeeded the same attempt", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, false);
    expect(result.find((p) => p.fullName === "A")!.stage).toBe(0);
    expect(result.find((p) => p.fullName === "B")!.stage).toBe(0);
  });

  it("in blocked mode, a later attempt that clears everyone still pending advances the whole batch together", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
        // B isn't in this retry's items at all — it was already fine, so only A was re-deployed —
        // but B still counts as "cleared" by this attempt since it has no failing item in it.
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, false);
    expect(result.find((p) => p.fullName === "A")).toEqual({
      type: "ApexClass",
      fullName: "A",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result.find((p) => p.fullName === "B")).toEqual({
      type: "ApexClass",
      fullName: "B",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("advances a component through multiple consecutive steps", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
      {
        stepIndex: 1,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions([{ type: "ApexClass", fullName: "A" }], deployments, true);
    expect(result).toEqual([{ type: "ApexClass", fullName: "A", stage: 2, reachedAt: "2026-01-02T00:00:00.000Z" }]);
  });

  it("does not advance a component when a failed deployment has no item for it (no pass-through on failed attempts)", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")).toEqual({
      type: "ApexClass",
      fullName: "A",
      stage: 0,
      reachedAt: null,
    });
    expect(result.find((p) => p.fullName === "B")).toEqual({
      type: "ApexClass",
      fullName: "B",
      stage: 0,
      reachedAt: null,
    });
  });
});

describe("createPipelineRun", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a run with the given components", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    const { id } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      title: "January batch",
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });
    expect(id).toBeTruthy();
  });

  it("throws for an unknown pipeline", async () => {
    db = await openTestDb();
    await expect(
      createPipelineRun(db.pool, { pipelineId: "nope", components: [{ type: "ApexClass", fullName: "A" }] })
    ).rejects.toThrow(/no pipeline/i);
  });

  it("throws for a pipeline with fewer than 2 connections", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Solo", connectionIds: ["a"] });
    await expect(
      createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "A" }] })
    ).rejects.toThrow(/at least two connections/i);
  });

  it("throws for an empty component list", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    await expect(createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [] })).rejects.toThrow(/at least one component/i);
  });
});

describe("listPipelineRuns", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("lists runs for a pipeline, most recent first, with a component-count summary", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b", "c"] });
    await createPipelineRun(db.pool, { pipelineId: pipeline.id, title: "First", components: [{ type: "ApexClass", fullName: "A" }] });
    await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      title: "Second",
      components: [
        { type: "ApexClass", fullName: "B" },
        { type: "ApexClass", fullName: "C" },
      ],
    });

    const runs = await listPipelineRuns(db.pool, pipeline.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].title).toBe("Second");
    expect(runs[0].componentCount).toBe(2);
    expect(runs[0].componentsAtFinalStage).toBe(0);
    expect(runs[1].title).toBe("First");
  });

  it("does not mix runs belonging to a different pipeline", async () => {
    db = await openTestDb();
    const pipelineA = await createPipeline(db.pool, { name: "A", connectionIds: ["a", "b"] });
    const pipelineB = await createPipeline(db.pool, { name: "B", connectionIds: ["c", "d"] });
    await createPipelineRun(db.pool, { pipelineId: pipelineA.id, components: [{ type: "ApexClass", fullName: "X" }] });
    await createPipelineRun(db.pool, { pipelineId: pipelineB.id, components: [{ type: "ApexClass", fullName: "Y" }] });

    expect(await listPipelineRuns(db.pool, pipelineA.id)).toHaveLength(1);
    expect(await listPipelineRuns(db.pool, pipelineB.id)).toHaveLength(1);
  });
});

describe("getPipelineRunDetail", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("returns undefined for an unknown run", async () => {
    db = await openTestDb();
    expect(await getPipelineRunDetail(db.pool, "nonexistent")).toBeUndefined();
  });

  it("returns the run's pipeline context, component list, and derived positions", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b", "c"] });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      title: "Batch 1",
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    const detail = (await getPipelineRunDetail(db.pool, runId))!;
    expect(detail.pipelineId).toBe(pipeline.id);
    expect(detail.connectionIds).toEqual(["a", "b", "c"]);
    expect(detail.trackComponentsIndependently).toBe(true);
    expect(detail.componentList).toEqual([{ type: "ApexClass", fullName: "MyClass" }]);
    expect(detail.deployments).toEqual([]);
    expect(detail.positions).toEqual([{ type: "ApexClass", fullName: "MyClass", stage: 0, reachedAt: null }]);
  });

  it("includes tagged deployments with their items, ordered by step then start time", async () => {
    db = await openTestDb();
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b", "c"] });
    const { id: runId } = await createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    const now = new Date().toISOString();
    await db.pool.query(
      `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, finished_at, pipeline_run_id, pipeline_step_index)
       VALUES ('d1', 'a', 'b', '[]', 'NoTestRun', 'succeeded', 0, $1, $2, $3, 0)`,
      [now, now, runId]
    );
    await db.pool.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ('i1', 'd1', 'ApexClass', 'MyClass', 'modify', 'succeeded')`
    );

    const detail = (await getPipelineRunDetail(db.pool, runId))!;
    expect(detail.deployments).toHaveLength(1);
    expect(detail.deployments[0]).toMatchObject({ id: "d1", stepIndex: 0, status: "succeeded" });
    expect(detail.deployments[0].items).toEqual([{ metadataType: "ApexClass", apiName: "MyClass", status: "succeeded" }]);
    expect(detail.positions[0].stage).toBe(1);
  });
});

describe("deployPipelineStep", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  const config: Config = {
    port: 3000,
    dbPath: ":memory:",
    encryptionKey: "e".repeat(64),
    oauthCallbackUrl: "https://x/oauth/callback",
    sfClientId: "3MVG9fake",
  };

  it("diffs only the eligible components, creates a tagged deployment, and runs it", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? { kind: "org", components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01" }] }
        : { kind: "org", components: [] }
    );
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const result = await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    expect(result.skipped).toBe(false);
    expect(runSpy).toHaveBeenCalledWith(db.pool, config, "/tmp/data", result.deploymentId);
    const detail = (await getPipelineRunDetail(db.pool, runId))!;
    expect(detail.deployments).toHaveLength(1);
    expect(detail.deployments[0].stepIndex).toBe(0);
  });

  it("marks a step succeeded without touching Salesforce when every eligible component is already unchanged", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockResolvedValue({
      kind: "org",
      components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01" }],
    });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const result = await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    expect(result.skipped).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    const detail = (await getPipelineRunDetail(db.pool, runId))!;
    expect(detail.deployments[0].status).toBe("succeeded");
    expect(detail.positions[0].stage).toBe(1);
  });

  // Regression guard: the hop used to attach items only for the CHANGED components, so an
  // unchanged sibling had no item at all — and "no item + failed attempt" means "did not clear",
  // which silently turned independent tracking into blocked tracking.
  it("advances a confirmed-unchanged component even when a changed sibling's deploy fails", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      components: [
        { type: "ApexClass", fullName: "Changed" },
        { type: "ApexClass", fullName: "Same" },
      ],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? {
            kind: "org",
            components: [
              { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-01-02" },
              { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01" },
            ],
          }
        : {
            kind: "org",
            components: [
              { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-01-01" },
              { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01" },
            ],
          }
    );
    vi.spyOn(deploy, "runDeployment").mockImplementation(async (database, _cfg, _dir, deploymentId) => {
      await database.query(`UPDATE deployment_items SET status = 'failed' WHERE deployment_id = $1 AND api_name = 'Changed'`, [deploymentId]);
      await database.query(`UPDATE deployments SET status = 'failed', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    });

    await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    const detail = (await getPipelineRunDetail(db.pool, runId))!;
    // Both have an item: "Changed" from the real deploy, "Same" as an explicit confirmation.
    expect(detail.deployments[0].items.map((i) => i.apiName).sort()).toEqual(["Changed", "Same"]);
    expect(detail.positions.find((p) => p.fullName === "Changed")!.stage).toBe(0);
    expect(detail.positions.find((p) => p.fullName === "Same")!.stage).toBe(1);
  });

  it("gives a component missing from BOTH orgs no item, so it can't ride a succeeded hop through", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      components: [
        { type: "ApexClass", fullName: "Real" },
        { type: "ApexClass", fullName: "Vanished" },
      ],
    });

    // "Vanished" is in neither org, so diffComponents emits no row for it at all.
    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? { kind: "org", components: [{ type: "ApexClass", fullName: "Real", lastModifiedDate: "2026-01-02" }] }
        : { kind: "org", components: [{ type: "ApexClass", fullName: "Real", lastModifiedDate: "2026-01-01" }] }
    );
    vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const { deploymentId } = await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    const items = (await db.pool.query(`SELECT api_name FROM deployment_items WHERE deployment_id = $1`, [deploymentId])).rows;
    expect(items.map((i) => i.api_name)).toEqual(["Real"]);
  });

  it("throws when no components are eligible for the requested step", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const finalTarget = await createOrgConnection(db.pool, { nickname: "Prod", orgType: "production", instanceUrl: "https://z", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id, finalTarget.id] });
    const { id: runId } = await createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    // Nobody has succeeded step 0 yet, so step 1 (QA -> Prod) has nothing eligible.
    await expect(deployPipelineStep(db.pool, config, "/tmp/data", runId, 1, { validateOnly: false })).rejects.toThrow(/no components/i);
  });

  // The deploy endpoint returns 202 while the hop is still running, so the UI's buttons re-enable
  // before anything has advanced — a second click must not start a concurrent deploy to the same org.
  it("throws when a deployment for the same step is still in progress", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? { kind: "org", components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-02" }] }
        : { kind: "org", components: [] }
    );
    // Leaves the deployment mid-flight, exactly as the real fire-and-forget runDeployment would.
    vi.spyOn(deploy, "runDeployment").mockImplementation(async (database, _cfg, _dir, deploymentId) => {
      await database.query(`UPDATE deployments SET status = 'deploying' WHERE id = $1`, [deploymentId]);
    });

    await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    await expect(deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false })).rejects.toThrow(
      /already in progress/i
    );
    expect((await getPipelineRunDetail(db.pool, runId))!.deployments).toHaveLength(1);
  });

  it("throws for an out-of-range step index", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = await createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    await expect(deployPipelineStep(db.pool, config, "/tmp/data", runId, 5, { validateOnly: false })).rejects.toThrow(/step/i);
  });

  it("throws for an unknown run", async () => {
    db = await openTestDb();
    await expect(deployPipelineStep(db.pool, config, "/tmp/data", "nonexistent", 0, { validateOnly: false })).rejects.toThrow(/no pipeline run/i);
  });

  // Blocked mode was only ever exercised through the pure derivation function; this drives it
  // through the real DB-backed orchestration instead.
  it("in blocked mode, one component's failure holds the whole batch at the step", async () => {
    db = await openTestDb();
    const source = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [source.id, target.id] });
    await updatePipeline(db.pool, pipeline.id, { name: "Main", connectionIds: [source.id, target.id], trackComponentsIndependently: false });
    const { id: runId } = await createPipelineRun(db.pool, {
      pipelineId: pipeline.id,
      components: [
        { type: "ApexClass", fullName: "A" },
        { type: "ApexClass", fullName: "B" },
      ],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? {
            kind: "org",
            components: [
              { type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-02" },
              { type: "ApexClass", fullName: "B", lastModifiedDate: "2026-01-02" },
            ],
          }
        : {
            kind: "org",
            components: [
              { type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-01" },
              { type: "ApexClass", fullName: "B", lastModifiedDate: "2026-01-01" },
            ],
          }
    );
    vi.spyOn(deploy, "runDeployment").mockImplementation(async (database, _cfg, _dir, deploymentId) => {
      await database.query(`UPDATE deployment_items SET status = 'failed' WHERE deployment_id = $1 AND api_name = 'A'`, [deploymentId]);
      await database.query(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1 AND api_name = 'B'`, [deploymentId]);
      await database.query(`UPDATE deployments SET status = 'failed', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    });

    await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });

    // B succeeded on its own, but blocked mode holds it back with A.
    expect((await getPipelineRunDetail(db.pool, runId))!.positions.every((p) => p.stage === 0)).toBe(true);

    // …and both are therefore still eligible for the same step on the retry.
    const { deploymentId: retryId } = await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });
    const retry = (await db.pool.query(`SELECT component_list FROM deployments WHERE id = $1`, [retryId])).rows[0];
    expect(JSON.parse(retry.component_list).map((c: any) => c.fullName).sort()).toEqual(["A", "B"]);
  });

  it("walks a component through every hop of a three-stage pipeline, one step at a time", async () => {
    db = await openTestDb();
    const dev = await createOrgConnection(db.pool, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const qa = await createOrgConnection(db.pool, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const prod = await createOrgConnection(db.pool, { nickname: "Prod", orgType: "production", instanceUrl: "https://z", refreshToken: "r", clientId: "c" });
    const pipeline = await createPipeline(db.pool, { name: "Main", connectionIds: [dev.id, qa.id, prod.id] });
    const { id: runId } = await createPipelineRun(db.pool, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    // Dev is ahead of QA (step 0 is a real "modified" deploy) and Prod has never seen the class
    // (step 1 is a real "added" deploy) — so neither hop takes the nothing-to-do shortcut.
    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) => {
      if (connectionId === prod.id) return { kind: "org", components: [] };
      const lastModifiedDate = connectionId === dev.id ? "2026-01-02" : "2026-01-01";
      return { kind: "org", components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate }] };
    });
    vi.spyOn(deploy, "runDeployment").mockImplementation(async (database, _cfg, _dir, deploymentId) => {
      await database.query(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1`, [deploymentId]);
      await database.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    });

    await deployPipelineStep(db.pool, config, "/tmp/data", runId, 0, { validateOnly: false });
    expect((await getPipelineRunDetail(db.pool, runId))!.positions[0].stage).toBe(1);

    await deployPipelineStep(db.pool, config, "/tmp/data", runId, 1, { validateOnly: false });
    const final = (await getPipelineRunDetail(db.pool, runId))!;
    expect(final.positions[0].stage).toBe(2);
    expect(final.deployments.map((d) => d.stepIndex)).toEqual([0, 1]);
  });
});
