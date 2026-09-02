import { describe, it, expect, vi } from "vitest";
import { AuthInfo, Connection } from "@salesforce/core";
import * as orgConnections from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";

vi.mock("@salesforce/core", () => ({
  AuthInfo: { create: vi.fn().mockResolvedValue({ fakeAuthInfo: true }) },
  Connection: { create: vi.fn().mockResolvedValue({ fakeConnection: true }) },
}));

describe("buildOrgConnection", () => {
  it("builds a Connection from a freshly refreshed access token", async () => {
    vi.spyOn(orgConnections, "getConnectionRow").mockResolvedValue({ id: "conn1", type: "org" } as any);
    vi.spyOn(orgConnections, "getValidAccessToken").mockResolvedValue({
      accessToken: "acc",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const conn = await buildOrgConnection({} as any, "conn1", {} as any);

    expect(AuthInfo.create).toHaveBeenCalledWith({
      accessTokenOptions: { accessToken: "acc", instanceUrl: "https://myorg.my.salesforce.com" },
    });
    expect(Connection.create).toHaveBeenCalledWith({ authInfo: { fakeAuthInfo: true } });
    expect(conn).toEqual({ fakeConnection: true });
  });

  it("throws when the connection id is not an org", async () => {
    vi.spyOn(orgConnections, "getConnectionRow").mockResolvedValue({ id: "conn2", type: "git" } as any);
    await expect(buildOrgConnection({} as any, "conn2", {} as any)).rejects.toThrow(/No org connection/);
  });
});
