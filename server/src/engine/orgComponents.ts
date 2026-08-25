import type { Connection } from "@salesforce/core";

export interface ComponentRef {
  type: string;
  fullName: string;
  lastModifiedDate?: string;
}

export async function listOrgComponents(connection: Connection): Promise<ComponentRef[]> {
  const describeResult: any = await (connection as any).metadata.describe();
  const types: string[] = describeResult.metadataObjects.map((m: any) => m.xmlName);

  const results: ComponentRef[] = [];
  for (const type of types) {
    const listed: any[] = await (connection as any).metadata.list([{ type }]);
    for (const item of listed ?? []) {
      results.push({ type, fullName: item.fullName, lastModifiedDate: item.lastModifiedDate });
    }
  }
  return results;
}

export async function retrieveOrgZip(
  connection: Connection,
  components: { type: string; fullName: string }[],
  opts: { pollIntervalMs?: number } = {}
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
  let status = await conn.metadata.checkRetrieveStatus(id);
  while (!status.done) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkRetrieveStatus(id);
  }
  return Buffer.from(status.zipFile, "base64");
}
