import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { openTestDb, type TestDb } from "./db/testDb.js";
import { createOrgConnection } from "./connections/orgConnections.js";
import { createDraftDeployment, scheduleDeployment } from "./engine/deploy.js";
import * as deploy from "./engine/deploy.js";
import { runDueScheduledDeployments, startScheduler } from "./scheduler.js";

process.env.ENCRYPTION_KEY = "f".repeat(64);

const config = { oauthCallbackUrl: "https://x/oauth/callback" } as any;

async function pendingDraft(db: Pool): Promise<string> {
  const source = await createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
  const target = await createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
  return createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
}

let testDb: TestDb;

beforeEach(async () => {
  vi.restoreAllMocks();
  testDb = await openTestDb();
});

afterEach(async () => {
  await testDb.stop();
});

describe("runDueScheduledDeployments", () => {
  it("fires runDeployment for every due deployment, and none that aren't due yet", async () => {
    const db = testDb.pool;
    const due = await pendingDraft(db);
    const notYetDue = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    await scheduleDeployment(db, notYetDue, "2099-01-01T00:00:00.000Z", null);

    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    await runDueScheduledDeployments(db, config, "/tmp/data", new Date("2026-06-01T00:00:00.000Z"));

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
  });

  it("does nothing when no deployment is due", async () => {
    const db = testDb.pool;
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    await runDueScheduledDeployments(db, config, "/tmp/data", new Date());

    expect(runSpy).not.toHaveBeenCalled();
  });

  it("logs and continues instead of throwing when a fired deployment rejects", async () => {
    const db = testDb.pool;
    const due = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    vi.spyOn(deploy, "runDeployment").mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runDueScheduledDeployments(db, config, "/tmp/data", new Date("2026-06-01T00:00:00.000Z"))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("startScheduler", () => {
  it("runs a catch-up pass immediately on start", async () => {
    const db = testDb.pool;
    const due = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 30000);

    // The catch-up pass fires asynchronously (it's not awaited by startScheduler), so give its
    // promise chain a tick to run before asserting.
    await vi.waitFor(() => {
      expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
    });
    handle.stop();
  });

  // These two use a short *real* interval rather than vi.useFakeTimers(): the poll now does a
  // real Postgres round-trip inside a fire-and-forget `void runDueScheduledDeployments(...)`
  // call, which fake timers cannot track (advanceTimersByTimeAsync only awaits promises it
  // itself schedules), so simulated time no longer proves anything about a real async poll.
  it("polls again after the interval elapses, picking up a deployment scheduled in the meantime", async () => {
    const db = testDb.pool;
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 20);
    expect(runSpy).not.toHaveBeenCalled();

    const due = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);

    await vi.waitFor(() => {
      expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
    });
    handle.stop();
  });

  it("stop() prevents any further polling", async () => {
    const db = testDb.pool;
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 20);
    handle.stop();

    const due = await pendingDraft(db);
    await scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runSpy).not.toHaveBeenCalled();
  });
});
