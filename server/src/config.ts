export interface Config {
  port: number;
  databaseUrl: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
  sfClientId: string;
}

// The Consumer Key of the "SFCowboy" Connected App. A Connected App's Consumer Key is globally
// resolvable by Salesforce's OAuth endpoints regardless of which org owns the app definition, so
// this one value works for authorizing any org — sandbox or production, whether or not that org
// has ever seen this app before. It is a public client ID, not a secret — the app uses PKCE (no
// client secret required), so there is nothing confidential to protect here. Overridable only in
// case the Connected App is ever recreated under a new Consumer Key.
const DEFAULT_SF_CLIENT_ID = "3MVG9rZjd7MXFdLjkcY3ibNjVfGj3em_cbzSYg4O1HRTUjHIFhnJuRbDQ1WCxObsXPufnupzSx_sdsMroZ.Zd";

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY", "DATABASE_URL"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    databaseUrl: process.env.DATABASE_URL!,
    encryptionKey: process.env.ENCRYPTION_KEY!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
    sfClientId: process.env.SF_CLIENT_ID ?? DEFAULT_SF_CLIENT_ID,
  };
}
