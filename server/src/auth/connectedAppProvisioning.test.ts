import { describe, it, expect, vi } from "vitest";
import AdmZip from "adm-zip";
import { buildConnectedAppZip, deployConnectedAppZip, waitForConsumerKey } from "./connectedAppProvisioning.js";

describe("buildConnectedAppZip", () => {
  it("produces a zip with package.xml and a ConnectedApp component at the root", () => {
    const zip = buildConnectedAppZip({
      appName: "SFCowboy_Local",
      label: "SFCowboy Local",
      contactEmail: "admin@example.com",
      callbackUrl: "http://localhost:3000/oauth/callback",
    });

    const entries = new AdmZip(zip).getEntries();
    const entryNames = entries.map((e) => e.entryName);
    expect(entryNames).toContain("package.xml");
    expect(entryNames).toContain("connectedApps/SFCowboy_Local.connectedApp");

    const packageXml = entries.find((e) => e.entryName === "package.xml")!.getData().toString("utf-8");
    expect(packageXml).toContain("<members>SFCowboy_Local</members>");
    expect(packageXml).toContain("<name>ConnectedApp</name>");

    const appXml = entries.find((e) => e.entryName === "connectedApps/SFCowboy_Local.connectedApp")!
      .getData()
      .toString("utf-8");
    expect(appXml).toContain("<label>SFCowboy Local</label>");
    expect(appXml).toContain("<contactEmail>admin@example.com</contactEmail>");
    expect(appXml).toContain("<callbackUrl>http://localhost:3000/oauth/callback</callbackUrl>");
  });

  it("XML-escapes the label and contact email", () => {
    const zip = buildConnectedAppZip({
      appName: "SFCowboy_Local",
      label: `Bob & "The Builder"`,
      contactEmail: "admin@example.com",
      callbackUrl: "http://localhost:3000/oauth/callback",
    });
    const appXml = new AdmZip(zip)
      .getEntries()
      .find((e) => e.entryName === "connectedApps/SFCowboy_Local.connectedApp")!
      .getData()
      .toString("utf-8");
    expect(appXml).toContain("Bob &amp; &quot;The Builder&quot;");
  });
});

function fakeConnection(overrides: Partial<any> = {}) {
  return {
    metadata: {
      deploy: vi.fn().mockResolvedValue({ id: "0Af000000deploy" }),
      checkDeployStatus: vi.fn().mockResolvedValue({ done: true, success: true }),
    },
    tooling: {
      query: vi.fn().mockResolvedValue({ records: [] }),
    },
    ...overrides,
  };
}

describe("deployConnectedAppZip", () => {
  it("deploys the zip and resolves once the deploy succeeds", async () => {
    const conn = fakeConnection();
    await deployConnectedAppZip(conn as any, Buffer.from("zip"));
    expect(conn.metadata.deploy).toHaveBeenCalledWith(Buffer.from("zip"), expect.objectContaining({ singlePackage: true }));
  });

  it("polls until the deploy is done", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus.mockResolvedValueOnce({ done: false }).mockResolvedValueOnce({ done: true, success: true });
    await deployConnectedAppZip(conn as any, Buffer.from("zip"), 1);
    expect(conn.metadata.checkDeployStatus).toHaveBeenCalledTimes(2);
  });

  it("throws with the failure detail when the deploy fails", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus.mockResolvedValue({ done: true, success: false, details: { componentFailures: { problem: "duplicate value" } } });
    await expect(deployConnectedAppZip(conn as any, Buffer.from("zip"))).rejects.toThrow(/duplicate value/);
  });

  it("throws if the deploy does not complete within the timeout", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus.mockResolvedValue({ done: false });
    await expect(deployConnectedAppZip(conn as any, Buffer.from("zip"), 1, 5)).rejects.toThrow(/did not complete within/);
  });
});

describe("waitForConsumerKey", () => {
  it("returns the consumer key as soon as the query finds it", async () => {
    const conn = fakeConnection({
      tooling: { query: vi.fn().mockResolvedValue({ records: [{ ConsumerKey: "3MVG9abc123" }] }) },
    });
    const result = await waitForConsumerKey(conn as any, "SFCowboy Local");
    expect(result).toEqual({ consumerKey: "3MVG9abc123" });
  });

  it("polls until the ConnectedApplication record appears (activation delay)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [] })
      .mockResolvedValueOnce({ records: [{ ConsumerKey: "3MVG9abc123" }] });
    const conn = fakeConnection({ tooling: { query } });

    const result = await waitForConsumerKey(conn as any, "SFCowboy Local", { pollIntervalMs: 1 });
    expect(result).toEqual({ consumerKey: "3MVG9abc123" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("throws a descriptive error if the app never activates within the timeout", async () => {
    const conn = fakeConnection({ tooling: { query: vi.fn().mockResolvedValue({ records: [] }) } });
    await expect(
      waitForConsumerKey(conn as any, "SFCowboy Local", { pollIntervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow(/did not activate|timed out/i);
  });

  it("escapes single quotes in the app name for the SOQL query", async () => {
    const query = vi.fn().mockResolvedValue({ records: [{ ConsumerKey: "key" }] });
    const conn = fakeConnection({ tooling: { query } });
    await waitForConsumerKey(conn as any, "Bob's App");
    expect(query.mock.calls[0][0]).toContain("Bob\\'s App");
  });
});
