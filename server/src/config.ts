export interface Config {
  port: number;
  dbPath: string;
  encryptionKey: string;
  sfClientId: string;
  sfClientSecret: string;
  oauthCallbackUrl: string;
}

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY", "SF_CLIENT_ID", "SF_CLIENT_SECRET"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    dbPath: process.env.DB_PATH ?? "./sfcowboy.db",
    encryptionKey: process.env.ENCRYPTION_KEY!,
    sfClientId: process.env.SF_CLIENT_ID!,
    sfClientSecret: process.env.SF_CLIENT_SECRET!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
  };
}
