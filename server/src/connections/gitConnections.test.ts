import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { openDb, runMigrations } from "../db/client.js";
import { createGitConnection } from "./gitConnections.js";
import { listConnections } from "./orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "./gitConnections.js";

process.env.ENCRYPTION_KEY = "d".repeat(64);

describe("createGitConnection", () => {
  it("stores a git connection without exposing the auth token", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const created = createGitConnection(db, {
      nickname: "Metadata Repo",
      remoteUrl: "https://github.com/example/sf-metadata.git",
      defaultBranch: "main",
      authToken: "ghp_rawtoken",
    });
    expect(created.type).toBe("git");
    const list = listConnections(db);
    expect(list[0].remoteUrl).toBe("https://github.com/example/sf-metadata.git");
    expect(list[0]).not.toHaveProperty("encryptedAuthToken");
    db.close();
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
    await simpleGit().clone(bareRepoPath, verifyDir);
    expect(fs.existsSync(path.join(verifyDir, "new-file.txt"))).toBe(true);
  });
});
