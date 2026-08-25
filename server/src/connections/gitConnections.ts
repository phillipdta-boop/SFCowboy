import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { simpleGit } from "simple-git";
import { encrypt } from "../crypto/encryption.js";
import type { ConnectionSummary } from "./orgConnections.js";

// Generate HTTP Basic auth header for git HTTP operations
// Passed via -c http.extraheader flag (ephemeral, not persisted to config)
function gitAuthHeader(token: string): string {
  const credentials = `x-access-token:${token}`;
  const base64 = Buffer.from(credentials).toString("base64");
  return `http.extraheader=AUTHORIZATION: basic ${base64}`;
}

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

// Returns the remote URL without embedded credentials.
// Credentials are supplied separately via git config flags (not persisted to .git/config).
function getRemoteUrl(remoteUrl: string): string {
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
  const remote = getRemoteUrl(opts.remoteUrl);

  // Supply auth via config flag (ephemeral, not persisted to .git/config)
  // Harmless for non-http transports (git ignores http.* config for file://, git://, etc.)
  const gitConfig = opts.authToken ? [gitAuthHeader(opts.authToken)] : [];

  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    const gitForClone = simpleGit({ config: gitConfig });
    await gitForClone.clone(remote, dir, ["--branch", opts.branch, "--single-branch"]);
  } else {
    const git = simpleGit(dir, { config: gitConfig });
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

export async function commitAllAndPush(opts: { dataDir: string; connectionId: string; message: string; authToken?: string }): Promise<void> {
  const dir = localCloneDir(opts.dataDir, opts.connectionId);

  // Supply auth via config flag for push operations (ephemeral, not persisted)
  const gitConfig = opts.authToken ? [gitAuthHeader(opts.authToken)] : [];
  const git = simpleGit(dir, { config: gitConfig });

  await git.add(".");
  const status = await git.status();
  if (status.files.length === 0) return;
  await git.commit(opts.message);
  await git.push();
}
