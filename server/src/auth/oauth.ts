import { randomBytes, createHash } from "node:crypto";

/**
 * PKCE (RFC 7636): the verifier is a random secret kept server-side for the lifetime of one
 * authorization attempt; the challenge (its SHA-256, base64url-encoded) is sent to Salesforce up
 * front so the later token exchange can prove possession of the verifier without ever needing a
 * client secret.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizationUrl(opts: {
  loginUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    state: opts.state,
  });
  return `${opts.loginUrl}/services/oauth2/authorize?${params.toString()}`;
}

async function postToken(loginUrl: string, body: URLSearchParams): Promise<any> {
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export async function refreshAccessToken(opts: {
  loginUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
}): Promise<{ accessToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.clientSecret) body.set("client_secret", opts.clientSecret);

  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

export async function exchangeCodeForToken(opts: {
  loginUrl: string;
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; refreshToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });

  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, instanceUrl: json.instance_url };
}
