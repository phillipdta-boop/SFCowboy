import { describe, it, expect } from "vitest";
import { deriveComponentPositions, type StepDeployment } from "./pipelineRuns.js";

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
});
