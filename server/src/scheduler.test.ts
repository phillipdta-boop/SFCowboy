import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openDb, runMigrations } from "./db/client.js";
import { createOrgConnection } from "./connections/orgConnections.js";
import { createDraftDeployment, scheduleDeployment } from "./engine/deploy.js";
import * as deploy from "./engine/deploy.js";
import { runDueScheduledDeployments, startScheduler } from "./scheduler.js";

process.env.ENCRYPTION_KEY = "f".repeat(64);

const config = { oauthCallbackUrl: "https://x/oauth/callback" } as any;

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function pendingDraft(db: ReturnType<typeof freshDb>): string {
  const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
  const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
  return createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runDueScheduledDeployments", () => {
  it("fires runDeployment for every due deployment, and none that aren't due yet", async () => {
    const db = freshDb();
    const due = pendingDraft(db);
    const notYetDue = pendingDraft(db);
    scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    scheduleDeployment(db, notYetDue, "2099-01-01T00:00:00.000Z", null);

    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    await runDueScheduledDeployments(db, config, "/tmp/data", new Date("2026-06-01T00:00:00.000Z"));

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
  });

  it("does nothing when no deployment is due", async () => {
    const db = freshDb();
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    await runDueScheduledDeployments(db, config, "/tmp/data", new Date());

    expect(runSpy).not.toHaveBeenCalled();
  });

  it("logs and continues instead of throwing when a fired deployment rejects", async () => {
    const db = freshDb();
    const due = pendingDraft(db);
    scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    vi.spyOn(deploy, "runDeployment").mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runDueScheduledDeployments(db, config, "/tmp/data", new Date("2026-06-01T00:00:00.000Z"))).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("startScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a catch-up pass immediately on start", () => {
    const db = freshDb();
    const due = pendingDraft(db);
    scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 30000);

    expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
    handle.stop();
  });

  it("polls again after the interval elapses, picking up a deployment scheduled in the meantime", () => {
    vi.useFakeTimers();
    const db = freshDb();
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 30000);
    expect(runSpy).not.toHaveBeenCalled();

    const due = pendingDraft(db);
    scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);

    vi.advanceTimersByTime(30000);

    expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", due);
    handle.stop();
  });

  it("stop() prevents any further polling", () => {
    vi.useFakeTimers();
    const db = freshDb();
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const handle = startScheduler(db, config, "/tmp/data", 30000);
    handle.stop();

    const due = pendingDraft(db);
    scheduleDeployment(db, due, "2026-01-01T00:00:00.000Z", null);
    vi.advanceTimersByTime(60000);

    expect(runSpy).not.toHaveBeenCalled();
  });
});
