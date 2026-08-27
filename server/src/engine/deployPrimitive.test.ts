import { describe, it, expect, vi } from "vitest";
import { deployZipToOrg } from "./deployPrimitive.js";

function fakeConnection() {
  return {
    metadata: {
      deploy: vi.fn().mockResolvedValue({ id: "0Af000000deploy" }),
      checkDeployStatus: vi.fn().mockResolvedValue({
        done: true,
        success: true,
        details: {
          componentSuccesses: [{ componentType: "ApexClass", fullName: "MyClass", success: "true" }],
        },
      }),
    },
  };
}

describe("deployZipToOrg", () => {
  it("deploys a zip and returns a success result with per-component detail", async () => {
    const conn = fakeConnection();
    const result = await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false });

    expect(conn.metadata.deploy).toHaveBeenCalledWith(
      Buffer.from("zip"),
      expect.objectContaining({ testLevel: "NoTestRun", checkOnly: false })
    );
    expect(result.success).toBe(true);
    expect(result.componentResults).toEqual([{ type: "ApexClass", fullName: "MyClass", success: true, errorMessage: undefined }]);
  });

  it("passes ignoreWarnings, allowMissingFiles, and autoUpdatePackage through to the deploy call, defaulting them to false", async () => {
    const conn = fakeConnection();
    await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false });
    expect(conn.metadata.deploy).toHaveBeenCalledWith(
      Buffer.from("zip"),
      expect.objectContaining({ ignoreWarnings: false, allowMissingFiles: false, autoUpdatePackage: false })
    );

    const conn2 = fakeConnection();
    await deployZipToOrg(conn2 as any, Buffer.from("zip"), {
      testLevel: "NoTestRun",
      checkOnly: false,
      ignoreWarnings: true,
      allowMissingFiles: true,
      autoUpdatePackage: true,
    });
    expect(conn2.metadata.deploy).toHaveBeenCalledWith(
      Buffer.from("zip"),
      expect.objectContaining({ ignoreWarnings: true, allowMissingFiles: true, autoUpdatePackage: true })
    );
  });

  it("polls until the deploy is done", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, success: true, details: { componentSuccesses: [] } });

    await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false }, 1);
    expect(conn.metadata.checkDeployStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces component failures", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus.mockResolvedValue({
      done: true,
      success: false,
      details: { componentFailures: [{ componentType: "ApexClass", fullName: "MyClass", success: "false", problem: "Compile error" }] },
    });

    const result = await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false });
    expect(result.success).toBe(false);
    expect(result.componentResults[0].errorMessage).toBe("Compile error");
  });
});
