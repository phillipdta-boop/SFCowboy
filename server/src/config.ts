export interface Config {
  port: number;
  dbPath: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
}

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    dbPath: process.env.DB_PATH ?? "./sfcowboy.db",
    encryptionKey: process.env.ENCRYPTION_KEY!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
  };
}
