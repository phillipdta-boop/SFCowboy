import { describe, it, expect, vi } from "vitest";
import { listOrgComponents, retrieveOrgZip, describeAvailableTypes } from "./orgComponents.js";

function fakeConnection(overrides: Partial<any> = {}) {
  return {
    metadata: {
      describe: vi.fn().mockResolvedValue({
        metadataObjects: [
          { xmlName: "ApexClass", childXmlNames: [] },
          { xmlName: "CustomObject", childXmlNames: [] },
        ],
      }),
      // A real listMetadata call can cover several types at once (see LIST_METADATA_BATCH_SIZE),
      // so this mimics Salesforce by returning results for every requested type in the batch,
      // not just the first one.
      list: vi.fn().mockImplementation(async (queries: { type: string }[]) => {
        const requested = new Set(queries.map((q) => q.type));
        const all = [
          { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
          { type: "CustomObject", fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z" },
        ];
        return all.filter((item) => requested.has(item.type));
      }),
      retrieve: vi.fn().mockResolvedValue({ id: "09S000000retrieve" }),
      checkRetrieveStatus: vi.fn().mockResolvedValue({ done: true, success: true, zipFile: Buffer.from("zipdata").toString("base64") }),
    },
    ...overrides,
  };
}

describe("listOrgComponents", () => {
  it("enumerates components across all describe-able metadata types when no types are given", async () => {
    const conn = fakeConnection();
    const components = await listOrgComponents(conn as any);

    expect(components).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z", lastModifiedByName: undefined },
        { type: "CustomObject", fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z", lastModifiedByName: undefined },
      ])
    );
  });

  it("captures lastModifiedByName from the list() response", async () => {
    const conn = fakeConnection({
      metadata: {
        ...fakeConnection().metadata,
        list: vi.fn().mockResolvedValue([
          { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z", lastModifiedByName: "Phillip Ta" },
        ]),
      },
    });
    const components = await listOrgComponents(conn as any, { types: ["ApexClass"] });
    expect(components).toEqual([
      { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z", lastModifiedByName: "Phillip Ta" },
    ]);
  });

  // The whole point of letting a caller pass `types` is to skip describe() and the list() calls
  // for every unwanted type — describe() enumerates 400+ types on a real org, and list() is one
  // network round-trip per type, so listing everything is what makes diffing feel slow.
  it("only lists the given types and skips describe() entirely when types are provided", async () => {
    const conn = fakeConnection();
    const components = await listOrgComponents(conn as any, { types: ["ApexClass"] });

    expect(conn.metadata.describe).not.toHaveBeenCalled();
    expect(conn.metadata.list).toHaveBeenCalledTimes(1);
    expect(conn.metadata.list).toHaveBeenCalledWith([{ type: "ApexClass" }]);
    expect(components).toEqual([{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" }]);
  });

  // Salesforce's listMetadata call accepts at most 3 queries per request. Batching types into
  // groups of 3 turns what used to be one network round trip per type into ceil(N/3) — and
  // firing every batch at once instead of awaiting them one at a time is what actually collapses
  // the wall-clock time, since round trips no longer queue up behind each other.
  it("batches types into groups of 3 and issues every batch concurrently, not sequentially", async () => {
    const conn = fakeConnection();
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    conn.metadata.list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    const promise = listOrgComponents(conn as any, {
      types: ["ApexClass", "ApexTrigger", "CustomObject", "CustomField", "Layout"],
    });

    // Flush pending microtasks without resolving either list() call — if the batches were
    // awaited one at a time, the second call could not have been issued yet at this point.
    await Promise.resolve();
    await Promise.resolve();

    expect(conn.metadata.list).toHaveBeenCalledTimes(2);
    expect(conn.metadata.list).toHaveBeenNthCalledWith(1, [
      { type: "ApexClass" },
      { type: "ApexTrigger" },
      { type: "CustomObject" },
    ]);
    expect(conn.metadata.list).toHaveBeenNthCalledWith(2, [{ type: "CustomField" }, { type: "Layout" }]);

    // Resolve out of order to confirm the result doesn't depend on completion order either.
    resolveSecond([{ type: "Layout", fullName: "Account-Layout" }]);
    resolveFirst([{ type: "ApexClass", fullName: "MyClass" }]);

    const components = await promise;
    expect(components).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "MyClass", lastModifiedDate: undefined, lastModifiedByName: undefined },
        { type: "Layout", fullName: "Account-Layout", lastModifiedDate: undefined, lastModifiedByName: undefined },
      ])
    );
  });

  it("tags each result with its own type from the response when a batch covers multiple types", async () => {
    const conn = fakeConnection();
    conn.metadata.list = vi.fn().mockResolvedValue([
      { type: "ApexClass", fullName: "MyClass" },
      { type: "ApexTrigger", fullName: "MyTrigger" },
    ]);

    const components = await listOrgComponents(conn as any, { types: ["ApexClass", "ApexTrigger"] });

    expect(conn.metadata.list).toHaveBeenCalledTimes(1);
    expect(conn.metadata.list).toHaveBeenCalledWith([{ type: "ApexClass" }, { type: "ApexTrigger" }]);
    expect(components).toEqual([
      { type: "ApexClass", fullName: "MyClass", lastModifiedDate: undefined, lastModifiedByName: undefined },
      { type: "ApexTrigger", fullName: "MyTrigger", lastModifiedDate: undefined, lastModifiedByName: undefined },
    ]);
  });
});

describe("describeAvailableTypes", () => {
  it("returns the sorted list of metadata type names available in the org", async () => {
    const conn = fakeConnection();
    const types = await describeAvailableTypes(conn as any);
    expect(types).toEqual(["ApexClass", "CustomObject"]);
  });
});

describe("retrieveOrgZip", () => {
  it("submits a retrieve request and polls until done, returning the zip buffer", async () => {
    const conn = fakeConnection();
    const zip = await retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }]);

    expect(conn.metadata.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        unpackaged: { types: [{ name: "ApexClass", members: ["MyClass"] }], version: expect.any(String) },
      })
    );
    expect(zip.toString()).toBe("zipdata");
  });

  it("polls again if the retrieve is not yet done", async () => {
    const conn = fakeConnection();
    conn.metadata.checkRetrieveStatus
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, success: true, zipFile: Buffer.from("zipdata").toString("base64") });

    const zip = await retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }], { pollIntervalMs: 1 });
    expect(conn.metadata.checkRetrieveStatus).toHaveBeenCalledTimes(2);
    expect(zip.toString()).toBe("zipdata");
  });

  it("throws if the retrieve times out", async () => {
    const conn = fakeConnection();
    conn.metadata.checkRetrieveStatus.mockResolvedValue({ done: false });

    await expect(
      retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }], { pollIntervalMs: 1, timeoutMs: 10 })
    ).rejects.toThrow(/did not complete within/);
  });

  it("throws if the retrieve fails", async () => {
    const conn = fakeConnection();
    conn.metadata.checkRetrieveStatus.mockResolvedValue({
      done: true,
      success: false,
      status: "Failed",
      errorMessage: "Insufficient privileges",
    });

    await expect(
      retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }])
    ).rejects.toThrow(/failed: Insufficient privileges/);
  });
});
