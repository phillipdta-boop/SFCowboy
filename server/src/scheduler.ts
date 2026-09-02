import type { Pool } from "pg";
import type { Config } from "./config.js";
import { listDueScheduledDeployments, runDeployment } from "./engine/deploy.js";

/**
 * Fires every pending deployment whose scheduled time has already passed, as of `asOf`. Each
 * fire-and-forget call mirrors the existing route handler's pattern (see engine/routes.ts) —
 * runDeployment already catches its own errors and marks the deployment 'failed'; this is just a
 * safety net for anything that somehow escapes that.
 */
export async function runDueScheduledDeployments(db: Pool, config: Config, dataDir: string, asOf: Date): Promise<void> {
  const dueIds = await listDueScheduledDeployments(db, asOf);
  await Promise.all(
    dueIds.map((id) =>
      runDeployment(db, config, dataDir, id).catch((err) => {
        console.error(`Scheduled deployment ${id} failed unexpectedly`, err);
      })
    )
  );
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the scheduler: runs an immediate catch-up pass for anything already overdue (e.g. the
 * server was down when it was due to fire), then polls every `intervalMs` for newly-due
 * deployments. A deployment's own status flip away from 'pending' — the first thing runDeployment
 * does — is what keeps the next poll from firing it again; no separate locking is needed.
 */
export function startScheduler(db: Pool, config: Config, dataDir: string, intervalMs: number): SchedulerHandle {
  void runDueScheduledDeployments(db, config, dataDir, new Date());
  const timer = setInterval(() => {
    void runDueScheduledDeployments(db, config, dataDir, new Date());
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
