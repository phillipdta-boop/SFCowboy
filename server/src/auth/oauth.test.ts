import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizationUrl,
  refreshAccessToken,
  exchangeCodeForToken,
} from "./oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateCodeVerifier", () => {
  it("generates a URL-safe random string with no padding", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThan(20);
  });

  it("generates a different value each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe("generateCodeChallenge", () => {
  it("derives the base64url-encoded SHA-256 hash of the verifier (RFC 7636)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a Salesforce authorize URL with PKCE parameters", () => {
    const url = buildAuthorizationUrl({
      loginUrl: "https://login.salesforce.com",
      clientId: "3MVG9client",
      redirectUri: "http://localhost:3000/oauth/callback",
      state: "abc123",
      codeChallenge: "challenge456",
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://login.salesforce.com/services/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("3MVG9client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://localhost:3000/oauth/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge456");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("abc123");
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh_token grant including client_secret when provided", async () => {
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

    const [, options] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(options.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref456");
    expect(body.get("client_id")).toBe("client123");
    expect(body.get("client_secret")).toBe("secret456");
  });

  it("omits client_secret from the POST body when not provided (secretless Connected App)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "newacc", instance_url: "https://myorg.my.salesforce.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await refreshAccessToken({
      loginUrl: "https://login.salesforce.com",
      refreshToken: "ref456",
      clientId: "client123",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(options.body);
    expect(body.has("client_secret")).toBe(false);
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad_request" }));
    await expect(
      refreshAccessToken({ loginUrl: "https://login.salesforce.com", refreshToken: "bad", clientId: "c" })
    ).rejects.toThrow(/OAuth token exchange failed/);
  });
});

describe("exchangeCodeForToken", () => {
  it("posts an authorization_code grant with the PKCE verifier, no client_secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "acc123",
        refresh_token: "ref456",
        instance_url: "https://myorg.my.salesforce.com",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForToken({
      loginUrl: "https://login.salesforce.com",
      code: "auth-code-789",
      clientId: "3MVG9client",
      redirectUri: "http://localhost:3000/oauth/callback",
      codeVerifier: "verifier-abc",
    });

    expect(result).toEqual({
      accessToken: "acc123",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://login.salesforce.com/services/oauth2/token",
      expect.objectContaining({ method: "POST" })
    );
    const [, options] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(options.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-789");
    expect(body.get("client_id")).toBe("3MVG9client");
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/oauth/callback");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.has("client_secret")).toBe(false);
  });

  it("throws a descriptive error on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "invalid_grant: expired code" })
    );
    await expect(
      exchangeCodeForToken({
        loginUrl: "https://login.salesforce.com",
        code: "bad-code",
        clientId: "client-id",
        redirectUri: "http://localhost:3000/oauth/callback",
        codeVerifier: "v",
      })
    ).rejects.toThrow(/OAuth token exchange failed/);
  });
});
