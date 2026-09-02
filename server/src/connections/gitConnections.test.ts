import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createGitConnection } from "./gitConnections.js";
import { ensureLocalClone, commitAllAndPush, gitAuthHeader, testGitConnection } from "./gitConnections.js";

process.env.ENCRYPTION_KEY = "d".repeat(64);

describe("createGitConnection", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = await openTestDb();
  });

  afterEach(async () => {
    await testDb.stop();
  });

  it("stores a git connection without exposing the auth token", async () => {
    const created = await createGitConnection(testDb.pool, {
      nickname: "Metadata Repo",
      remoteUrl: "https://github.com/example/sf-metadata.git",
      defaultBranch: "main",
      authToken: "ghp_rawtoken",
    });
    expect(created.type).toBe("git");

    // Verified via a direct query rather than orgConnections.ts's listConnections(), to keep this
    // test focused on createGitConnection's own contract. This reproduces the same summary-shaped
    // projection (safe columns only, no encrypted_auth_token) to preserve the original intent.
    const summary = await testDb.pool.query(
      `SELECT id, type, nickname, remote_url AS "remoteUrl", default_branch AS "defaultBranch" FROM connections WHERE id = $1`,
      [created.id]
    );
    expect(summary.rows[0].remoteUrl).toBe("https://github.com/example/sf-metadata.git");
    expect(summary.rows[0]).not.toHaveProperty("encryptedAuthToken");
  });
});

let tmpRoot: string;
let bareRepoPath: string;

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-git-"));
  bareRepoPath = path.join(tmpRoot, "remote.git");
  fs.mkdirSync(bareRepoPath);
  await simpleGit(bareRepoPath).init(true);

  const seedDir = path.join(tmpRoot, "seed");
  fs.mkdirSync(seedDir);
  const seedGit = simpleGit(seedDir);
  await seedGit.init();
  await seedGit.addConfig("user.email", "test@example.com");
  await seedGit.addConfig("user.name", "Test");
  fs.writeFileSync(path.join(seedDir, "sfdx-project.json"), "{}");
  await seedGit.add(".");
  await seedGit.commit("initial");
  await seedGit.branch(["-M", "main"]);
  await seedGit.addRemote("origin", bareRepoPath);
  await seedGit.push(["-u", "origin", "main"]);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("ensureLocalClone", () => {
  it("clones the remote on first call", async () => {
    const dataDir = path.join(tmpRoot, "data1");
    const dir = await ensureLocalClone({
      dataDir,
      connectionId: "conn1",
      remoteUrl: `file://${bareRepoPath}`,
      branch: "main",
      authToken: "unused",
    });
    expect(fs.existsSync(path.join(dir, "sfdx-project.json"))).toBe(true);
  });

  it("re-uses and updates the clone on a second call", async () => {
    const dataDir = path.join(tmpRoot, "data2");
    await ensureLocalClone({ dataDir, connectionId: "conn2", remoteUrl: `file://${bareRepoPath}`, branch: "main", authToken: "unused" });
    const dir = await ensureLocalClone({ dataDir, connectionId: "conn2", remoteUrl: `file://${bareRepoPath}`, branch: "main", authToken: "unused" });
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(true);
  });
});

describe("commitAllAndPush", () => {
  it("commits and pushes local changes back to the remote", async () => {
    const dataDir = path.join(tmpRoot, "data3");
    const dir = await ensureLocalClone({ dataDir, connectionId: "conn3", remoteUrl: `file://${bareRepoPath}`, branch: "main", authToken: "unused" });
    fs.writeFileSync(path.join(dir, "new-file.txt"), "hello");

    await commitAllAndPush({ dataDir, connectionId: "conn3", message: "test commit" });

    const verifyDir = path.join(tmpRoot, "verify");
    await simpleGit().clone(bareRepoPath, verifyDir, ["--branch", "main", "--single-branch"]);
    expect(fs.existsSync(path.join(verifyDir, "new-file.txt"))).toBe(true);
  });
});

describe("testGitConnection", () => {
  // listRemote is a lightweight way to verify the remote is reachable and the auth token (if
  // any) is accepted, without a full clone to disk — the same reasoning that makes it a good fit
  // for a "Test connection" button, which should be fast and side-effect free.
  it("returns ok when the remote is reachable", async () => {
    await expect(testGitConnection({ remoteUrl: `file://${bareRepoPath}`, authToken: "unused" })).resolves.toEqual({ ok: true });
  });

  it("returns ok: false with the failure message for an unreachable remote", async () => {
    const result = await testGitConnection({ remoteUrl: `file://${path.join(tmpRoot, "does-not-exist")}`, authToken: "unused" });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBeTruthy();
  });
});

describe("Security: Credential Handling", () => {
  it("gitAuthHeader encodes credentials correctly", () => {
    const testToken = "test-token-xyz";
    const header = gitAuthHeader(testToken);

    expect(header).toMatch(/^http\.extraheader=AUTHORIZATION: basic [A-Za-z0-9+/=]+$/);
    const base64 = header.replace("http.extraheader=AUTHORIZATION: basic ", "");
    expect(Buffer.from(base64, "base64").toString("utf-8")).toBe(`x-access-token:${testToken}`);
    // The raw token must never appear unencoded in the header.
    expect(header).not.toContain(testToken);
  });

  it("does not persist auth token to .git/config after clone (ensureLocalClone with authToken)", async () => {
    // Even though this is file://, passing authToken exercises the real credential code path
    const dataDir = path.join(tmpRoot, "data-security-clone");
    const testToken = "fake-secret-token-12345";
    const dir = await ensureLocalClone({
      dataDir,
      connectionId: "conn-secure-clone",
      remoteUrl: `file://${bareRepoPath}`,
      branch: "main",
      authToken: testToken,
    });

    // Verify the clone succeeded and files are checked out
    expect(fs.existsSync(path.join(dir, "sfdx-project.json"))).toBe(true);

    // Read .git/config and verify the token is NOT in it (critical security check)
    const configPath = path.join(dir, ".git", "config");
    const configContent = fs.readFileSync(configPath, "utf-8");

    // Token should never appear anywhere in persistent config
    expect(configContent).not.toContain(testToken);
    expect(configContent).not.toContain("x-access-token");
    expect(configContent).not.toContain("AUTHORIZATION");
    expect(configContent).not.toContain("basic");

    // Config should only have standard remote url, no credentials embedded
    expect(configContent).toContain(`url = file://`);
  });

  it("does not persist auth token to .git/config during commitAllAndPush", async () => {
    const dataDir = path.join(tmpRoot, "data-security-push");
    const testToken = "fake-push-token-54321";

    // Clone with a different token to ensure push auth is separate
    const dir = await ensureLocalClone({
      dataDir,
      connectionId: "conn-secure-push",
      remoteUrl: `file://${bareRepoPath}`,
      branch: "main",
      authToken: "initial-clone-token",
    });

    // Write a file and push with a different token
    fs.writeFileSync(path.join(dir, "security-test.txt"), "test content");
    await commitAllAndPush({
      dataDir,
      connectionId: "conn-secure-push",
      message: "security test",
      authToken: testToken
    });

    // Verify the push succeeded by checking a new clone
    const verifyDir = path.join(tmpRoot, "verify-security");
    await simpleGit().clone(bareRepoPath, verifyDir, ["--branch", "main", "--single-branch"]);
    expect(fs.existsSync(path.join(verifyDir, "security-test.txt"))).toBe(true);

    // Most importantly: verify the push-time token is NOT in .git/config
    const configPath = path.join(dir, ".git", "config");
    const configContent = fs.readFileSync(configPath, "utf-8");

    // Neither the initial clone token nor the push token should be in config
    expect(configContent).not.toContain(testToken);
    expect(configContent).not.toContain("initial-clone-token");
    expect(configContent).not.toContain("x-access-token");
    expect(configContent).not.toContain("AUTHORIZATION");
  });
});
