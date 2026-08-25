import type { Connection } from "@salesforce/core";
import AdmZip from "adm-zip";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Builds an mdapi-format deploy zip containing a single new ConnectedApp component.
 *
 * NOTE (needs real-org verification): this deliberately omits `consumerKey` — Salesforce
 * rejects a deploy that tries to set it, auto-generating one instead. The intent is also for
 * the app to require no consumer secret (so the later password-grant token exchange, which
 * discards the user's password immediately, never needs a secret it has no way to read back —
 * Salesforce does not expose auto-generated Connected App secrets via any API). This
 * environment has no live Salesforce org to confirm the exact field name Salesforce expects
 * for that "no secret required" policy on the classic ConnectedApp metadata type — if the
 * later token exchange fails with an invalid_client/secret-required error, that field name is
 * the first thing to check against current Metadata API documentation or a real deploy.
 */
export function buildConnectedAppZip(opts: {
  appName: string;
  label: string;
  contactEmail: string;
  callbackUrl: string;
}): Buffer {
  const packageXml = `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types>
    <members>${opts.appName}</members>
    <name>ConnectedApp</name>
  </types>
  <version>61.0</version>
</Package>
`;

  const connectedAppXml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>${escapeXml(opts.label)}</label>
  <contactEmail>${escapeXml(opts.contactEmail)}</contactEmail>
  <oauthConfig>
    <callbackUrl>${escapeXml(opts.callbackUrl)}</callbackUrl>
    <scopes>Api</scopes>
    <scopes>RefreshToken</scopes>
    <isAdminApproved>true</isAdminApproved>
    <isConsumerSecretOptional>true</isConsumerSecretOptional>
  </oauthConfig>
</ConnectedApp>
`;

  const zip = new AdmZip();
  zip.addFile("package.xml", Buffer.from(packageXml));
  zip.addFile(`connectedApps/${opts.appName}.connectedApp`, Buffer.from(connectedAppXml));
  return zip.toBuffer();
}

export async function deployConnectedAppZip(
  connection: Connection,
  zip: Buffer,
  pollIntervalMs = 2000,
  timeoutMs = 2 * 60 * 1000
): Promise<void> {
  const conn: any = connection;
  const { id } = await conn.metadata.deploy(zip, { singlePackage: true, testLevel: "NoTestRun" });

  const deadline = Date.now() + timeoutMs;
  let status = await conn.metadata.checkDeployStatus(id, true);
  while (!status.done) {
    if (Date.now() > deadline) {
      throw new Error(`Connected App deployment ${id} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkDeployStatus(id, true);
  }

  if (!(status.success === "true" || status.success === true)) {
    throw new Error(`Connected App deployment failed: ${JSON.stringify(status.details ?? status)}`);
  }
}

/**
 * Newly-deployed Connected Apps take a real amount of time (observed to be up to a couple of
 * minutes) to activate in Salesforce before their auto-generated Consumer Key becomes queryable.
 * Polls the Tooling API's ConnectedApplication object until the record — and its ConsumerKey —
 * appears.
 */
export async function waitForConsumerKey(
  connection: Connection,
  appLabel: string,
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<{ consumerKey: string }> {
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 2 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const conn: any = connection;
  const escapedLabel = appLabel.replace(/'/g, "\\'");

  while (true) {
    const result = await conn.tooling.query(`SELECT ConsumerKey FROM ConnectedApplication WHERE Name = '${escapedLabel}'`);
    const record = result.records?.[0];
    if (record?.ConsumerKey) {
      return { consumerKey: record.ConsumerKey };
    }
    if (Date.now() > deadline) {
      throw new Error(`The auto-created Connected App "${appLabel}" did not activate within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
