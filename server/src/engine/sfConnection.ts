import { AuthInfo, Connection } from "@salesforce/core";
import type { Pool } from "pg";
import { getConnectionRow, getValidAccessToken } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

export async function buildOrgConnection(db: Pool, connectionId: string, config: Config): Promise<Connection> {
  const row = await getConnectionRow(db, connectionId);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${connectionId}`);
  }

  const { accessToken, instanceUrl } = await getValidAccessToken(db, connectionId, config);
  const authInfo = await AuthInfo.create({ accessTokenOptions: { accessToken, instanceUrl } });
  return Connection.create({ authInfo });
}
