import type { Connection } from "@salesforce/core";

export interface ComponentRef {
  type: string;
  fullName: string;
  lastModifiedDate?: string;
  lastModifiedByName?: string;
}

// Salesforce's listMetadata call accepts at most 3 queries per request.
const LIST_METADATA_BATCH_SIZE = 3;

/**
 * Listing every describe-able metadata type is what makes a full diff slow: describe() alone
 * enumerates 400+ types on a real org, and list() is a network round-trip per call. Passing
 * `types` skips describe() entirely and only lists the caller's chosen types; batching those
 * types into groups of 3 (Salesforce's own limit per listMetadata call) and firing every batch
 * concurrently rather than one at a time turns N sequential round trips into roughly ceil(N/3)
 * round trips' worth of wall-clock time.
 */
export async function listOrgComponents(connection: Connection, opts: { types?: string[] } = {}): Promise<ComponentRef[]> {
  const types: string[] =
    opts.types && opts.types.length > 0
      ? opts.types
      : (await (connection as any).metadata.describe()).metadataObjects.map((m: any) => m.xmlName);

  const batches: string[][] = [];
  for (let i = 0; i < types.length; i += LIST_METADATA_BATCH_SIZE) {
    batches.push(types.slice(i, i + LIST_METADATA_BATCH_SIZE));
  }

  const batchResults = await Promise.all(
    batches.map((batch) => (connection as any).metadata.list(batch.map((type) => ({ type }))))
  );

  const results: ComponentRef[] = [];
  for (const listed of batchResults) {
    for (const item of listed ?? []) {
      results.push({
        type: item.type,
        fullName: item.fullName,
        lastModifiedDate: item.lastModifiedDate,
        lastModifiedByName: item.lastModifiedByName,
      });
    }
  }
  return results;
}

export async function describeAvailableTypes(connection: Connection): Promise<string[]> {
  const describeResult: any = await (connection as any).metadata.describe();
  return describeResult.metadataObjects.map((m: any) => m.xmlName).sort();
}

export async function retrieveOrgZip(
  connection: Connection,
  components: { type: string; fullName: string }[],
  opts: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<Buffer> {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.fullName);
  }
  const types = Array.from(byType.entries()).map(([name, members]) => ({ name, members }));

  const conn: any = connection as any;
  const { id } = await conn.metadata.retrieve({
    apiVersion: String(conn.getApiVersion?.() ?? "61.0"),
    unpackaged: { types, version: String(conn.getApiVersion?.() ?? "61.0") },
  });

  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 10 minutes default
  const deadline = Date.now() + timeoutMs;

  let status = await conn.metadata.checkRetrieveStatus(id);
  while (!status.done) {
    if (Date.now() > deadline) {
      throw new Error(`Retrieve ${id} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkRetrieveStatus(id);
  }

  if (!status.success) {
    throw new Error(`Retrieve ${id} failed: ${status.errorMessage ?? status.status ?? "unknown error"}`);
  }

  return Buffer.from(status.zipFile, "base64");
}
