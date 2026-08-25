import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshAccessToken, passwordGrant, soapLogin } from "./oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("soapLogin", () => {
  const successXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <loginResponse>
      <result>
        <sessionId>00D_SESSION_ID</sessionId>
        <serverUrl>https://myorg.my.salesforce.com/services/Soap/u/61.0/00D000000000EXAMPLE</serverUrl>
      </result>
    </loginResponse>
  </soapenv:Body>
</soapenv:Envelope>`;

  it("posts a SOAP login envelope and parses sessionId + instanceUrl from a success response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => successXml });
    vi.stubGlobal("fetch", fetchMock);

    const result = await soapLogin({
      loginUrl: "https://login.salesforce.com",
      username: "admin@example.com",
      password: "hunter2",
    });

    expect(result).toEqual({ sessionId: "00D_SESSION_ID", instanceUrl: "https://myorg.my.salesforce.com" });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://login.salesforce.com/services/Soap/u/61.0");
    expect(options.headers["SOAPAction"]).toBe("login");
    expect(options.body).toContain("<urn:username>admin@example.com</urn:username>");
    expect(options.body).toContain("<urn:password>hunter2</urn:password>");
  });

  it("appends the security token to the password when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => successXml });
    vi.stubGlobal("fetch", fetchMock);

    await soapLogin({
      loginUrl: "https://login.salesforce.com",
      username: "admin@example.com",
      password: "hunter2",
      securityToken: "TOKEN123",
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toContain("<urn:password>hunter2TOKEN123</urn:password>");
  });

  it("XML-escapes special characters in username and password", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => successXml });
    vi.stubGlobal("fetch", fetchMock);

    await soapLogin({
      loginUrl: "https://login.salesforce.com",
      username: "admin@example.com",
      password: `p&ss<word>"'`,
    });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.body).toContain("<urn:password>p&amp;ss&lt;word&gt;&quot;&apos;</urn:password>");
  });

  it("throws a descriptive error on a SOAP fault (e.g. bad credentials)", async () => {
    const faultXml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <soapenv:Fault>
      <faultstring>INVALID_LOGIN: Invalid username, password, security token; or user is locked out.</faultstring>
    </soapenv:Fault>
  </soapenv:Body>
</soapenv:Envelope>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => faultXml }));

    await expect(
      soapLogin({ loginUrl: "https://login.salesforce.com", username: "admin@example.com", password: "wrong" })
    ).rejects.toThrow(/INVALID_LOGIN/);
  });

  it("throws when the response cannot be parsed for a sessionId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => "<garbage/>" }));
    await expect(
      soapLogin({ loginUrl: "https://login.salesforce.com", username: "a", password: "b" })
    ).rejects.toThrow(/sessionId/);
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

describe("passwordGrant", () => {
  it("posts a password grant with username and password+token concatenated, no client_secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "acc123",
        refresh_token: "ref456",
        instance_url: "https://myorg.my.salesforce.com",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await passwordGrant({
      loginUrl: "https://login.salesforce.com",
      username: "admin@example.com",
      password: "hunter2",
      securityToken: "TOKEN123",
      clientId: "auto-provisioned-client-id",
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
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("admin@example.com");
    expect(body.get("password")).toBe("hunter2TOKEN123");
    expect(body.get("client_id")).toBe("auto-provisioned-client-id");
    expect(body.has("client_secret")).toBe(false);
  });

  it("does not append a security token to the password when none is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "a", refresh_token: "r", instance_url: "https://x" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await passwordGrant({
      loginUrl: "https://login.salesforce.com",
      username: "admin@example.com",
      password: "hunter2",
      clientId: "client-id",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = new URLSearchParams(options.body);
    expect(body.get("password")).toBe("hunter2");
  });

  it("throws a descriptive error on a non-ok response (e.g. blocked by MFA policy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "invalid_grant: authentication failure" })
    );
    await expect(
      passwordGrant({
        loginUrl: "https://login.salesforce.com",
        username: "admin@example.com",
        password: "wrong",
        clientId: "client-id",
      })
    ).rejects.toThrow(/OAuth token exchange failed/);
  });
});
