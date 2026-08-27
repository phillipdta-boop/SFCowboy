import type { Connection } from "@salesforce/core";

export interface DeployResult {
  success: boolean;
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[];
}

export async function deployZipToOrg(
  connection: Connection,
  zip: Buffer,
  opts: {
    testLevel: string;
    checkOnly: boolean;
    ignoreWarnings?: boolean;
    allowMissingFiles?: boolean;
    autoUpdatePackage?: boolean;
  },
  pollIntervalMs = 2000,
  timeoutMs = 10 * 60 * 1000
): Promise<DeployResult> {
  const conn: any = connection;
  // `singlePackage: true` requires package.xml at the zip ROOT. Retrieve-format zips nest their
  // contents under `unpackaged/`, so callers must normalise them (see stripUnpackagedPrefix in
  // convert.ts) before handing the buffer to this function.
  const { id } = await conn.metadata.deploy(zip, {
    testLevel: opts.testLevel,
    checkOnly: opts.checkOnly,
    singlePackage: true,
    ignoreWarnings: !!opts.ignoreWarnings,
    allowMissingFiles: !!opts.allowMissingFiles,
    autoUpdatePackage: !!opts.autoUpdatePackage,
  });

  // A stalled Salesforce job would otherwise hang the poll loop forever with no signal to the
  // caller, so the loop below gives up at this deadline.

  const deadline = Date.now() + timeoutMs;
  let status = await conn.metadata.checkDeployStatus(id, true);
  while (!status.done) {
    if (Date.now() > deadline) {
      throw new Error(`Deploy ${id} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkDeployStatus(id, true);
  }

  const successes = status.details?.componentSuccesses ?? [];
  const failures = status.details?.componentFailures ?? [];
  const all = [...(Array.isArray(successes) ? successes : [successes]), ...(Array.isArray(failures) ? failures : [failures])].filter(Boolean);

  const componentResults = all.map((d: any) => ({
    type: d.componentType,
    fullName: d.fullName,
    success: d.success === "true" || d.success === true,
    errorMessage: d.problem,
  }));

  return { success: status.success === "true" || status.success === true, componentResults };
}
