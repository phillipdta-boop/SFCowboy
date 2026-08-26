export interface Config {
  port: number;
  dbPath: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
  sfPackageClientId: string;
  sfPackageInstallUrl: string;
}

// The Consumer Key of the packaged "SFCowboy" Connected App (namespace SFcowboy). It is baked
// into every org that installs the package via sfPackageInstallUrl below, so this one value works
// across every org, sandbox or production. It is a public client ID, not a secret — the app uses
// PKCE (no client secret required), so there is nothing confidential to protect here. Both are
// overridable only in case the package is ever rebuilt/republished under a new version.
const DEFAULT_SF_PACKAGE_CLIENT_ID =
  "3MVG9rZjd7MXFdLjkcY3ibNjVfGj3em_cbzSYg4O1HRTUjHIFhnJuRbDQ1WCxObsXPufnupzSx_sdsMroZ.Zd";
const DEFAULT_SF_PACKAGE_INSTALL_URL = "https://login.salesforce.com/packaging/installPackage.apexp?p0=04tgK000000IcejQAC";

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
    sfPackageClientId: process.env.SF_PACKAGE_CLIENT_ID ?? DEFAULT_SF_PACKAGE_CLIENT_ID,
    sfPackageInstallUrl: process.env.SF_PACKAGE_INSTALL_URL ?? DEFAULT_SF_PACKAGE_INSTALL_URL,
  };
}
