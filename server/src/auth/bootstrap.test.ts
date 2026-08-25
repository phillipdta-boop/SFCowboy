import { describe, it, expect, vi } from "vitest";
import { AuthInfo, Connection } from "@salesforce/core";
import * as oauth from "./oauth.js";
import * as provisioning from "./connectedAppProvisioning.js";
import { bootstrapOrgConnection } from "./bootstrap.js";

vi.mock("@salesforce/core", () => ({
  AuthInfo: { create: vi.fn().mockResolvedValue({ fakeAuthInfo: true }) },
  Connection: { create: vi.fn().mockResolvedValue({ fakeConnection: true }) },
}));

describe("bootstrapOrgConnection", () => {
  it("logs in, deploys a Connected App, waits for its consumer key, then completes a password grant", async () => {
    const soapLoginSpy = vi
      .spyOn(oauth, "soapLogin")
      .mockResolvedValue({ sessionId: "SESSION123", instanceUrl: "https://myorg.my.salesforce.com" });
    const deploySpy = vi.spyOn(provisioning, "deployConnectedAppZip").mockResolvedValue(undefined);
    const waitSpy = vi.spyOn(provisioning, "waitForConsumerKey").mockResolvedValue({ consumerKey: "3MVG9abc123" });
    const passwordGrantSpy = vi.spyOn(oauth, "passwordGrant").mockResolvedValue({
      accessToken: "acc123",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const result = await bootstrapOrgConnection({
      orgType: "sandbox",
      username: "admin@example.com",
      password: "hunter2",
      securityToken: "TOKEN123",
      callbackUrl: "http://localhost:3000/oauth/callback",
    });

    expect(soapLoginSpy).toHaveBeenCalledWith(
      expect.objectContaining({ loginUrl: "https://test.salesforce.com", username: "admin@example.com", password: "hunter2", securityToken: "TOKEN123" })
    );
    expect(AuthInfo.create).toHaveBeenCalledWith({
      accessTokenOptions: { accessToken: "SESSION123", instanceUrl: "https://myorg.my.salesforce.com" },
    });
    expect(deploySpy).toHaveBeenCalled();
    expect(waitSpy).toHaveBeenCalled();
    expect(passwordGrantSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        loginUrl: "https://test.salesforce.com",
        username: "admin@example.com",
        password: "hunter2",
        securityToken: "TOKEN123",
        clientId: "3MVG9abc123",
      })
    );

    expect(result).toEqual({
      clientId: "3MVG9abc123",
      accessToken: "acc123",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });
  });

  it("uses login.salesforce.com for production org type", async () => {
    vi.spyOn(oauth, "soapLogin").mockResolvedValue({ sessionId: "S", instanceUrl: "https://myorg.my.salesforce.com" });
    vi.spyOn(provisioning, "deployConnectedAppZip").mockResolvedValue(undefined);
    vi.spyOn(provisioning, "waitForConsumerKey").mockResolvedValue({ consumerKey: "key" });
    const passwordGrantSpy = vi
      .spyOn(oauth, "passwordGrant")
      .mockResolvedValue({ accessToken: "a", refreshToken: "r", instanceUrl: "https://x" });

    await bootstrapOrgConnection({
      orgType: "production",
      username: "u",
      password: "p",
      callbackUrl: "http://localhost:3000/oauth/callback",
    });

    expect(passwordGrantSpy).toHaveBeenCalledWith(expect.objectContaining({ loginUrl: "https://login.salesforce.com" }));
  });

  it("propagates a login failure without attempting to deploy anything", async () => {
    vi.spyOn(oauth, "soapLogin").mockRejectedValue(new Error("Salesforce login failed: INVALID_LOGIN"));
    const deploySpy = vi.spyOn(provisioning, "deployConnectedAppZip").mockResolvedValue(undefined);

    await expect(
      bootstrapOrgConnection({
        orgType: "sandbox",
        username: "u",
        password: "wrong",
        callbackUrl: "http://localhost:3000/oauth/callback",
      })
    ).rejects.toThrow(/INVALID_LOGIN/);

    expect(deploySpy).not.toHaveBeenCalled();
  });

  it("propagates a password-grant failure (e.g. blocked by org MFA policy) after successful provisioning", async () => {
    vi.spyOn(oauth, "soapLogin").mockResolvedValue({ sessionId: "S", instanceUrl: "https://x" });
    vi.spyOn(provisioning, "deployConnectedAppZip").mockResolvedValue(undefined);
    vi.spyOn(provisioning, "waitForConsumerKey").mockResolvedValue({ consumerKey: "key" });
    vi.spyOn(oauth, "passwordGrant").mockRejectedValue(new Error("OAuth token exchange failed (400): invalid_grant"));

    await expect(
      bootstrapOrgConnection({
        orgType: "sandbox",
        username: "u",
        password: "p",
        callbackUrl: "http://localhost:3000/oauth/callback",
      })
    ).rejects.toThrow(/invalid_grant/);
  });
});
