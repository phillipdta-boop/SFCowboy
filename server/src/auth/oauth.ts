function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Direct SOAP login — Salesforce's original API authentication mechanism, requiring no OAuth
 * client/Connected App at all. Used only to bootstrap a session capable of deploying a Connected
 * App on the user's behalf; the resulting sessionId is not persisted anywhere.
 */
export async function soapLogin(opts: {
  loginUrl: string;
  username: string;
  password: string;
  securityToken?: string;
}): Promise<{ sessionId: string; instanceUrl: string }> {
  const password = `${opts.password}${opts.securityToken ?? ""}`;
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
  <soapenv:Body>
    <urn:login>
      <urn:username>${escapeXml(opts.username)}</urn:username>
      <urn:password>${escapeXml(password)}</urn:password>
    </urn:login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await fetch(`${opts.loginUrl}/services/Soap/u/61.0`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=UTF-8", SOAPAction: "login" },
    body: envelope,
  });
  const text = await res.text();

  const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/);
  if (faultMatch) {
    throw new Error(`Salesforce login failed: ${faultMatch[1]}`);
  }
  if (!res.ok) {
    throw new Error(`Salesforce login failed (${res.status}): ${text}`);
  }

  const sessionIdMatch = text.match(/<sessionId>([\s\S]*?)<\/sessionId>/);
  const serverUrlMatch = text.match(/<serverUrl>([\s\S]*?)<\/serverUrl>/);
  if (!sessionIdMatch || !serverUrlMatch) {
    throw new Error("Salesforce login response did not include a sessionId/serverUrl");
  }

  const serverUrl = new URL(serverUrlMatch[1]);
  return { sessionId: sessionIdMatch[1], instanceUrl: `${serverUrl.protocol}//${serverUrl.host}` };
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

export async function passwordGrant(opts: {
  loginUrl: string;
  username: string;
  password: string;
  securityToken?: string;
  clientId: string;
}): Promise<{ accessToken: string; refreshToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "password",
    username: opts.username,
    password: `${opts.password}${opts.securityToken ?? ""}`,
    client_id: opts.clientId,
  });

  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, instanceUrl: json.instance_url };
}
