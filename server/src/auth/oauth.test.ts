import { describe, it, expect, vi, afterEach } from "vitest";
import { createPkcePair, buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPkcePair", () => {
  it("returns a verifier and a derived challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toBe(verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes required OAuth query params", () => {
    const url = buildAuthorizeUrl({
      loginUrl: "https://test.salesforce.com",
      state: "abc",
      challenge: "xyz",
      callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
      clientId: "client123",
    });
    expect(url).toContain("https://test.salesforce.com/services/oauth2/authorize");
    expect(url).toContain("code_challenge=xyz");
    expect(url).toContain("state=abc");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fdeploy.effluence.com.au%2Foauth%2Fcallback");
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts to the token endpoint and returns parsed tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "acc123",
        refresh_token: "ref456",
        instance_url: "https://myorg.my.salesforce.com",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForTokens({
      loginUrl: "https://test.salesforce.com",
      code: "authcode",
      verifier: "verifier123",
      callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
      clientId: "client123",
      clientSecret: "secret456",
    });

    expect(result).toEqual({
      accessToken: "acc123",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.salesforce.com/services/oauth2/token",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad_request" }));
    await expect(
      exchangeCodeForTokens({
        loginUrl: "https://test.salesforce.com",
        code: "bad",
        verifier: "v",
        callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
        clientId: "c",
        clientSecret: "s",
      })
    ).rejects.toThrow(/OAuth token exchange failed/);
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh_token grant and returns a new access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "newacc", instance_url: "https://myorg.my.salesforce.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshAccessToken({
      loginUrl: "https://login.salesforce.com",
      refreshToken: "ref456",
      clientId: "client123",
      clientSecret: "secret456",
    });

    expect(result).toEqual({ accessToken: "newacc", instanceUrl: "https://myorg.my.salesforce.com" });
  });
});
