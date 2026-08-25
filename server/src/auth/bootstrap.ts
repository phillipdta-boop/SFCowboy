import { AuthInfo, Connection } from "@salesforce/core";
import { soapLogin, passwordGrant } from "./oauth.js";
import { buildConnectedAppZip, deployConnectedAppZip, waitForConsumerKey } from "./connectedAppProvisioning.js";

const APP_NAME = "SFCowboy_Local";
const APP_LABEL = "SFCowboy Local";

/**
 * Connects an org without requiring the user to have already created a Connected App:
 * logs in directly with username/password (+ optional security token), uses that one-time
 * session to auto-provision a Connected App in the org, then completes a password-grant OAuth
 * exchange against that new app to get a real access/refresh token pair. The username and
 * password are used only for the two Salesforce calls this function makes and are never
 * returned, logged, or persisted by this function or its caller.
 */
export async function bootstrapOrgConnection(opts: {
  orgType: "sandbox" | "production";
  username: string;
  password: string;
  securityToken?: string;
  callbackUrl: string;
}): Promise<{ clientId: string; accessToken: string; refreshToken: string; instanceUrl: string }> {
  const loginUrl = opts.orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

  const { sessionId, instanceUrl } = await soapLogin({
    loginUrl,
    username: opts.username,
    password: opts.password,
    securityToken: opts.securityToken,
  });

  const authInfo = await AuthInfo.create({ accessTokenOptions: { accessToken: sessionId, instanceUrl } });
  const connection = await Connection.create({ authInfo });

  const zip = buildConnectedAppZip({
    appName: APP_NAME,
    label: APP_LABEL,
    contactEmail: opts.username,
    callbackUrl: opts.callbackUrl,
  });
  await deployConnectedAppZip(connection, zip);

  const { consumerKey } = await waitForConsumerKey(connection, APP_LABEL);

  const tokens = await passwordGrant({
    loginUrl,
    username: opts.username,
    password: opts.password,
    securityToken: opts.securityToken,
    clientId: consumerKey,
  });

  return { clientId: consumerKey, ...tokens };
}
