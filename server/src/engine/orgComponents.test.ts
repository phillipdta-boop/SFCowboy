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
      list: vi.fn().mockImplementation(async (queries: { type: string }[]) => {
        const type = queries[0].type;
        if (type === "ApexClass") {
          return [{ fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" }];
        }
        return [{ fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z" }];
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
          { fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z", lastModifiedByName: "Phillip Ta" },
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
