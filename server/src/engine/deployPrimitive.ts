import type { Connection } from "@salesforce/core";

export interface DeployResult {
  success: boolean;
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[];
  jobId: string;
  // Salesforce's own job status string (e.g. "Succeeded", "Failed", "Canceled") — distinct from
  // `success`, since a cancelled job is neither a genuine success nor an ordinary failure.
  status: string;
}

export interface DeployProgress {
  jobId: string;
  numberComponentsDeployed: number;
  numberComponentsTotal: number;
  numberTestsCompleted: number;
  numberTestsTotal: number;
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
    // Required by Salesforce when testLevel is RunSpecifiedTests — the exact Apex test classes
    // to run, instead of the broader local/all-org sweep the other test levels perform.
    runTests?: string[];
  },
  pollIntervalMs = 2000,
  timeoutMs = 10 * 60 * 1000,
  // Fired once the async job id is known (before the first poll, with all counts at 0) and again
  // after every poll — callers use this to persist live progress without blocking on completion.
  onProgress?: (progress: DeployProgress) => void
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
    ...(opts.runTests && opts.runTests.length > 0 ? { runTests: opts.runTests } : {}),
  });

  function reportProgress(status: any) {
    onProgress?.({
      jobId: id,
      numberComponentsDeployed: Number(status?.numberComponentsDeployed ?? 0),
      numberComponentsTotal: Number(status?.numberComponentsTotal ?? 0),
      numberTestsCompleted: Number(status?.numberTestsCompleted ?? 0),
      numberTestsTotal: Number(status?.numberTestsTotal ?? 0),
    });
  }
  reportProgress(undefined);

  // A stalled Salesforce job would otherwise hang the poll loop forever with no signal to the
  // caller, so the loop below gives up at this deadline.

  const deadline = Date.now() + timeoutMs;
  let status = await conn.metadata.checkDeployStatus(id, true);
  reportProgress(status);
  while (!status.done) {
    if (Date.now() > deadline) {
      throw new Error(`Deploy ${id} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkDeployStatus(id, true);
    reportProgress(status);
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

  return {
    success: status.success === "true" || status.success === true,
    componentResults,
    jobId: id,
    status: status.status ?? "",
  };
}
