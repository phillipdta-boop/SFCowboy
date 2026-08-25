import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import simpleGit from "simple-git";
import { encrypt } from "../crypto/encryption.js";
import type { ConnectionSummary } from "./orgConnections.js";

export function createGitConnection(
  db: Database.Database,
  input: { nickname: string; remoteUrl: string; defaultBranch: string; authToken: string }
): ConnectionSummary {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (id, type, nickname, created_at, remote_url, default_branch, encrypted_auth_token)
     VALUES (?, 'git', ?, ?, ?, ?, ?)`
  ).run(id, input.nickname, createdAt, input.remoteUrl, input.defaultBranch, encrypt(input.authToken));

  return {
    id,
    type: "git",
    nickname: input.nickname,
    createdAt,
    lastUsedAt: null,
    remoteUrl: input.remoteUrl,
    defaultBranch: input.defaultBranch,
  };
}

export function localCloneDir(dataDir: string, connectionId: string): string {
  return path.join(dataDir, "git-clones", connectionId);
}

function authedRemoteUrl(remoteUrl: string, token: string): string {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "x-access-token";
      url.password = token;
      return url.toString();
    }
  } catch {
    // If URL parsing fails, return as-is
    return remoteUrl;
  }
  return remoteUrl;
}

export async function ensureLocalClone(opts: {
  dataDir: string;
  connectionId: string;
  remoteUrl: string;
  branch: string;
  authToken: string;
}): Promise<string> {
  const dir = localCloneDir(opts.dataDir, opts.connectionId);
  const remote = authedRemoteUrl(opts.remoteUrl, opts.authToken);

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    await simpleGit().clone(remote, dir, ["--branch", opts.branch, "--single-branch"]);
  } else {
    const git = simpleGit(dir);
    await git.fetch("origin", opts.branch);
    await git.checkout(opts.branch);
    await git.reset(["--hard", `origin/${opts.branch}`]);
  }

  // Ensure git user is configured for commits
  const git = simpleGit(dir);
  try {
    await git.getConfig("user.email");
  } catch {
    await git.addConfig("user.email", "sfcowboy@example.com");
    await git.addConfig("user.name", "SFCowboy");
  }

  return dir;
}

export async function commitAllAndPush(opts: { dataDir: string; connectionId: string; message: string }): Promise<void> {
  const dir = localCloneDir(opts.dataDir, opts.connectionId);
  const git = simpleGit(dir);
  await git.add(".");
  const status = await git.status();
  if (status.files.length === 0) return;
  await git.commit(opts.message);
  await git.push();
}
