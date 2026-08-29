import { describe, it, expect } from "vitest";
import { deriveComponentPositions, type StepDeployment } from "./pipelineRuns.js";
import { openDb, runMigrations } from "../db/client.js";
import { createPipeline } from "./pipelines.js";
import { createPipelineRun, listPipelineRuns } from "./pipelineRuns.js";

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

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("createPipelineRun", () => {
  it("creates a run with the given components", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    const { id } = createPipelineRun(db, {
      pipelineId: pipeline.id,
      title: "January batch",
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });
    expect(id).toBeTruthy();
  });

  it("throws for an unknown pipeline", () => {
    const db = freshDb();
    expect(() => createPipelineRun(db, { pipelineId: "nope", components: [{ type: "ApexClass", fullName: "A" }] })).toThrow(
      /no pipeline/i
    );
  });

  it("throws for a pipeline with fewer than 2 connections", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Solo", connectionIds: ["a"] });
    expect(() => createPipelineRun(db, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "A" }] })).toThrow(
      /at least two connections/i
    );
  });

  it("throws for an empty component list", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    expect(() => createPipelineRun(db, { pipelineId: pipeline.id, components: [] })).toThrow(/at least one component/i);
  });
});

describe("listPipelineRuns", () => {
  it("lists runs for a pipeline, most recent first, with a component-count summary", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b", "c"] });
    createPipelineRun(db, { pipelineId: pipeline.id, title: "First", components: [{ type: "ApexClass", fullName: "A" }] });
    createPipelineRun(db, {
      pipelineId: pipeline.id,
      title: "Second",
      components: [
        { type: "ApexClass", fullName: "B" },
        { type: "ApexClass", fullName: "C" },
      ],
    });

    const runs = listPipelineRuns(db, pipeline.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].title).toBe("Second");
    expect(runs[0].componentCount).toBe(2);
    expect(runs[0].componentsAtFinalStage).toBe(0);
    expect(runs[1].title).toBe("First");
  });

  it("does not mix runs belonging to a different pipeline", () => {
    const db = freshDb();
    const pipelineA = createPipeline(db, { name: "A", connectionIds: ["a", "b"] });
    const pipelineB = createPipeline(db, { name: "B", connectionIds: ["c", "d"] });
    createPipelineRun(db, { pipelineId: pipelineA.id, components: [{ type: "ApexClass", fullName: "X" }] });
    createPipelineRun(db, { pipelineId: pipelineB.id, components: [{ type: "ApexClass", fullName: "Y" }] });

    expect(listPipelineRuns(db, pipelineA.id)).toHaveLength(1);
    expect(listPipelineRuns(db, pipelineB.id)).toHaveLength(1);
  });
});
