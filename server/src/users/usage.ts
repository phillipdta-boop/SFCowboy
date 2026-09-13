import type { Pool } from "pg";

export const DEPLOYMENT_STATUSES = ["pending", "validating", "deploying", "succeeded", "failed", "rolled_back", "cancelled"] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export interface UsageBreakdown {
  thisMonth: Record<DeploymentStatus, number>;
  allTime: Record<DeploymentStatus, number>;
}

function emptyCounts(): Record<DeploymentStatus, number> {
  return Object.fromEntries(DEPLOYMENT_STATUSES.map((status) => [status, 0])) as Record<DeploymentStatus, number>;
}

/**
 * Counts deployments run by the given user (via run_by_user_id, the authenticated identity behind
 * a run — see setRunBy in engine/deploy.ts), grouped by status and split into the current calendar
 * month vs all time. Backs the profile dropdown's usage summary.
 */
export async function getUsageSummary(db: Pool, userId: string): Promise<UsageBreakdown> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const result = await db.query<{ status: DeploymentStatus; all_time: string; this_month: string }>(
    `SELECT status, COUNT(*) AS all_time, COUNT(*) FILTER (WHERE started_at >= $2) AS this_month
     FROM deployments WHERE run_by_user_id = $1 GROUP BY status`,
    [userId, monthStart.toISOString()]
  );

  const thisMonth = emptyCounts();
  const allTime = emptyCounts();
  for (const row of result.rows) {
    allTime[row.status] = Number(row.all_time);
    thisMonth[row.status] = Number(row.this_month);
  }
  return { thisMonth, allTime };
}
