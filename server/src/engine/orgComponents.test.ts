import { describe, it, expect, vi } from "vitest";
import { listOrgComponents, retrieveOrgZip } from "./orgComponents.js";

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
  it("enumerates components across all describe-able metadata types", async () => {
    const conn = fakeConnection();
    const components = await listOrgComponents(conn as any);

    expect(components).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
        { type: "CustomObject", fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z" },
      ])
    );
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
