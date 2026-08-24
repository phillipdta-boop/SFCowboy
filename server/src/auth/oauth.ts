import crypto from "node:crypto";

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  loginUrl: string;
  state: string;
  challenge: string;
  callbackUrl: string;
  clientId: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.callbackUrl,
    scope: "api refresh_token offline_access",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
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

export async function exchangeCodeForTokens(opts: {
  loginUrl: string;
  code: string;
  verifier: string;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.callbackUrl,
    code_verifier: opts.verifier,
  });
  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, instanceUrl: json.instance_url };
}

export async function refreshAccessToken(opts: {
  loginUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}
