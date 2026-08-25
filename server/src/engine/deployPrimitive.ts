import type { Connection } from "@salesforce/core";

export interface DeployResult {
  success: boolean;
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[];
}

export async function deployZipToOrg(
  connection: Connection,
  zip: Buffer,
  opts: { testLevel: string; checkOnly: boolean },
  pollIntervalMs = 2000,
  timeoutMs = 10 * 60 * 1000
): Promise<DeployResult> {
  // NOTE (post-Task-8-review correction): retrieveOrgZip hit the same unbounded-poll
  // pattern in review — a stalled Salesforce job would hang the request forever with no
  // signal to the caller. Apply the same deadline guard here: track a deadline from
  // Date.now() + timeoutMs, and throw a descriptive error if the loop below exceeds it
  // before status.done flips true. See Task 8's ledger entry for the reasoning.
  const conn: any = connection;
  const { id } = await conn.metadata.deploy(zip, { testLevel: opts.testLevel, checkOnly: opts.checkOnly, singlePackage: true });

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
