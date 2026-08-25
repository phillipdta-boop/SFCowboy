import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { deleteConnection, deletePipeline, fetchDeployments } from "./client.js";

function mockResponse(init: { ok: boolean; status?: number; statusText?: string; body?: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    statusText: init.statusText ?? "Error",
    json: () => (init.body !== undefined ? Promise.resolve(init.body) : Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

describe("deleteConnection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the response is not ok", async () => {
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(deleteConnection("conn-1")).rejects.toThrow();
  });

  it("surfaces the error message from the response body when present", async () => {
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: false, body: { error: "connection in use" } }));
    await expect(deleteConnection("conn-1")).rejects.toThrow("connection in use");
  });

  it("resolves when the response is ok, even with no body (204 No Content)", async () => {
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: true, status: 204 }));
    await expect(deleteConnection("conn-1")).resolves.toBeUndefined();
  });
});

describe("deletePipeline", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects when the response is not ok", async () => {
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: false, status: 500, statusText: "Server Error" }));
    await expect(deletePipeline("pipeline-1")).rejects.toThrow();
  });

  it("resolves when the response is ok, even with no body (204 No Content)", async () => {
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: true, status: 204 }));
    await expect(deletePipeline("pipeline-1")).resolves.toBeUndefined();
  });
});

describe("fetchDeployments", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves with the raw list rows (DeploymentSummary[]) — no components/items expected", async () => {
    const summaries = [
      {
        id: "d1",
        source_connection_id: "c1",
        target_connection_id: "c2",
        status: "succeeded",
        test_level: "NoTestRun",
        validate_only: 0,
        started_at: "2026-08-24T00:00:00.000Z",
        finished_at: "2026-08-24T00:01:00.000Z",
        error_detail: null,
        is_rollback_of: null,
      },
    ];
    (fetch as unknown as Mock).mockResolvedValue(mockResponse({ ok: true, body: summaries }));
    await expect(fetchDeployments()).resolves.toEqual(summaries);
  });
});
