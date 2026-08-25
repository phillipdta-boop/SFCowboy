# SFCowboy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SFCowboy, a self-hosted single-user web app for diffing and deploying Salesforce metadata between orgs and/or a git repo, with rollback, deployed to `deploy.effluence.com.au` via Fly.io.

**Architecture:** Node.js/TypeScript Express backend using `@salesforce/source-deploy-retrieve` + `@salesforce/core` for all Salesforce metadata operations and SQLite (`better-sqlite3`) for state; React/TypeScript (Vite) frontend served as static assets by the same Express app in production; single Docker image deployed to Fly.io.

**Tech Stack:** TypeScript, Express, better-sqlite3, @salesforce/source-deploy-retrieve, @salesforce/core, React, Vite, Vitest + Supertest, Docker, Fly.io, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-08-24-sfcowboy-design.md](../specs/2026-08-24-sfcowboy-design.md)

## Global Constraints

- Node.js 22+ (raised from the original 20+ floor: `better-sqlite3` 13.x, needed for a prebuilt binary on this environment's Node 24, requires Node >=22 — see ledger ruling under Task 2), TypeScript strict mode, ESM modules throughout.
- No `sf`/`sfdx` CLI binary dependency — Salesforce operations go through `@salesforce/source-deploy-retrieve` and `@salesforce/core` as libraries only.
- All secrets (refresh tokens, git PATs) encrypted at rest with AES-256-GCM using `ENCRYPTION_KEY` env var — never persisted in plaintext, never committed.
- Unit/integration tests must not require live Salesforce credentials — mock `@salesforce/core` `Connection`/`AuthInfo` and SDR `ComponentSet`/deploy-retrieve classes; no test may make a real network call to Salesforce or GitHub.
- Production deploy targets force minimum test level `RunLocalTests` (Salesforce requirement); sandboxes default to `NoTestRun` but any level is user-selectable.
- OAuth callback URL is fixed: `https://deploy.effluence.com.au/oauth/callback` (configurable via `OAUTH_CALLBACK_URL` env var for local dev).
- Test runner: Vitest for both `server/` and `web/`; API route tests use Supertest against the Express app.
- Commit after every task using Conventional Commits style (`feat:`, `fix:`, `test:`, `chore:`).

## File Structure

```
SFCowboy/
  server/
    package.json, tsconfig.json, vitest.config.ts
    src/
      index.ts                    # Express app entrypoint
      config.ts                   # env var loading/validation
      db/
        schema.sql
        client.ts                 # better-sqlite3 wrapper + migration runner
      crypto/
        encryption.ts             # AES-256-GCM encrypt/decrypt
      auth/
        oauth.ts                  # PKCE + Salesforce OAuth flow
        routes.ts                 # /api/oauth/* routes
      connections/
        orgConnections.ts         # org CRUD + token refresh
        gitConnections.ts         # git CRUD + clone/pull
        routes.ts                 # /api/connections/* routes
      engine/
        sfConnection.ts           # AuthInfo/Connection builder from stored org
        orgComponents.ts          # describeMetadata + listMetadata -> ComponentSet
        gitComponents.ts          # SFDX source dir -> ComponentSet
        diff.ts                   # compare two component sets
        deploy.ts                 # snapshot + validate/deploy + status
        rollback.ts               # rollback a completed deployment
        routes.ts                 # /api/diff, /api/deployments/* routes
      pipelines/
        pipelines.ts
        routes.ts                 # /api/pipelines/* routes
      history/
        routes.ts                 # /api/history routes (reads deployments)
    Dockerfile
  web/
    package.json, tsconfig.json, vite.config.ts, vitest.config.ts
    src/
      main.tsx, App.tsx, api/client.ts
      pages/Connections.tsx
      pages/Pipelines.tsx
      pages/NewDeployment.tsx
      pages/DeploymentDetail.tsx
      pages/History.tsx
      components/DiffTree.tsx
  fly.toml
  .github/workflows/deploy.yml
  README.md
```

---

### Task 1: Backend scaffolding + health check

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/src/index.ts`
- Create: `server/src/app.ts`
- Test: `server/src/app.test.ts`

**Interfaces:**
- Produces: `createApp(): express.Express` (exported from `server/src/app.ts`) — every later route task imports this and mounts routers on it.

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "sfcowboy-server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2",
    "better-sqlite3": "^13.0.3"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.2",
    "typescript": "^5.5.4",
    "tsx": "^4.16.2",
    "vitest": "^2.0.5",
    "supertest": "^7.0.0"
  }
}
```

- [ ] **Step 2: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `server/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
});
```

- [ ] **Step 4: Write the failing test for `createApp`**

```typescript
// server/src/app.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("createApp", () => {
  it("responds to GET /api/health with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd server && npm install && npm test`
Expected: FAIL — `./app.js` has no exported member `createApp`.

- [ ] **Step 6: Implement `server/src/app.ts`**

```typescript
import express from "express";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
```

- [ ] **Step 7: Implement `server/src/index.ts`**

```typescript
import { createApp } from "./app.js";

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
const app = createApp();

app.listen(port, () => {
  console.log(`SFCowboy server listening on :${port}`);
});
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/tsconfig.json server/vitest.config.ts server/src/index.ts server/src/app.ts server/src/app.test.ts
git commit -m "feat: scaffold backend with health check endpoint"
```

### Task 2: SQLite schema + db client

**Files:**
- Create: `server/src/db/schema.sql`
- Create: `server/src/db/client.ts`
- Test: `server/src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `openDb(path: string): Database.Database` and `runMigrations(db: Database.Database): void` from `server/src/db/client.ts` — every later data-access task (`orgConnections.ts`, `gitConnections.ts`, `pipelines.ts`, `deploy.ts`, `history`) imports `openDb` to get a connection and expects these tables to exist: `connections`, `pipelines`, `deployments`, `deployment_items`.

- [ ] **Step 1: Create `server/src/db/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('org', 'git')),
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  instance_url TEXT,
  org_type TEXT CHECK (org_type IN ('sandbox', 'production')),
  encrypted_refresh_token TEXT,
  remote_url TEXT,
  default_branch TEXT,
  encrypted_auth_token TEXT
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  source_connection_id TEXT NOT NULL,
  target_connection_id TEXT NOT NULL,
  component_list TEXT NOT NULL,
  test_level TEXT NOT NULL CHECK (test_level IN ('NoTestRun','RunSpecifiedTests','RunLocalTests','RunAllTestsInOrg')),
  status TEXT NOT NULL CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back')),
  validate_only INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_detail TEXT,
  snapshot_path TEXT,
  is_rollback_of TEXT REFERENCES deployments(id)
);

CREATE TABLE IF NOT EXISTS deployment_items (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  metadata_type TEXT NOT NULL,
  api_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add','modify','delete')),
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','failed')),
  error_message TEXT
);
```

- [ ] **Step 2: Write the failing test for `openDb`/`runMigrations`**

```typescript
// server/src/db/client.test.ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import { openDb, runMigrations } from "./client.js";

const testDbPath = "./test-sfcowboy.db";

afterEach(() => {
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
});

describe("db client", () => {
  it("creates all expected tables", () => {
    const db = openDb(testDbPath);
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining(["connections", "pipelines", "deployments", "deployment_items"])
    );
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./client.js` has no exported member `openDb`.

- [ ] **Step 4: Implement `server/src/db/client.ts`**

```typescript
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function runMigrations(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  db.exec(schema);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.sql server/src/db/client.ts server/src/db/client.test.ts
git commit -m "feat: add SQLite schema and db client"
```

### Task 3: Encryption utility

**Files:**
- Create: `server/src/crypto/encryption.ts`
- Test: `server/src/crypto/encryption.test.ts`

**Interfaces:**
- Consumes: `process.env.ENCRYPTION_KEY` (64-char hex string, 32 bytes).
- Produces: `encrypt(plaintext: string): string` and `decrypt(ciphertext: string): string` from `server/src/crypto/encryption.ts` — used by `orgConnections.ts` and `gitConnections.ts` to store/read refresh tokens and PATs.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/crypto/encryption.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { encrypt, decrypt } from "./encryption.js";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64); // 32-byte hex key for tests
});

describe("encryption", () => {
  it("round-trips a plaintext string", () => {
    const plaintext = "refresh-token-abc123";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext each call", () => {
    const a = encrypt("same-value");
    const b = encrypt("same-value");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./encryption.js` has no exported member `encrypt`.

- [ ] **Step 3: Implement `server/src/crypto/encryption.ts`**

```typescript
import crypto from "node:crypto";

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

// Stored format: base64(iv) . base64(authTag) . base64(ciphertext)
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decrypt(stored: string): string {
  const key = getKey();
  const [ivB64, authTagB64, ciphertextB64] = stored.split(".");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/crypto/encryption.ts server/src/crypto/encryption.test.ts
git commit -m "feat: add AES-256-GCM encryption utility for stored secrets"
```

### Task 4: Config loader + Salesforce OAuth core (PKCE + token exchange)

**Files:**
- Create: `server/src/config.ts`
- Create: `server/src/auth/oauth.ts`
- Test: `server/src/auth/oauth.test.ts`

**Interfaces:**
- Consumes: `process.env` (`SF_CLIENT_ID`, `SF_CLIENT_SECRET`, `OAUTH_CALLBACK_URL`, `ENCRYPTION_KEY`, `PORT`, `DB_PATH`) via `config.ts`'s `loadConfig()`.
- Produces (from `server/src/auth/oauth.ts`):
  - `createPkcePair(): { verifier: string; challenge: string }`
  - `buildAuthorizeUrl(opts: { loginUrl: string; state: string; challenge: string; callbackUrl: string; clientId: string }): string`
  - `exchangeCodeForTokens(opts: { loginUrl: string; code: string; verifier: string; callbackUrl: string; clientId: string; clientSecret: string }): Promise<{ accessToken: string; refreshToken: string; instanceUrl: string }>`
  - `refreshAccessToken(opts: { loginUrl: string; refreshToken: string; clientId: string; clientSecret: string }): Promise<{ accessToken: string; instanceUrl: string }>`
  These are consumed by Task 5's org connection routes.

- [ ] **Step 1: Implement `server/src/config.ts`**

```typescript
export interface Config {
  port: number;
  dbPath: string;
  encryptionKey: string;
  sfClientId: string;
  sfClientSecret: string;
  oauthCallbackUrl: string;
}

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY", "SF_CLIENT_ID", "SF_CLIENT_SECRET"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    dbPath: process.env.DB_PATH ?? "./sfcowboy.db",
    encryptionKey: process.env.ENCRYPTION_KEY!,
    sfClientId: process.env.SF_CLIENT_ID!,
    sfClientSecret: process.env.SF_CLIENT_SECRET!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
  };
}
```

- [ ] **Step 2: Write the failing test for PKCE + URL building (no network)**

```typescript
// server/src/auth/oauth.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createPkcePair, buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPkcePair", () => {
  it("returns a verifier and a derived challenge", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge).not.toBe(verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes required OAuth query params", () => {
    const url = buildAuthorizeUrl({
      loginUrl: "https://test.salesforce.com",
      state: "abc",
      challenge: "xyz",
      callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
      clientId: "client123",
    });
    expect(url).toContain("https://test.salesforce.com/services/oauth2/authorize");
    expect(url).toContain("code_challenge=xyz");
    expect(url).toContain("state=abc");
    expect(url).toContain("client_id=client123");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fdeploy.effluence.com.au%2Foauth%2Fcallback");
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts to the token endpoint and returns parsed tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "acc123",
        refresh_token: "ref456",
        instance_url: "https://myorg.my.salesforce.com",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForTokens({
      loginUrl: "https://test.salesforce.com",
      code: "authcode",
      verifier: "verifier123",
      callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
      clientId: "client123",
      clientSecret: "secret456",
    });

    expect(result).toEqual({
      accessToken: "acc123",
      refreshToken: "ref456",
      instanceUrl: "https://myorg.my.salesforce.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://test.salesforce.com/services/oauth2/token",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad_request" }));
    await expect(
      exchangeCodeForTokens({
        loginUrl: "https://test.salesforce.com",
        code: "bad",
        verifier: "v",
        callbackUrl: "https://deploy.effluence.com.au/oauth/callback",
        clientId: "c",
        clientSecret: "s",
      })
    ).rejects.toThrow(/OAuth token exchange failed/);
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh_token grant and returns a new access token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "newacc", instance_url: "https://myorg.my.salesforce.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshAccessToken({
      loginUrl: "https://login.salesforce.com",
      refreshToken: "ref456",
      clientId: "client123",
      clientSecret: "secret456",
    });

    expect(result).toEqual({ accessToken: "newacc", instanceUrl: "https://myorg.my.salesforce.com" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./oauth.js` module not found.

- [ ] **Step 4: Implement `server/src/auth/oauth.ts`**

```typescript
import crypto from "node:crypto";

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  loginUrl: string;
  state: string;
  challenge: string;
  callbackUrl: string;
  clientId: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.callbackUrl,
    scope: "api refresh_token offline_access",
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${opts.loginUrl}/services/oauth2/authorize?${params.toString()}`;
}

async function postToken(loginUrl: string, body: URLSearchParams): Promise<any> {
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OAuth token exchange failed (${res.status}): ${detail}`);
  }
  return res.json();
}

export async function exchangeCodeForTokens(opts: {
  loginUrl: string;
  code: string;
  verifier: string;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; refreshToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.callbackUrl,
    code_verifier: opts.verifier,
  });
  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, refreshToken: json.refresh_token, instanceUrl: json.instance_url };
}

export async function refreshAccessToken(opts: {
  loginUrl: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<{ accessToken: string; instanceUrl: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const json = await postToken(opts.loginUrl, body);
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/config.ts server/src/auth/oauth.ts server/src/auth/oauth.test.ts
git commit -m "feat: add config loader and Salesforce OAuth PKCE core"
```

### Task 5: Org connections (storage) + OAuth start/callback routes

**Files:**
- Create: `server/src/connections/orgConnections.ts`
- Create: `server/src/auth/routes.ts`
- Test: `server/src/connections/orgConnections.test.ts`
- Test: `server/src/auth/routes.test.ts`

**Interfaces:**
- Consumes: `openDb`/`runMigrations` (Task 2), `encrypt`/`decrypt` (Task 3), `createPkcePair`/`buildAuthorizeUrl`/`exchangeCodeForTokens`/`refreshAccessToken` (Task 4), `Config` type (Task 4), `createApp` (Task 1).
- Produces:
  - `ConnectionSummary` type and `createOrgConnection`, `listConnections`, `deleteConnection`, `getConnectionRow`, `getValidAccessToken` from `server/src/connections/orgConnections.ts` — Task 6 (git connections) reuses `listConnections`/`deleteConnection`/`getConnectionRow` since they operate on the shared `connections` table; Task 7 (`sfConnection.ts`) consumes `getValidAccessToken`.
  - `createAuthRouter(db: Database.Database, config: Config): Router` from `server/src/auth/routes.ts`, mounted in `app.ts` in Task 15.

- [ ] **Step 1: Write the failing test for org connection storage**

```typescript
// server/src/connections/orgConnections.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection, listConnections, deleteConnection, getValidAccessToken } from "./orgConnections.js";
import * as oauth from "../auth/oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "b".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("orgConnections", () => {
  it("creates a connection and lists it without exposing the refresh token", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Dev Sandbox",
      orgType: "sandbox",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });
    expect(created.nickname).toBe("Dev Sandbox");

    const list = listConnections(db);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("encryptedRefreshToken");
    expect(list[0].nickname).toBe("Dev Sandbox");
    db.close();
  });

  it("deletes a connection", () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "QA",
      orgType: "sandbox",
      instanceUrl: "https://myorg--qa.sandbox.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });
    deleteConnection(db, created.id);
    expect(listConnections(db)).toHaveLength(0);
    db.close();
  });

  it("refreshes an access token using the decrypted refresh token", async () => {
    const db = freshDb();
    const created = createOrgConnection(db, {
      nickname: "Prod",
      orgType: "production",
      instanceUrl: "https://myorg.my.salesforce.com",
      refreshToken: "raw-refresh-token",
    });

    const spy = vi.spyOn(oauth, "refreshAccessToken").mockResolvedValue({
      accessToken: "fresh-access-token",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const result = await getValidAccessToken(db, created.id, config);

    expect(result.accessToken).toBe("fresh-access-token");
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ loginUrl: "https://login.salesforce.com", refreshToken: "raw-refresh-token" })
    );
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./orgConnections.js` module not found.

- [ ] **Step 3: Implement `server/src/connections/orgConnections.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { encrypt, decrypt } from "../crypto/encryption.js";
import { refreshAccessToken } from "../auth/oauth.js";
import type { Config } from "../config.js";

export interface ConnectionSummary {
  id: string;
  type: "org" | "git";
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  instanceUrl?: string;
  orgType?: "sandbox" | "production";
  remoteUrl?: string;
  defaultBranch?: string;
}

export function createOrgConnection(
  db: Database.Database,
  input: { nickname: string; orgType: "sandbox" | "production"; instanceUrl: string; refreshToken: string }
): ConnectionSummary {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO connections (id, type, nickname, created_at, instance_url, org_type, encrypted_refresh_token)
     VALUES (?, 'org', ?, ?, ?, ?, ?)`
  ).run(id, input.nickname, createdAt, input.instanceUrl, input.orgType, encrypt(input.refreshToken));

  return { id, type: "org", nickname: input.nickname, createdAt, lastUsedAt: null, instanceUrl: input.instanceUrl, orgType: input.orgType };
}

export function listConnections(db: Database.Database): ConnectionSummary[] {
  return db
    .prepare(
      `SELECT id, type, nickname,
              created_at as createdAt, last_used_at as lastUsedAt,
              instance_url as instanceUrl, org_type as orgType,
              remote_url as remoteUrl, default_branch as defaultBranch
       FROM connections`
    )
    .all() as ConnectionSummary[];
}

export function deleteConnection(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM connections WHERE id = ?`).run(id);
}

export function getConnectionRow(db: Database.Database, id: string): any {
  return db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id);
}

export async function getValidAccessToken(
  db: Database.Database,
  id: string,
  config: Config
): Promise<{ accessToken: string; instanceUrl: string }> {
  const row = getConnectionRow(db, id);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${id}`);
  }
  const refreshToken = decrypt(row.encrypted_refresh_token);
  const loginUrl = row.org_type === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

  const { accessToken, instanceUrl } = await refreshAccessToken({
    loginUrl,
    refreshToken,
    clientId: config.sfClientId,
    clientSecret: config.sfClientSecret,
  });

  db.prepare(`UPDATE connections SET last_used_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  return { accessToken, instanceUrl };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing test for OAuth start/callback routes**

```typescript
// server/src/auth/routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createAuthRouter } from "./routes.js";
import { listConnections } from "../connections/orgConnections.js";
import * as oauth from "./oauth.js";
import type { Config } from "../config.js";

process.env.ENCRYPTION_KEY = "c".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(createAuthRouter(db, config));
  return { app, db };
}

describe("auth routes", () => {
  it("redirects to the Salesforce authorize URL on start", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/connections/org/start?nickname=Dev&orgType=sandbox");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("https://test.salesforce.com/services/oauth2/authorize");
  });

  it("creates a connection on a valid callback", async () => {
    const { app, db } = buildApp();
    vi.spyOn(oauth, "exchangeCodeForTokens").mockResolvedValue({
      accessToken: "acc",
      refreshToken: "ref",
      instanceUrl: "https://myorg--dev.sandbox.my.salesforce.com",
    });

    const start = await request(app).get("/api/connections/org/start?nickname=Dev&orgType=sandbox");
    const state = new URL(start.headers.location).searchParams.get("state")!;

    const callback = await request(app).get(`/oauth/callback?code=abc&state=${state}`);
    expect(callback.status).toBe(302);
    expect(listConnections(db)).toHaveLength(1);
  });

  it("rejects a callback with an unknown state", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/oauth/callback?code=abc&state=unknown");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./routes.js` module not found.

- [ ] **Step 7: Implement `server/src/auth/routes.ts`**

```typescript
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type Database from "better-sqlite3";
import { createPkcePair, buildAuthorizeUrl, exchangeCodeForTokens } from "./oauth.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

interface PendingAuth {
  verifier: string;
  nickname: string;
  orgType: "sandbox" | "production";
  loginUrl: string;
}

export function createAuthRouter(db: Database.Database, config: Config): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();

  router.get("/api/connections/org/start", (req, res) => {
    const nickname = String(req.query.nickname ?? "");
    const orgType = req.query.orgType === "sandbox" ? "sandbox" : "production";
    if (!nickname) {
      res.status(400).json({ error: "nickname is required" });
      return;
    }

    const loginUrl = orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
    const { verifier, challenge } = createPkcePair();
    const state = randomUUID();
    pending.set(state, { verifier, nickname, orgType, loginUrl });

    const url = buildAuthorizeUrl({
      loginUrl,
      state,
      challenge,
      callbackUrl: config.oauthCallbackUrl,
      clientId: config.sfClientId,
    });
    res.redirect(url);
  });

  router.get("/oauth/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const entry = state ? pending.get(state) : undefined;

    if (!code || !entry) {
      res.status(400).json({ error: "invalid or expired oauth state" });
      return;
    }
    pending.delete(state!);

    try {
      const tokens = await exchangeCodeForTokens({
        loginUrl: entry.loginUrl,
        code,
        verifier: entry.verifier,
        callbackUrl: config.oauthCallbackUrl,
        clientId: config.sfClientId,
        clientSecret: config.sfClientSecret,
      });
      createOrgConnection(db, {
        nickname: entry.nickname,
        orgType: entry.orgType,
        instanceUrl: tokens.instanceUrl,
        refreshToken: tokens.refreshToken,
      });
      res.redirect("/connections?connected=1");
    } catch (err) {
      res.redirect(`/connections?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  return router;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/connections/orgConnections.ts server/src/connections/orgConnections.test.ts server/src/auth/routes.ts server/src/auth/routes.test.ts
git commit -m "feat: add org connection storage and OAuth start/callback routes"
```

### Task 6: Git connections (storage + local clone management)

**Files:**
- Create: `server/src/connections/gitConnections.ts`
- Test: `server/src/connections/gitConnections.test.ts`
- Modify: `server/package.json` (add `simple-git` dependency)

**Interfaces:**
- Consumes: `openDb`/`runMigrations` (Task 2), `encrypt`/`decrypt` (Task 3), the shared `connections` table (Task 2), `ConnectionSummary` type + `listConnections`/`deleteConnection`/`getConnectionRow` (Task 5, reused as-is — git rows live in the same table).
- Produces: `createGitConnection(db, input): ConnectionSummary`, `localCloneDir(dataDir, connectionId): string`, `ensureLocalClone(opts): Promise<string>`, `commitAllAndPush(opts): Promise<void>` from `server/src/connections/gitConnections.ts` — Task 9 (`gitComponents.ts`) calls `ensureLocalClone` to get a working directory to scan; Task 11's org→git deploy direction calls `commitAllAndPush`.

- [ ] **Step 1: Add `simple-git` to `server/package.json` dependencies**

```json
"simple-git": "^3.25.0"
```

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing test for connection storage**

```typescript
// server/src/connections/gitConnections.test.ts (part 1 of 2 describe blocks)
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
    await simpleGit().clone(bareRepoPath, verifyDir, ["--branch", "main", "--single-branch"]);
    expect(fs.existsSync(path.join(verifyDir, "new-file.txt"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./gitConnections.js` module not found.

- [ ] **Step 4: Implement `server/src/connections/gitConnections.ts`**

```typescript
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
  const url = new URL(remoteUrl);
  if (url.protocol === "http:" || url.protocol === "https:") {
    url.username = "x-access-token";
    url.password = token;
  }
  return url.toString();
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/src/connections/gitConnections.ts server/src/connections/gitConnections.test.ts
git commit -m "feat: add git connection storage and local clone management"
```

### Task 7: `sfConnection.ts` — build a Salesforce Connection from a stored org

**Files:**
- Create: `server/src/engine/sfConnection.ts`
- Test: `server/src/engine/sfConnection.test.ts`
- Modify: `server/package.json` (add `@salesforce/core` dependency)

**Interfaces:**
- Consumes: `getConnectionRow`, `getValidAccessToken` (Task 5).
- Produces: `buildOrgConnection(db, connectionId, config): Promise<Connection>` from `server/src/engine/sfConnection.ts` — Task 8 (`orgComponents.ts`) and Task 11 (deploy engine) both call this to get a live, authenticated `@salesforce/core` `Connection` for an org connection id.

- [ ] **Step 1: Add `@salesforce/core` to `server/package.json` dependencies**

```json
"@salesforce/core": "^8.5.1"
```

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing test**

```typescript
// server/src/engine/sfConnection.test.ts
import { describe, it, expect, vi } from "vitest";
import { AuthInfo, Connection } from "@salesforce/core";
import * as orgConnections from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";

vi.mock("@salesforce/core", () => ({
  AuthInfo: { create: vi.fn().mockResolvedValue({ fakeAuthInfo: true }) },
  Connection: { create: vi.fn().mockResolvedValue({ fakeConnection: true }) },
}));

describe("buildOrgConnection", () => {
  it("builds a Connection from a freshly refreshed access token", async () => {
    vi.spyOn(orgConnections, "getConnectionRow").mockReturnValue({ id: "conn1", type: "org" } as any);
    vi.spyOn(orgConnections, "getValidAccessToken").mockResolvedValue({
      accessToken: "acc",
      instanceUrl: "https://myorg.my.salesforce.com",
    });

    const conn = await buildOrgConnection({} as any, "conn1", {} as any);

    expect(AuthInfo.create).toHaveBeenCalledWith({
      accessTokenOptions: { accessToken: "acc", instanceUrl: "https://myorg.my.salesforce.com" },
    });
    expect(Connection.create).toHaveBeenCalledWith({ authInfo: { fakeAuthInfo: true } });
    expect(conn).toEqual({ fakeConnection: true });
  });

  it("throws when the connection id is not an org", async () => {
    vi.spyOn(orgConnections, "getConnectionRow").mockReturnValue({ id: "conn2", type: "git" } as any);
    await expect(buildOrgConnection({} as any, "conn2", {} as any)).rejects.toThrow(/No org connection/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./sfConnection.js` module not found.

- [ ] **Step 4: Implement `server/src/engine/sfConnection.ts`**

```typescript
import { AuthInfo, Connection } from "@salesforce/core";
import type Database from "better-sqlite3";
import { getConnectionRow, getValidAccessToken } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

export async function buildOrgConnection(db: Database.Database, connectionId: string, config: Config): Promise<Connection> {
  const row = getConnectionRow(db, connectionId);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${connectionId}`);
  }

  const { accessToken, instanceUrl } = await getValidAccessToken(db, connectionId, config);
  const authInfo = await AuthInfo.create({ accessTokenOptions: { accessToken, instanceUrl } });
  return Connection.create({ authInfo });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/src/engine/sfConnection.ts server/src/engine/sfConnection.test.ts
git commit -m "feat: build authenticated Salesforce Connection from stored org tokens"
```

### Task 8: `orgComponents.ts` — describe, list, and retrieve components from an org

**Files:**
- Create: `server/src/engine/orgComponents.ts`
- Test: `server/src/engine/orgComponents.test.ts`

**Interfaces:**
- Consumes: a `Connection` (Task 7's return type) — this task's functions take a `Connection` directly, not a connection id, so they're testable with a fully mocked connection object.
- Produces (from `server/src/engine/orgComponents.ts`):
  - `interface ComponentRef { type: string; fullName: string; lastModifiedDate?: string }`
  - `listOrgComponents(connection: Connection): Promise<ComponentRef[]>`
  - `retrieveOrgZip(connection: Connection, components: ComponentRef[]): Promise<Buffer>`
  Task 10 (`diff.ts`) consumes `listOrgComponents` and `ComponentRef`; Task 11 (deploy engine) consumes `retrieveOrgZip` for pre-deploy snapshots.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/engine/orgComponents.test.ts
import { describe, it, expect, vi } from "vitest";
import { listOrgComponents, retrieveOrgZip } from "./orgComponents.js";

function fakeConnection(overrides: Partial<any> = {}) {
  return {
    metadata: {
      describe: vi.fn().mockResolvedValue({
        metadataObjects: [
          { xmlName: "ApexClass", childXmlNames: [] },
          { xmlName: "CustomObject", childXmlNames: [] },
        ],
      }),
      list: vi.fn().mockImplementation(async (queries: { type: string }[]) => {
        const type = queries[0].type;
        if (type === "ApexClass") {
          return [{ fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" }];
        }
        return [{ fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z" }];
      }),
      retrieve: vi.fn().mockResolvedValue({ id: "09S000000retrieve" }),
      checkRetrieveStatus: vi.fn().mockResolvedValue({ done: true, zipFile: Buffer.from("zipdata").toString("base64") }),
    },
    ...overrides,
  };
}

describe("listOrgComponents", () => {
  it("enumerates components across all describe-able metadata types", async () => {
    const conn = fakeConnection();
    const components = await listOrgComponents(conn as any);

    expect(components).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
        { type: "CustomObject", fullName: "Account", lastModifiedDate: "2026-02-01T00:00:00.000Z" },
      ])
    );
  });
});

describe("retrieveOrgZip", () => {
  it("submits a retrieve request and polls until done, returning the zip buffer", async () => {
    const conn = fakeConnection();
    const zip = await retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }]);

    expect(conn.metadata.retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        unpackaged: { types: [{ name: "ApexClass", members: ["MyClass"] }], version: expect.any(String) },
      })
    );
    expect(zip.toString()).toBe("zipdata");
  });

  it("polls again if the retrieve is not yet done", async () => {
    const conn = fakeConnection();
    conn.metadata.checkRetrieveStatus
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, zipFile: Buffer.from("zipdata").toString("base64") });

    const zip = await retrieveOrgZip(conn as any, [{ type: "ApexClass", fullName: "MyClass" }], { pollIntervalMs: 1 });
    expect(conn.metadata.checkRetrieveStatus).toHaveBeenCalledTimes(2);
    expect(zip.toString()).toBe("zipdata");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./orgComponents.js` module not found.

- [ ] **Step 3: Implement `server/src/engine/orgComponents.ts`**

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/orgComponents.ts server/src/engine/orgComponents.test.ts
git commit -m "feat: describe, list, and retrieve org metadata components"
```

### Task 9: `gitComponents.ts` — read components from an SFDX source-format checkout

**Files:**
- Create: `server/src/engine/gitComponents.ts`
- Test: `server/src/engine/gitComponents.test.ts`
- Modify: `server/package.json` (add `@salesforce/source-deploy-retrieve` dependency)

**Interfaces:**
- Consumes: a local filesystem path (as produced by Task 6's `ensureLocalClone`) — this task does not import from `gitConnections.ts` directly, keeping it testable against any plain directory.
- Produces: `listGitComponents(sourceDir: string): ComponentRef[]` and `readGitComponentFiles(sourceDir: string, type: string, fullName: string): { path: string; content: string }[]` from `server/src/engine/gitComponents.ts` — Task 10 (`diff.ts`) consumes both.

- [ ] **Step 1: Add `@salesforce/source-deploy-retrieve` to `server/package.json` dependencies**

```json
"@salesforce/source-deploy-retrieve": "^12.7.4"
```

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing test against a real fixture SFDX project**

```typescript
// server/src/engine/gitComponents.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";

let projectDir: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-source-"));
  fs.writeFileSync(
    path.join(projectDir, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "61.0" })
  );
  const classesDir = path.join(projectDir, "force-app", "main", "default", "classes");
  fs.mkdirSync(classesDir, { recursive: true });
  fs.writeFileSync(path.join(classesDir, "MyClass.cls"), "public class MyClass {}");
  fs.writeFileSync(
    path.join(classesDir, "MyClass.cls-meta.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`
  );
});

afterAll(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("listGitComponents", () => {
  it("finds components in an SFDX source-format project", () => {
    const components = listGitComponents(projectDir);
    expect(components).toEqual(expect.arrayContaining([{ type: "ApexClass", fullName: "MyClass" }]));
  });
});

describe("readGitComponentFiles", () => {
  it("returns file contents for a component", () => {
    const files = readGitComponentFiles(projectDir, "ApexClass", "MyClass");
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.content.includes("public class MyClass"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./gitComponents.js` module not found.

- [ ] **Step 4: Implement `server/src/engine/gitComponents.ts`**

```typescript
import fs from "node:fs";
import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import type { ComponentRef } from "./orgComponents.js";

export function listGitComponents(sourceDir: string): ComponentRef[] {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const refs: ComponentRef[] = [];
  for (const component of componentSet.getSourceComponents()) {
    refs.push({ type: component.type.name, fullName: component.fullName });
  }
  return refs;
}

export function readGitComponentFiles(
  sourceDir: string,
  type: string,
  fullName: string
): { path: string; content: string }[] {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const files: { path: string; content: string }[] = [];

  for (const component of componentSet.getSourceComponents()) {
    if (component.type.name !== type || component.fullName !== fullName) continue;

    for (const filePath of component.walkContent()) {
      files.push({ path: filePath, content: fs.readFileSync(filePath, "utf-8") });
    }
    if (component.xml) {
      files.push({ path: component.xml, content: fs.readFileSync(component.xml, "utf-8") });
    }
  }
  return files;
}
```

> **Note for implementer:** `ComponentSet.fromSource` and `SourceComponent.walkContent`/`.xml` are the stable, documented SDR entry points for reading source-format projects. If `npm install` pulls a version whose type definitions differ from this signature, check `node_modules/@salesforce/source-deploy-retrieve/lib/**/*.d.ts` for the current shape before adjusting — don't guess silently.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/src/engine/gitComponents.ts server/src/engine/gitComponents.test.ts
git commit -m "feat: read metadata components from an SFDX source-format checkout"
```

### Task 10: Diff engine + `/api/diff` routes

**Files:**
- Create: `server/src/engine/diff.ts`
- Create: `server/src/engine/routes.ts`
- Test: `server/src/engine/diff.test.ts`
- Test: `server/src/engine/routes.test.ts`
- Modify: `server/package.json` (add `diff` dependency)

**Interfaces:**
- Consumes: `ComponentRef` (Task 8), `buildOrgConnection` (Task 7), `listOrgComponents` (Task 8), `ensureLocalClone` (Task 6), `listGitComponents`/`readGitComponentFiles` (Task 9), `getConnectionRow` (Task 5), `Config` type (Task 4).
- Produces:
  - `DiffItem { type: string; fullName: string; status: "added"|"modified"|"removed"|"unchanged" }` and `diffComponents(source: ComponentRef[], target: ComponentRef[]): DiffItem[]` from `diff.ts`.
  - `FileDiff { path: string; changes: { added?: boolean; removed?: boolean; value: string }[] }` and `diffFileContents(sourceFiles, targetFiles): FileDiff[]` from `diff.ts`.
  - `createEngineRouter(db, config, dataDir): Router` from `routes.ts`, exposing `GET /api/diff` and `GET /api/diff/content` — mounted in `app.ts` in Task 15. Task 11 (deploy engine) reuses the same connection-resolution pattern shown here.

- [ ] **Step 1: Add `diff` to `server/package.json` dependencies**

```json
"diff": "^5.2.0"
```

Run: `cd server && npm install && npm install --save-dev @types/diff`

- [ ] **Step 2: Write the failing test for the pure diff functions**

```typescript
// server/src/engine/diff.test.ts
import { describe, it, expect } from "vitest";
import { diffComponents, diffFileContents } from "./diff.js";

describe("diffComponents", () => {
  it("classifies added, modified, removed, and unchanged components", () => {
    const source = [
      { type: "ApexClass", fullName: "OnlyInSource" },
      { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-02-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
    ];
    const target = [
      { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "OnlyInTarget" },
    ];

    const result = diffComponents(source, target);

    expect(result).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "OnlyInSource", status: "added" },
        { type: "ApexClass", fullName: "Changed", status: "modified" },
        { type: "ApexClass", fullName: "Same", status: "unchanged" },
        { type: "ApexClass", fullName: "OnlyInTarget", status: "removed" },
      ])
    );
  });

  it("treats components missing a lastModifiedDate (e.g. from git) as needing a content diff", () => {
    const source = [{ type: "ApexClass", fullName: "GitSourced" }];
    const target = [{ type: "ApexClass", fullName: "GitSourced", lastModifiedDate: "2026-01-01T00:00:00.000Z" }];
    const result = diffComponents(source, target);
    expect(result).toEqual([{ type: "ApexClass", fullName: "GitSourced", status: "modified" }]);
  });
});

describe("diffFileContents", () => {
  it("produces line-level changes between matched files", () => {
    const source = [{ path: "/src/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 2;\n}\n" }];
    const target = [{ path: "/retrieved/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 1;\n}\n" }];

    const result = diffFileContents(source, target);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/src/classes/MyClass.cls");
    expect(result[0].changes.some((c) => c.added && c.value.includes("x = 2"))).toBe(true);
    expect(result[0].changes.some((c) => c.removed && c.value.includes("x = 1"))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./diff.js` module not found.

- [ ] **Step 4: Implement `server/src/engine/diff.ts`**

```typescript
import path from "node:path";
import { diffLines } from "diff";
import type { ComponentRef } from "./orgComponents.js";

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
}

function key(c: ComponentRef): string {
  return `${c.type}::${c.fullName}`;
}

export function diffComponents(source: ComponentRef[], target: ComponentRef[]): DiffItem[] {
  const targetMap = new Map(target.map((c) => [key(c), c]));
  const sourceMap = new Map(source.map((c) => [key(c), c]));
  const results: DiffItem[] = [];

  for (const s of source) {
    const t = targetMap.get(key(s));
    if (!t) {
      results.push({ type: s.type, fullName: s.fullName, status: "added" });
    } else if (!s.lastModifiedDate || !t.lastModifiedDate) {
      results.push({ type: s.type, fullName: s.fullName, status: "modified" });
    } else if (s.lastModifiedDate !== t.lastModifiedDate) {
      results.push({ type: s.type, fullName: s.fullName, status: "modified" });
    } else {
      results.push({ type: s.type, fullName: s.fullName, status: "unchanged" });
    }
  }
  for (const t of target) {
    if (!sourceMap.has(key(t))) {
      results.push({ type: t.type, fullName: t.fullName, status: "removed" });
    }
  }
  return results;
}

export interface FileDiff {
  path: string;
  changes: { added?: boolean; removed?: boolean; value: string }[];
}

export function diffFileContents(
  sourceFiles: { path: string; content: string }[],
  targetFiles: { path: string; content: string }[]
): FileDiff[] {
  const targetByBasename = new Map(targetFiles.map((f) => [path.basename(f.path), f]));
  return sourceFiles.map((sf) => {
    const tf = targetByBasename.get(path.basename(sf.path));
    return { path: sf.path, changes: diffLines(tf?.content ?? "", sf.content) };
  });
}
```

- [ ] **Step 5: Run test to verify diff.ts tests pass**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Write the failing test for the diff routes**

```typescript
// server/src/engine/routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createEngineRouter } from "./routes.js";
import * as sfConnection from "./sfConnection.js";
import * as orgComponents from "./orgComponents.js";
import * as gitConnections from "../connections/gitConnections.js";
import * as gitComponents from "./gitComponents.js";

process.env.ENCRYPTION_KEY = "e".repeat(64);

const config = {
  port: 3000, dbPath: ":memory:", encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
} as any;

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(createEngineRouter(db, config, "/tmp/sfcowboy-data"));
  return { app, db };
}

describe("GET /api/diff", () => {
  it("diffs an org source against a git target", async () => {
    const { app, db } = buildApp();
    const org = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x.my.salesforce.com", refreshToken: "r" });
    const git = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "listOrgComponents").mockResolvedValue([{ type: "ApexClass", fullName: "A", lastModifiedDate: "2026-01-01" }]);
    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(gitComponents, "listGitComponents").mockReturnValue([{ type: "ApexClass", fullName: "B" }]);

    const res = await request(app).get(`/api/diff?sourceConnectionId=${org.id}&targetConnectionId=${git.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "A", status: "added" },
        { type: "ApexClass", fullName: "B", status: "removed" },
      ])
    );
  });

  it("404s when a connection id doesn't exist", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/diff?sourceConnectionId=missing&targetConnectionId=alsomissing");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./routes.js` module not found (in `server/src/engine/`).

- [ ] **Step 8: Implement `server/src/engine/routes.ts`**

```typescript
import { Router } from "express";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { getConnectionRow } from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";
import { listOrgComponents, type ComponentRef } from "./orgComponents.js";
import { ensureLocalClone } from "../connections/gitConnections.js";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";
import { decrypt } from "../crypto/encryption.js";
import { diffComponents, diffFileContents } from "./diff.js";

export async function resolveComponents(
  db: Database.Database,
  config: Config,
  dataDir: string,
  connectionId: string
): Promise<{ kind: "org" | "git"; components: ComponentRef[]; sourceDir?: string }> {
  const row = getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return { kind: "org", components: await listOrgComponents(connection) };
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  return { kind: "git", components: listGitComponents(sourceDir), sourceDir };
}

export function createEngineRouter(db: Database.Database, config: Config, dataDir: string): Router {
  const router = Router();

  router.get("/api/diff", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId),
        resolveComponents(db, config, dataDir, targetConnectionId),
      ]);
      res.json(diffComponents(source.components, target.components));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/diff/content", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const type = String(req.query.type ?? "");
    const fullName = String(req.query.fullName ?? "");

    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId),
        resolveComponents(db, config, dataDir, targetConnectionId),
      ]);

      const sourceFiles = source.kind === "git" && source.sourceDir ? readGitComponentFiles(source.sourceDir, type, fullName) : [];
      const targetFiles = target.kind === "git" && target.sourceDir ? readGitComponentFiles(target.sourceDir, type, fullName) : [];

      res.json(diffFileContents(sourceFiles, targetFiles));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  return router;
}
```

> **Note for implementer:** `/api/diff/content` as written only produces a text diff when both sides are git connections, since org-side content comes from a retrieve zip rather than a source-format directory. Extending it to unzip and diff org-retrieved content is straightforward (unzip via `adm-zip` and match files by basename, same as the git case) but is left out of MVP scope per the spec's diff engine description — flag this gap to the user if raised in review rather than silently expanding scope.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/package.json server/src/engine/diff.ts server/src/engine/diff.test.ts server/src/engine/routes.ts server/src/engine/routes.test.ts
git commit -m "feat: add diff engine and /api/diff routes"
```

### Task 11: Format conversion (mdapi ⇄ source) + low-level org deploy primitive

**Files:**
- Create: `server/src/engine/convert.ts`
- Create: `server/src/engine/deployPrimitive.ts`
- Test: `server/src/engine/convert.test.ts`
- Test: `server/src/engine/deployPrimitive.test.ts`
- Modify: `server/package.json` (add `adm-zip` dependency)

**Interfaces:**
- Consumes: `ComponentSet`/`MetadataConverter` from `@salesforce/source-deploy-retrieve` (Task 9's dependency), a `Connection` (Task 7).
- Produces:
  - `convertZipToSourceDir(zipBuffer: Buffer, outputDir: string): Promise<void>` and `convertSourceDirToZip(sourceDir: string, componentRefs: { type: string; fullName: string }[]): Promise<Buffer>` from `convert.ts`.
  - `DeployResult { success: boolean; componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[] }` and `deployZipToOrg(connection, zip, opts, pollIntervalMs?): Promise<DeployResult>` from `deployPrimitive.ts`.
  Task 12 (deployment orchestration) consumes all four.

> **Note for implementer:** `ComponentSet.fromSource` and `MetadataConverter.convert(components, targetFormat, output)` are written here per SDR's documented conversion pattern. Before implementing, run `npm ls @salesforce/source-deploy-retrieve` and check `node_modules/@salesforce/source-deploy-retrieve/lib/src/convert/metadataConverter.d.ts` (and `componentSet.d.ts`) for the exact method signature on the installed version — adjust the calls below to match if they differ, and note the actual signature used in the commit message.

- [ ] **Step 1: Add `adm-zip` to `server/package.json` dependencies**

```json
"adm-zip": "^0.5.14"
```

Run: `cd server && npm install && npm install --save-dev @types/adm-zip`

- [ ] **Step 2: Write the failing test for `convert.ts` (round-trip through a real zip)**

```typescript
// server/src/engine/convert.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { convertZipToSourceDir, convertSourceDirToZip } from "./convert.js";

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-convert-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildFixtureMdapiZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "package.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>MyClass</members>\n    <name>ApexClass</name>\n  </types>\n  <version>61.0</version>\n</Package>\n`
    )
  );
  zip.addFile("classes/MyClass.cls", Buffer.from("public class MyClass {}"));
  zip.addFile(
    "classes/MyClass.cls-meta.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`
    )
  );
  return zip.toBuffer();
}

describe("convertZipToSourceDir", () => {
  it("converts a retrieved mdapi zip into an SFDX source-format directory", async () => {
    const outputDir = path.join(workDir, "source-out");
    await convertZipToSourceDir(buildFixtureMdapiZip(), outputDir);

    const found = fs
      .readdirSync(outputDir, { recursive: true } as any)
      .map(String)
      .some((f) => f.includes("MyClass.cls"));
    expect(found).toBe(true);
  });
});

describe("convertSourceDirToZip", () => {
  it("converts selected components from an SFDX source directory into a deployable zip", async () => {
    const sourceOutputDir = path.join(workDir, "source-for-zip");
    await convertZipToSourceDir(buildFixtureMdapiZip(), sourceOutputDir);

    const zipBuffer = await convertSourceDirToZip(sourceOutputDir, [{ type: "ApexClass", fullName: "MyClass" }]);
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => e.entryName);

    expect(entryNames.some((n) => n.endsWith("MyClass.cls"))).toBe(true);
    expect(entryNames).toContain("package.xml");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./convert.js` module not found.

- [ ] **Step 4: Implement `server/src/engine/convert.ts`**

```typescript
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { ComponentSet, MetadataConverter } from "@salesforce/source-deploy-retrieve";

export async function convertZipToSourceDir(zipBuffer: Buffer, outputDir: string): Promise<void> {
  const mdapiDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-mdapi-"));
  new AdmZip(zipBuffer).extractAllTo(mdapiDir, true);

  const componentSet = ComponentSet.fromSource(mdapiDir);
  const converter = new MetadataConverter();
  await converter.convert(componentSet.getSourceComponents().toArray(), "source", {
    type: "directory",
    outputDirectory: outputDir,
  });

  fs.rmSync(mdapiDir, { recursive: true, force: true });
}

export async function convertSourceDirToZip(
  sourceDir: string,
  componentRefs: { type: string; fullName: string }[]
): Promise<Buffer> {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const wanted = new Set(componentRefs.map((c) => `${c.type}::${c.fullName}`));
  const selected = componentSet
    .getSourceComponents()
    .toArray()
    .filter((c) => wanted.has(`${c.type.name}::${c.fullName}`));

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-zip-"));
  const converter = new MetadataConverter();
  const { packagePath } = await converter.convert(selected, "metadata", { type: "zip", outputDirectory: outputDir });
  const zip = fs.readFileSync(packagePath!);
  fs.rmSync(outputDir, { recursive: true, force: true });
  return zip;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 6: Write the failing test for the deploy primitive**

```typescript
// server/src/engine/deployPrimitive.test.ts
import { describe, it, expect, vi } from "vitest";
import { deployZipToOrg } from "./deployPrimitive.js";

function fakeConnection() {
  return {
    metadata: {
      deploy: vi.fn().mockResolvedValue({ id: "0Af000000deploy" }),
      checkDeployStatus: vi.fn().mockResolvedValue({
        done: true,
        success: true,
        details: {
          componentSuccesses: [{ componentType: "ApexClass", fullName: "MyClass", success: "true" }],
        },
      }),
    },
  };
}

describe("deployZipToOrg", () => {
  it("deploys a zip and returns a success result with per-component detail", async () => {
    const conn = fakeConnection();
    const result = await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false });

    expect(conn.metadata.deploy).toHaveBeenCalledWith(
      Buffer.from("zip"),
      expect.objectContaining({ testLevel: "NoTestRun", checkOnly: false })
    );
    expect(result.success).toBe(true);
    expect(result.componentResults).toEqual([{ type: "ApexClass", fullName: "MyClass", success: true, errorMessage: undefined }]);
  });

  it("polls until the deploy is done", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true, success: true, details: { componentSuccesses: [] } });

    await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false }, 1);
    expect(conn.metadata.checkDeployStatus).toHaveBeenCalledTimes(2);
  });

  it("surfaces component failures", async () => {
    const conn = fakeConnection();
    conn.metadata.checkDeployStatus.mockResolvedValue({
      done: true,
      success: false,
      details: { componentFailures: [{ componentType: "ApexClass", fullName: "MyClass", success: "false", problem: "Compile error" }] },
    });

    const result = await deployZipToOrg(conn as any, Buffer.from("zip"), { testLevel: "NoTestRun", checkOnly: false });
    expect(result.success).toBe(false);
    expect(result.componentResults[0].errorMessage).toBe("Compile error");
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./deployPrimitive.js` module not found.

- [ ] **Step 8: Implement `server/src/engine/deployPrimitive.ts`**

```typescript
import type { Connection } from "@salesforce/core";

export interface DeployResult {
  success: boolean;
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[];
}

export async function deployZipToOrg(
  connection: Connection,
  zip: Buffer,
  opts: { testLevel: string; checkOnly: boolean },
  pollIntervalMs = 2000
): Promise<DeployResult> {
  const conn: any = connection;
  const { id } = await conn.metadata.deploy(zip, { testLevel: opts.testLevel, checkOnly: opts.checkOnly, singlePackage: true });

  let status = await conn.metadata.checkDeployStatus(id, true);
  while (!status.done) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    status = await conn.metadata.checkDeployStatus(id, true);
  }

  const successes = status.details?.componentSuccesses ?? [];
  const failures = status.details?.componentFailures ?? [];
  const all = [...(Array.isArray(successes) ? successes : [successes]), ...(Array.isArray(failures) ? failures : [failures])].filter(Boolean);

  const componentResults = all.map((d: any) => ({
    type: d.componentType,
    fullName: d.fullName,
    success: d.success === "true" || d.success === true,
    errorMessage: d.problem,
  }));

  return { success: status.success === "true" || status.success === true, componentResults };
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add server/package.json server/src/engine/convert.ts server/src/engine/convert.test.ts server/src/engine/deployPrimitive.ts server/src/engine/deployPrimitive.test.ts
git commit -m "feat: add mdapi/source conversion and low-level org deploy primitive"
```

### Task 12: Deployment orchestration + `/api/deployments` routes

**Files:**
- Create: `server/src/engine/deploy.ts`
- Test: `server/src/engine/deploy.test.ts`
- Modify: `server/src/engine/routes.ts` (add deployment routes to `createEngineRouter`)
- Modify: `server/src/engine/routes.test.ts` (add deployment route tests)

**Interfaces:**
- Consumes: `getConnectionRow` (Task 5), `ensureLocalClone`/`commitAllAndPush` (Task 6), `decrypt` (Task 3), `buildOrgConnection` (Task 7), `retrieveOrgZip` (Task 8), `convertZipToSourceDir`/`convertSourceDirToZip` (Task 11), `deployZipToOrg` (Task 11), `Config` (Task 4).
- Produces: `TestLevel`, `DeployComponentSelection`, `createDeployment(db, input): string`, `getDeployment(db, id)`, `listDeployments(db)`, `runDeployment(db, config, dataDir, deploymentId): Promise<void>` from `server/src/engine/deploy.ts` — Task 13 (rollback) consumes `getDeployment` and calls `runDeployment`-adjacent primitives directly; Task 16 (app wiring) mounts the routes added here.

- [ ] **Step 1: Write the failing test for `createDeployment`/`getDeployment`**

```typescript
// server/src/engine/deploy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createGitConnection } from "../connections/gitConnections.js";
import { createDeployment, getDeployment, listDeployments, runDeployment } from "./deploy.js";
import * as sfConnection from "./sfConnection.js";
import * as orgComponents from "./orgComponents.js";
import * as convert from "./convert.js";
import * as deployPrimitive from "./deployPrimitive.js";
import * as gitConnections from "../connections/gitConnections.js";

process.env.ENCRYPTION_KEY = "f".repeat(64);
const config = { sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("createDeployment", () => {
  it("stores the deployment and one deployment_item per component", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });

    const id = createDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("pending");
    expect(deployment.items).toHaveLength(1);
  });

  it("forces RunLocalTests when the target is a production org", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "Prod", orgType: "production", instanceUrl: "https://y", refreshToken: "r" });

    const id = createDeployment(db, {
      sourceConnectionId: source.id,
      targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun",
      validateOnly: false,
    });

    expect(getDeployment(db, id)!.test_level).toBe("RunLocalTests");
  });
});

describe("runDeployment", () => {
  it("deploys org-to-org: snapshots the target, retrieves from source, deploys, and marks succeeded", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(orgComponents, "retrieveOrgZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeTruthy();
    expect(deployment.items[0].status).toBe("succeeded");
  });

  it("deploys git-to-org: converts source to a zip, deploys, marks succeeded, skips snapshot for new components", async () => {
    const db = freshDb();
    const source = createGitConnection(db, { nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "t" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "NewClass", action: "add" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(gitConnections, "ensureLocalClone").mockResolvedValue("/tmp/fake-clone");
    vi.spyOn(convert, "convertSourceDirToZip").mockResolvedValue(Buffer.from("zip"));
    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.snapshot_path).toBeNull();
  });

  it("marks the deployment failed and records the error when the deploy throws", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
      testLevel: "NoTestRun", validateOnly: false,
    });

    vi.spyOn(sfConnection, "buildOrgConnection").mockRejectedValue(new Error("token expired"));

    await runDeployment(db, config, "/tmp/sfcowboy-data", id);

    const deployment = getDeployment(db, id)!;
    expect(deployment.status).toBe("failed");
    expect(JSON.parse(deployment.error_detail).message).toBe("token expired");
  });
});

describe("listDeployments", () => {
  it("returns deployments most-recent first", () => {
    const db = freshDb();
    const a = createOrgConnection(db, { nickname: "A", orgType: "sandbox", instanceUrl: "https://a", refreshToken: "r" });
    const b = createOrgConnection(db, { nickname: "B", orgType: "sandbox", instanceUrl: "https://b", refreshToken: "r" });
    createDeployment(db, { sourceConnectionId: a.id, targetConnectionId: b.id, components: [], testLevel: "NoTestRun", validateOnly: false });
    expect(listDeployments(db)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./deploy.js` module not found.

- [ ] **Step 3: Implement `server/src/engine/deploy.ts`**

```typescript
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getConnectionRow } from "../connections/orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "../connections/gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import { buildOrgConnection } from "./sfConnection.js";
import { retrieveOrgZip } from "./orgComponents.js";
import { convertZipToSourceDir, convertSourceDirToZip } from "./convert.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import type { Config } from "../config.js";

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

export function createDeployment(
  db: Database.Database,
  input: {
    sourceConnectionId: string;
    targetConnectionId: string;
    components: DeployComponentSelection[];
    testLevel: TestLevel;
    validateOnly: boolean;
  }
): string {
  const targetRow = getConnectionRow(db, input.targetConnectionId);
  const effectiveTestLevel: TestLevel =
    targetRow?.type === "org" && targetRow.org_type === "production" && input.testLevel === "NoTestRun"
      ? "RunLocalTests"
      : input.testLevel;

  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(id, input.sourceConnectionId, input.targetConnectionId, JSON.stringify(input.components), effectiveTestLevel, input.validateOnly ? 1 : 0, now);

  for (const c of input.components) {
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(randomUUID(), id, c.type, c.fullName, c.action);
  }
  return id;
}

export function getDeployment(db: Database.Database, id: string): any {
  const deployment: any = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(id);
  if (!deployment) return undefined;
  const items = db.prepare(`SELECT * FROM deployment_items WHERE deployment_id = ?`).all(id);
  return { ...deployment, components: JSON.parse(deployment.component_list), items };
}

export function listDeployments(db: Database.Database): any[] {
  return db.prepare(`SELECT * FROM deployments ORDER BY started_at DESC`).all();
}

function applyDeployResultToItems(
  db: Database.Database,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): void {
  for (const cr of componentResults) {
    db.prepare(
      `UPDATE deployment_items SET status = ?, error_message = ? WHERE deployment_id = ? AND metadata_type = ? AND api_name = ?`
    ).run(cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName);
  }
}

export async function runDeployment(db: Database.Database, config: Config, dataDir: string, deploymentId: string): Promise<void> {
  const deployment: any = db.prepare(`SELECT * FROM deployments WHERE id = ?`).get(deploymentId);
  const components: DeployComponentSelection[] = JSON.parse(deployment.component_list);
  const targetRow = getConnectionRow(db, deployment.target_connection_id);
  const sourceRow = getConnectionRow(db, deployment.source_connection_id);

  try {
    db.prepare(`UPDATE deployments SET status = 'validating' WHERE id = ?`).run(deploymentId);

    let snapshotPath: string | null = null;
    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const existing = components.filter((c) => c.action !== "add");
      if (existing.length > 0) {
        const snapshotZip = await retrieveOrgZip(targetConn, existing);
        snapshotPath = path.join(dataDir, "snapshots", `${deploymentId}.zip`);
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, snapshotZip);
      }
    }
    db.prepare(`UPDATE deployments SET snapshot_path = ? WHERE id = ?`).run(snapshotPath, deploymentId);

    let zip: Buffer;
    if (sourceRow.type === "org") {
      const sourceConn = await buildOrgConnection(db, deployment.source_connection_id, config);
      zip = await retrieveOrgZip(sourceConn, components);
    } else {
      const sourceDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.source_connection_id,
        remoteUrl: sourceRow.remote_url,
        branch: sourceRow.default_branch,
        authToken: decrypt(sourceRow.encrypted_auth_token),
      });
      zip = await convertSourceDirToZip(sourceDir, components);
    }

    db.prepare(`UPDATE deployments SET status = 'deploying' WHERE id = ?`).run(deploymentId);

    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const result = await deployZipToOrg(targetConn, zip, { testLevel: deployment.test_level, checkOnly: !!deployment.validate_only });
      applyDeployResultToItems(db, deploymentId, result.componentResults);
      db.prepare(`UPDATE deployments SET status = ?, finished_at = ?, error_detail = ? WHERE id = ?`).run(
        result.success ? "succeeded" : "failed",
        new Date().toISOString(),
        result.success ? null : JSON.stringify(result),
        deploymentId
      );
    } else {
      const targetDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.target_connection_id,
        remoteUrl: targetRow.remote_url,
        branch: targetRow.default_branch,
        authToken: decrypt(targetRow.encrypted_auth_token),
      });
      await convertZipToSourceDir(zip, targetDir);
      await commitAllAndPush({ dataDir, connectionId: deployment.target_connection_id, message: `SFCowboy deployment ${deploymentId}` });
      db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), deploymentId);
    }
  } catch (err) {
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = ?, error_detail = ? WHERE id = ?`).run(
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      deploymentId
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Add deployment routes to `server/src/engine/routes.ts`**

Add these imports to the top of the file:

```typescript
import { createDeployment, getDeployment, listDeployments, runDeployment, type DeployComponentSelection, type TestLevel } from "./deploy.js";
```

Add these routes inside `createEngineRouter`, before the final `return router;`:

```typescript
  router.post("/api/deployments", (req, res) => {
    const body = req.body as {
      sourceConnectionId: string;
      targetConnectionId: string;
      components: DeployComponentSelection[];
      testLevel: TestLevel;
      validateOnly?: boolean;
    };
    const id = createDeployment(db, {
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly ?? false,
    });

    runDeployment(db, config, dataDir, id).catch((err) => {
      console.error(`Deployment ${id} failed unexpectedly`, err);
    });

    res.status(202).json({ id });
  });

  router.get("/api/deployments", (_req, res) => {
    res.json(listDeployments(db));
  });

  router.get("/api/deployments/:id", (req, res) => {
    const deployment = getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    res.json(deployment);
  });
```

- [ ] **Step 6: Add the failing test for the new routes to `server/src/engine/routes.test.ts`**

```typescript
// append to the import block at the top of server/src/engine/routes.test.ts
import * as deploy from "./deploy.js";
import { createDeployment } from "./deploy.js";

describe("deployment routes", () => {
  it("creates a deployment and kicks off runDeployment", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });

    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/deployments")
      .send({
        sourceConnectionId: source.id,
        targetConnectionId: target.id,
        components: [{ type: "ApexClass", fullName: "MyClass", action: "modify" }],
        testLevel: "NoTestRun",
      });

    expect(res.status).toBe(202);
    expect(res.body.id).toBeTruthy();
    expect(runSpy).toHaveBeenCalled();
  });

  it("returns deployment detail by id", async () => {
    const { app, db } = buildApp();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, {
      sourceConnectionId: source.id, targetConnectionId: target.id,
      components: [], testLevel: "NoTestRun", validateOnly: false,
    });

    const res = await request(app).get(`/api/deployments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/deployments/unknown");
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 7: Also register `express.json()` body parsing in the test app builder**

`buildApp()` in `routes.test.ts` (added in Task 10) must call `app.use(express.json())` before mounting the router, since `POST /api/deployments` reads `req.body`. Update it to:

```typescript
function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createEngineRouter(db, config, "/tmp/sfcowboy-data"));
  return { app, db };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/engine/deploy.ts server/src/engine/deploy.test.ts server/src/engine/routes.ts server/src/engine/routes.test.ts
git commit -m "feat: add deployment orchestration and /api/deployments routes"
```

### Task 13: Rollback engine + `/api/deployments/:id/rollback` route

**Files:**
- Create: `server/src/engine/rollback.ts`
- Test: `server/src/engine/rollback.test.ts`
- Modify: `server/src/engine/routes.ts` (add rollback route)
- Modify: `server/src/engine/routes.test.ts` (add rollback route test)

**Interfaces:**
- Consumes: `getDeployment`, `DeployComponentSelection`, `TestLevel` (Task 12), `getConnectionRow` (Task 5), `buildOrgConnection` (Task 7), `deployZipToOrg` (Task 11), `Config` (Task 4).
- Produces: `rollbackDeployment(db, config, deploymentId): Promise<string>` from `server/src/engine/rollback.ts`, returning the new rollback deployment's id. Task 16 (app wiring) needs nothing new here beyond the route added in this task.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/engine/rollback.test.ts
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import { createDeployment, getDeployment } from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";
import * as sfConnection from "./sfConnection.js";
import * as deployPrimitive from "./deployPrimitive.js";

process.env.ENCRYPTION_KEY = "g".repeat(64);
const config = { sfClientId: "c", sfClientSecret: "s", oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback" } as any;

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

function succeededDeploymentWithSnapshot(db: any, snapshotPath: string, components: any[]) {
  const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
  const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
  const id = createDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components, testLevel: "NoTestRun", validateOnly: false });
  db.prepare(`UPDATE deployments SET status = 'succeeded', snapshot_path = ? WHERE id = ?`).run(snapshotPath, id);
  return { id, targetId: target.id };
}

describe("rollbackDeployment", () => {
  it("redeploys the pre-deploy snapshot for modified components", async () => {
    const db = freshDb();
    const snapshotPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-snap-")), "snapshot.zip");
    fs.writeFileSync(snapshotPath, "snapshot-zip-content");
    const { id } = succeededDeploymentWithSnapshot(db, snapshotPath, [{ type: "ApexClass", fullName: "MyClass", action: "modify" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "MyClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    expect(deploySpy).toHaveBeenCalledWith(expect.anything(), Buffer.from("snapshot-zip-content"), expect.objectContaining({ checkOnly: false }), );
    const rollback = getDeployment(db, rollbackId)!;
    expect(rollback.status).toBe("succeeded");
    expect(rollback.is_rollback_of).toBe(id);
  });

  it("issues a destructive-changes deploy for components that were newly added", async () => {
    const db = freshDb();
    const { id } = succeededDeploymentWithSnapshot(db, "", [{ type: "ApexClass", fullName: "NewClass", action: "add" }]);

    vi.spyOn(sfConnection, "buildOrgConnection").mockResolvedValue({} as any);
    const deploySpy = vi.spyOn(deployPrimitive, "deployZipToOrg").mockResolvedValue({
      success: true,
      componentResults: [{ type: "ApexClass", fullName: "NewClass", success: true }],
    });

    const rollbackId = await rollbackDeployment(db, config, id);

    const [, zipArg] = deploySpy.mock.calls[0];
    expect(zipArg.toString()).toContain("destructiveChanges");
    expect(getDeployment(db, rollbackId)!.status).toBe("succeeded");
  });

  it("throws if the original deployment did not succeed", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r" });
    const id = createDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id, components: [], testLevel: "NoTestRun", validateOnly: false });

    await expect(rollbackDeployment(db, config, id)).rejects.toThrow(/did not succeed/);
  });
});
```

> **Note for implementer:** the destructive-changes zip is asserted by checking the zip buffer's raw bytes contain the string `"destructiveChanges"` — since `AdmZip` stores entry names in the central directory, this is a simple and reliable way to confirm the entry exists without a full unzip in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./rollback.js` module not found.

- [ ] **Step 3: Implement `server/src/engine/rollback.ts`**

```typescript
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import AdmZip from "adm-zip";
import type Database from "better-sqlite3";
import { buildOrgConnection } from "./sfConnection.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import { getDeployment, type DeployComponentSelection } from "./deploy.js";
import type { Config } from "../config.js";

function buildDestructiveChangesZip(components: DeployComponentSelection[]): Buffer {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.fullName);
  }
  const typesXml = Array.from(byType.entries())
    .map(
      ([name, members]) =>
        `  <types>\n${members.map((m) => `    <members>${m}</members>`).join("\n")}\n    <name>${name}</name>\n  </types>`
    )
    .join("\n");

  const destructiveChangesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n</Package>\n`;
  const emptyPackageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>61.0</version>\n</Package>\n`;

  const zip = new AdmZip();
  zip.addFile("destructiveChanges.xml", Buffer.from(destructiveChangesXml));
  zip.addFile("package.xml", Buffer.from(emptyPackageXml));
  return zip.toBuffer();
}

function applyDeployResultToItems(
  db: Database.Database,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): void {
  for (const cr of componentResults) {
    db.prepare(
      `UPDATE deployment_items SET status = ?, error_message = ? WHERE deployment_id = ? AND metadata_type = ? AND api_name = ?`
    ).run(cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName);
  }
}

export async function rollbackDeployment(db: Database.Database, config: Config, deploymentId: string): Promise<string> {
  const original = getDeployment(db, deploymentId);
  if (!original) throw new Error(`No deployment with id ${deploymentId}`);
  if (original.status !== "succeeded") {
    throw new Error(`Cannot roll back a deployment that did not succeed (status: ${original.status})`);
  }

  const components: DeployComponentSelection[] = original.components;
  const existingComponents = components.filter((c) => c.action !== "add");
  const addedComponents = components.filter((c) => c.action === "add");

  const rollbackId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, is_rollback_of)
     VALUES (?, ?, ?, ?, ?, 'deploying', 0, ?, ?)`
  ).run(rollbackId, original.target_connection_id, original.target_connection_id, JSON.stringify(components), original.test_level, now, deploymentId);

  for (const c of components) {
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(randomUUID(), rollbackId, c.type, c.fullName, c.action === "add" ? "delete" : c.action);
  }

  try {
    const targetConn = await buildOrgConnection(db, original.target_connection_id, config);

    if (existingComponents.length > 0) {
      if (!original.snapshot_path || !fs.existsSync(original.snapshot_path)) {
        throw new Error("No snapshot available to roll back to");
      }
      const snapshotZip = fs.readFileSync(original.snapshot_path);
      const result = await deployZipToOrg(targetConn, snapshotZip, { testLevel: original.test_level, checkOnly: false });
      applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deploy of prior versions failed");
    }

    if (addedComponents.length > 0) {
      const destructiveZip = buildDestructiveChangesZip(addedComponents);
      const result = await deployZipToOrg(targetConn, destructiveZip, { testLevel: original.test_level, checkOnly: false });
      applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deletion of newly added components failed");
    }

    db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), rollbackId);
  } catch (err) {
    db.prepare(`UPDATE deployments SET status = 'failed', finished_at = ?, error_detail = ? WHERE id = ?`).run(
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      rollbackId
    );
    throw err;
  }

  return rollbackId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Add the rollback route to `server/src/engine/routes.ts`**

Add this import:

```typescript
import { rollbackDeployment } from "./rollback.js";
```

Add this route inside `createEngineRouter`, before the final `return router;`:

```typescript
  router.post("/api/deployments/:id/rollback", async (req, res) => {
    try {
      const rollbackId = await rollbackDeployment(db, config, req.params.id);
      res.status(202).json({ id: rollbackId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 6: Add the failing route test to `server/src/engine/routes.test.ts`**

```typescript
// append to server/src/engine/routes.test.ts
import * as rollback from "./rollback.js";

describe("rollback route", () => {
  it("triggers a rollback and returns the new deployment id", async () => {
    const { app } = buildApp();
    vi.spyOn(rollback, "rollbackDeployment").mockResolvedValue("rollback-id-123");

    const res = await request(app).post("/api/deployments/some-id/rollback");
    expect(res.status).toBe(202);
    expect(res.body.id).toBe("rollback-id-123");
  });

  it("returns 400 when rollback is not possible", async () => {
    const { app } = buildApp();
    vi.spyOn(rollback, "rollbackDeployment").mockRejectedValue(new Error("did not succeed"));

    const res = await request(app).post("/api/deployments/some-id/rollback");
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/src/engine/rollback.ts server/src/engine/rollback.test.ts server/src/engine/routes.ts server/src/engine/routes.test.ts
git commit -m "feat: add deployment rollback engine and route"
```

### Task 14: Pipelines CRUD + `/api/pipelines` routes

**Files:**
- Create: `server/src/pipelines/pipelines.ts`
- Create: `server/src/pipelines/routes.ts`
- Test: `server/src/pipelines/pipelines.test.ts`
- Test: `server/src/pipelines/routes.test.ts`

**Interfaces:**
- Consumes: `openDb`/`runMigrations` (Task 2).
- Produces: `Pipeline { id: string; name: string; connectionIds: string[] }` and `createPipeline`, `listPipelines`, `updatePipeline`, `deletePipeline` from `pipelines.ts`; `createPipelinesRouter(db): Router` from `routes.ts` — mounted in `app.ts` in Task 16. No other task depends on this one.

- [ ] **Step 1: Write the failing test for pipeline storage**

```typescript
// server/src/pipelines/pipelines.test.ts
import { describe, it, expect } from "vitest";
import { openDb, runMigrations } from "../db/client.js";
import { createPipeline, listPipelines, updatePipeline, deletePipeline } from "./pipelines.js";

function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("pipelines", () => {
  it("creates and lists a pipeline", () => {
    const db = freshDb();
    createPipeline(db, { name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"] });
    const list = listPipelines(db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"] });
  });

  it("updates a pipeline's name and connection order", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Original", connectionIds: ["conn1", "conn2"] });
    updatePipeline(db, created.id, { name: "Renamed", connectionIds: ["conn2", "conn1"] });
    const list = listPipelines(db);
    expect(list[0]).toMatchObject({ name: "Renamed", connectionIds: ["conn2", "conn1"] });
  });

  it("deletes a pipeline", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "ToDelete", connectionIds: [] });
    deletePipeline(db, created.id);
    expect(listPipelines(db)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./pipelines.js` module not found.

- [ ] **Step 3: Implement `server/src/pipelines/pipelines.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
}

export function createPipeline(db: Database.Database, input: { name: string; connectionIds: string[] }): Pipeline {
  const id = randomUUID();
  db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES (?, ?, ?)`).run(id, input.name, JSON.stringify(input.connectionIds));
  return { id, name: input.name, connectionIds: input.connectionIds };
}

export function listPipelines(db: Database.Database): Pipeline[] {
  return db
    .prepare(`SELECT id, name, connection_ids FROM pipelines`)
    .all()
    .map((row: any) => ({ id: row.id, name: row.name, connectionIds: JSON.parse(row.connection_ids) }));
}

export function updatePipeline(db: Database.Database, id: string, input: { name: string; connectionIds: string[] }): void {
  db.prepare(`UPDATE pipelines SET name = ?, connection_ids = ? WHERE id = ?`).run(input.name, JSON.stringify(input.connectionIds), id);
}

export function deletePipeline(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing test for pipeline routes**

```typescript
// server/src/pipelines/routes.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createPipelinesRouter } from "./routes.js";

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createPipelinesRouter(db));
  return { app, db };
}

describe("pipelines routes", () => {
  it("creates a pipeline via POST and lists it via GET", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
    expect(created.status).toBe(201);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe("Main");
  });

  it("updates a pipeline via PUT", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a"] });
    const res = await request(app).put(`/api/pipelines/${created.body.id}`).send({ name: "Renamed", connectionIds: ["a", "b"] });
    expect(res.status).toBe(200);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body[0].name).toBe("Renamed");
  });

  it("deletes a pipeline via DELETE", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: [] });
    const res = await request(app).delete(`/api/pipelines/${created.body.id}`);
    expect(res.status).toBe(204);

    const listed = await request(app).get("/api/pipelines");
    expect(listed.body).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./routes.js` module not found (in `server/src/pipelines/`).

- [ ] **Step 7: Implement `server/src/pipelines/routes.ts`**

```typescript
import { Router } from "express";
import type Database from "better-sqlite3";
import { createPipeline, listPipelines, updatePipeline, deletePipeline } from "./pipelines.js";

export function createPipelinesRouter(db: Database.Database): Router {
  const router = Router();

  router.post("/api/pipelines", (req, res) => {
    const { name, connectionIds } = req.body as { name: string; connectionIds: string[] };
    const pipeline = createPipeline(db, { name, connectionIds });
    res.status(201).json(pipeline);
  });

  router.get("/api/pipelines", (_req, res) => {
    res.json(listPipelines(db));
  });

  router.put("/api/pipelines/:id", (req, res) => {
    const { name, connectionIds } = req.body as { name: string; connectionIds: string[] };
    updatePipeline(db, req.params.id, { name, connectionIds });
    res.status(200).json({ id: req.params.id, name, connectionIds });
  });

  router.delete("/api/pipelines/:id", (req, res) => {
    deletePipeline(db, req.params.id);
    res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add server/src/pipelines/pipelines.ts server/src/pipelines/pipelines.test.ts server/src/pipelines/routes.ts server/src/pipelines/routes.test.ts
git commit -m "feat: add pipelines CRUD and routes"
```

### Task 15: Connections listing/delete + git connection creation routes

**Files:**
- Create: `server/src/connections/routes.ts`
- Test: `server/src/connections/routes.test.ts`

**Interfaces:**
- Consumes: `listConnections`, `deleteConnection` (Task 5), `createGitConnection` (Task 6).
- Produces: `createConnectionsRouter(db): Router` from `server/src/connections/routes.ts`, exposing `GET /api/connections`, `POST /api/connections/git`, `DELETE /api/connections/:id` — mounted in `app.ts` in Task 16, alongside the OAuth router from Task 5 which handles org connection creation (`/api/connections/org/start` + `/oauth/callback`).

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/connections/routes.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { openDb, runMigrations } from "../db/client.js";
import { createOrgConnection } from "./orgConnections.js";
import { createConnectionsRouter } from "./routes.js";

process.env.ENCRYPTION_KEY = "h".repeat(64);

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createConnectionsRouter(db));
  return { app, db };
}

describe("connections routes", () => {
  it("lists connections", async () => {
    const { app, db } = buildApp();
    createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].nickname).toBe("Dev");
  });

  it("creates a git connection via POST", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/connections/git")
      .send({ nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "ghp_abc" });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("git");
    expect(res.body).not.toHaveProperty("encryptedAuthToken");
  });

  it("deletes a connection", async () => {
    const { app, db } = buildApp();
    const created = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r" });
    const res = await request(app).delete(`/api/connections/${created.id}`);
    expect(res.status).toBe(204);

    const listed = await request(app).get("/api/connections");
    expect(listed.body).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `./routes.js` module not found (in `server/src/connections/`).

- [ ] **Step 3: Implement `server/src/connections/routes.ts`**

```typescript
import { Router } from "express";
import type Database from "better-sqlite3";
import { listConnections, deleteConnection } from "./orgConnections.js";
import { createGitConnection } from "./gitConnections.js";

export function createConnectionsRouter(db: Database.Database): Router {
  const router = Router();

  router.get("/api/connections", (_req, res) => {
    res.json(listConnections(db));
  });

  router.post("/api/connections/git", (req, res) => {
    const { nickname, remoteUrl, defaultBranch, authToken } = req.body as {
      nickname: string;
      remoteUrl: string;
      defaultBranch: string;
      authToken: string;
    };
    const connection = createGitConnection(db, { nickname, remoteUrl, defaultBranch, authToken });
    res.status(201).json(connection);
  });

  router.delete("/api/connections/:id", (req, res) => {
    deleteConnection(db, req.params.id);
    res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/connections/routes.ts server/src/connections/routes.test.ts
git commit -m "feat: add connections listing, git creation, and delete routes"
```

### Task 16: Wire all routers into `app.ts`, finalize `index.ts` startup

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `createAuthRouter` (Task 5), `createConnectionsRouter` (Task 15), `createEngineRouter` (Task 10/12/13), `createPipelinesRouter` (Task 14), `openDb`/`runMigrations` (Task 2), `loadConfig` (Task 4).
- Produces: `createApp(db, config, dataDir): express.Express` (signature change from Task 1 — every route is now mounted) — this is the final shape frontend integration (Task 17) and Docker (Task 21) build against.

- [ ] **Step 1: Update the failing health-check test for the new `createApp` signature**

```typescript
// server/src/app.test.ts (replace entire file)
import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";
import type { Config } from "./config.js";

process.env.ENCRYPTION_KEY = "i".repeat(64);

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: process.env.ENCRYPTION_KEY,
  sfClientId: "client123",
  sfClientSecret: "secret456",
  oauthCallbackUrl: "https://deploy.effluence.com.au/oauth/callback",
};

describe("createApp", () => {
  it("responds to GET /api/health with status ok", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test");

    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("mounts the connections router", async () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test");

    const res = await request(app).get("/api/connections");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `createApp` called with 3 arguments but accepts 0.

- [ ] **Step 3: Implement the new `server/src/app.ts`**

```typescript
import express from "express";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";

export function createApp(db: Database.Database, config: Config, dataDir: string): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthRouter(db, config));
  app.use(createConnectionsRouter(db));
  app.use(createEngineRouter(db, config, dataDir));
  app.use(createPipelinesRouter(db));

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Implement the final `server/src/index.ts`**

```typescript
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.dbPath);
runMigrations(db);

const app = createApp(db, config, dataDir);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
```

- [ ] **Step 6: Run the full backend test suite**

Run: `cd server && npm test`
Expected: PASS (all tests from Tasks 1–16)

- [ ] **Step 7: Commit**

```bash
git add server/src/app.ts server/src/app.test.ts server/src/index.ts
git commit -m "feat: wire all routers into the Express app and finalize startup"
```

### Task 17: Frontend scaffold + API client + navigation shell

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/index.html`
- Create: `web/src/main.tsx`, `web/src/App.tsx`
- Create: `web/src/api/client.ts`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: nothing from the backend directly (calls it over HTTP at runtime); mirrors backend response shapes from Tasks 5, 8/10, 12, 14.
- Produces: the `api/client.ts` exports below, consumed by every page task (18–20):
  - `ConnectionSummary`, `fetchConnections()`, `startOrgConnectionUrl(nickname, orgType)`, `createGitConnection(input)`, `deleteConnection(id)`
  - `DiffItem`, `fetchDiff(sourceId, targetId)`
  - `DeployComponentSelection`, `TestLevel`, `createDeployment(input)`, `fetchDeployment(id)`, `fetchDeployments()`, `rollbackDeployment(id)`
  - `Pipeline`, `fetchPipelines()`, `createPipeline(input)`, `updatePipeline(id, input)`, `deletePipeline(id)`
  - `App` component with route shell (nav + `<Outlet/>`), consumed by `main.tsx` and extended with page routes in Tasks 18–20.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "sfcowboy-web",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5",
    "jsdom": "^24.1.1",
    "@testing-library/react": "^16.0.0"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000", "/oauth": "http://localhost:3000" } },
  build: { outDir: "dist" },
});
```

- [ ] **Step 4: Create `web/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "jsdom", globals: true },
});
```

- [ ] **Step 5: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>SFCowboy</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Implement `web/src/api/client.ts`**

```typescript
export interface ConnectionSummary {
  id: string;
  type: "org" | "git";
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  instanceUrl?: string;
  orgType?: "sandbox" | "production";
  remoteUrl?: string;
  defaultBranch?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return res.json();
}

export function fetchConnections(): Promise<ConnectionSummary[]> {
  return fetch("/api/connections").then((r) => json(r));
}

export function startOrgConnectionUrl(nickname: string, orgType: "sandbox" | "production"): string {
  return `/api/connections/org/start?nickname=${encodeURIComponent(nickname)}&orgType=${orgType}`;
}

export function createGitConnection(input: {
  nickname: string;
  remoteUrl: string;
  defaultBranch: string;
  authToken: string;
}): Promise<ConnectionSummary> {
  return fetch("/api/connections/git", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function deleteConnection(id: string): Promise<void> {
  return fetch(`/api/connections/${id}`, { method: "DELETE" }).then(() => undefined);
}

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
}

export function fetchDiff(sourceConnectionId: string, targetConnectionId: string): Promise<DiffItem[]> {
  return fetch(`/api/diff?sourceConnectionId=${sourceConnectionId}&targetConnectionId=${targetConnectionId}`).then((r) => json(r));
}

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

export interface DeploymentDetail {
  id: string;
  source_connection_id: string;
  target_connection_id: string;
  status: string;
  test_level: TestLevel;
  validate_only: number;
  started_at: string;
  finished_at: string | null;
  error_detail: string | null;
  is_rollback_of: string | null;
  components: DeployComponentSelection[];
  items: { metadata_type: string; api_name: string; action: string; status: string; error_message: string | null }[];
}

export function createDeployment(input: {
  sourceConnectionId: string;
  targetConnectionId: string;
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly?: boolean;
}): Promise<{ id: string }> {
  return fetch("/api/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function fetchDeployment(id: string): Promise<DeploymentDetail> {
  return fetch(`/api/deployments/${id}`).then((r) => json(r));
}

export function fetchDeployments(): Promise<DeploymentDetail[]> {
  return fetch("/api/deployments").then((r) => json(r));
}

export function rollbackDeployment(id: string): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/rollback`, { method: "POST" }).then((r) => json(r));
}

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
}

export function fetchPipelines(): Promise<Pipeline[]> {
  return fetch("/api/pipelines").then((r) => json(r));
}

export function createPipeline(input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  return fetch("/api/pipelines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function updatePipeline(id: string, input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  return fetch(`/api/pipelines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function deletePipeline(id: string): Promise<void> {
  return fetch(`/api/pipelines/${id}`, { method: "DELETE" }).then(() => undefined);
}
```

- [ ] **Step 7: Write the failing test for the navigation shell**

```typescript
// web/src/App.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App.js";

describe("App", () => {
  it("renders navigation links for every top-level page", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByRole("link", { name: /connections/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new deployment/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /history/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd web && npm install && npm test`
Expected: FAIL — `./App.js` module not found.

- [ ] **Step 9: Implement `web/src/App.tsx`**

```typescript
import { NavLink, Outlet, Route, Routes } from "react-router-dom";

export function App() {
  return (
    <div>
      <nav>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/pipelines">Pipelines</NavLink>
        <NavLink to="/deploy/new">New Deployment</NavLink>
        <NavLink to="/history">History</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<div>Welcome to SFCowboy</div>} />
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 10: Implement `web/src/main.tsx`**

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
```

- [ ] **Step 11: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add web/package.json web/tsconfig.json web/vite.config.ts web/vitest.config.ts web/index.html web/src/main.tsx web/src/App.tsx web/src/App.test.tsx web/src/api/client.ts
git commit -m "feat: scaffold frontend with navigation shell and API client"
```

### Task 18: Connections page + Pipelines page

**Files:**
- Create: `web/src/pages/Connections.tsx`
- Create: `web/src/pages/Pipelines.tsx`
- Test: `web/src/pages/Connections.test.tsx`
- Test: `web/src/pages/Pipelines.test.tsx`
- Modify: `web/src/App.tsx` (add routes)

**Interfaces:**
- Consumes: `fetchConnections`, `startOrgConnectionUrl`, `createGitConnection`, `deleteConnection`, `fetchPipelines`, `createPipeline`, `deletePipeline`, `ConnectionSummary`, `Pipeline` (Task 17's `api/client.ts`).
- Produces: `<Connections/>` and `<Pipelines/>` route components, wired into `App.tsx`'s `<Routes>`. Task 19 (New Deployment) reuses the same `fetchConnections` call pattern shown here.

- [ ] **Step 1: Write the failing test for the Connections page**

```typescript
// web/src/pages/Connections.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as client from "../api/client.js";
import { Connections } from "./Connections.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev Sandbox", createdAt: "2026-01-01", lastUsedAt: null, orgType: "sandbox", instanceUrl: "https://x" },
  ]);
});

describe("Connections page", () => {
  it("lists existing connections", async () => {
    render(<Connections />);
    expect(await screen.findByText("Dev Sandbox")).toBeInTheDocument();
  });

  it("creates a git connection from the form", async () => {
    vi.mocked(client.createGitConnection).mockResolvedValue({
      id: "2", type: "git", nickname: "Repo", createdAt: "2026-01-01", lastUsedAt: null, remoteUrl: "https://github.com/x/y.git", defaultBranch: "main",
    });
    render(<Connections />);
    await screen.findByText("Dev Sandbox");

    fireEvent.change(screen.getByLabelText(/git nickname/i), { target: { value: "Repo" } });
    fireEvent.change(screen.getByLabelText(/remote url/i), { target: { value: "https://github.com/x/y.git" } });
    fireEvent.change(screen.getByLabelText(/branch/i), { target: { value: "main" } });
    fireEvent.change(screen.getByLabelText(/auth token/i), { target: { value: "ghp_abc" } });
    fireEvent.click(screen.getByRole("button", { name: /add git repo/i }));

    await waitFor(() => expect(client.createGitConnection).toHaveBeenCalledWith({
      nickname: "Repo", remoteUrl: "https://github.com/x/y.git", defaultBranch: "main", authToken: "ghp_abc",
    }));
  });

  it("deletes a connection", async () => {
    vi.mocked(client.deleteConnection).mockResolvedValue(undefined);
    render(<Connections />);
    await screen.findByText("Dev Sandbox");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.deleteConnection).toHaveBeenCalledWith("1"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./Connections.js` module not found.

- [ ] **Step 3: Implement `web/src/pages/Connections.tsx`**

```typescript
import { useEffect, useState } from "react";
import {
  type ConnectionSummary,
  fetchConnections,
  startOrgConnectionUrl,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [gitNickname, setGitNickname] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [authToken, setAuthToken] = useState("");

  function refresh() {
    fetchConnections().then(setConnections);
  }

  useEffect(refresh, []);

  async function handleAddGit(e: React.FormEvent) {
    e.preventDefault();
    await createGitConnection({ nickname: gitNickname, remoteUrl, defaultBranch, authToken });
    setGitNickname("");
    setRemoteUrl("");
    setAuthToken("");
    refresh();
  }

  async function handleDelete(id: string) {
    await deleteConnection(id);
    refresh();
  }

  return (
    <div>
      <h1>Connections</h1>
      <ul>
        {connections.map((c) => (
          <li key={c.id}>
            {c.nickname} ({c.type === "org" ? c.orgType : "git"})
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Connect an Org</h2>
      <label>
        Nickname
        <input value={orgNickname} onChange={(e) => setOrgNickname(e.target.value)} />
      </label>
      <label>
        Org type
        <select value={orgType} onChange={(e) => setOrgType(e.target.value as "sandbox" | "production")}>
          <option value="sandbox">Sandbox</option>
          <option value="production">Production</option>
        </select>
      </label>
      <a href={startOrgConnectionUrl(orgNickname, orgType)}>
        <button disabled={!orgNickname}>Connect</button>
      </a>

      <h2>Add a Git Repo</h2>
      <form onSubmit={handleAddGit}>
        <label>
          Git nickname
          <input value={gitNickname} onChange={(e) => setGitNickname(e.target.value)} />
        </label>
        <label>
          Remote URL
          <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
        </label>
        <label>
          Branch
          <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
        </label>
        <label>
          Auth token
          <input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
        </label>
        <button type="submit">Add git repo</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing test for the Pipelines page**

```typescript
// web/src/pages/Pipelines.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as client from "../api/client.js";
import { Pipelines } from "./Pipelines.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelines).mockResolvedValue([{ id: "p1", name: "Main", connectionIds: ["1", "2"] }]);
});

describe("Pipelines page", () => {
  it("lists existing pipelines with resolved connection nicknames", async () => {
    render(<Pipelines />);
    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(await screen.findByText(/Dev → QA/)).toBeInTheDocument();
  });

  it("creates a pipeline from selected connections in order", async () => {
    vi.mocked(client.createPipeline).mockResolvedValue({ id: "p2", name: "Second", connectionIds: ["2", "1"] });
    render(<Pipelines />);
    await screen.findByText("Main");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    await waitFor(() =>
      expect(client.createPipeline).toHaveBeenCalledWith({ name: "Second", connectionIds: ["2", "1"] })
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./Pipelines.js` module not found.

- [ ] **Step 7: Implement `web/src/pages/Pipelines.tsx`**

```typescript
import { useEffect, useState } from "react";
import { type ConnectionSummary, type Pipeline, fetchConnections, fetchPipelines, createPipeline, deletePipeline } from "../api/client.js";

export function Pipelines() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [name, setName] = useState("");
  const [orderedSelection, setOrderedSelection] = useState<string[]>([]);

  function refresh() {
    fetchConnections().then(setConnections);
    fetchPipelines().then(setPipelines);
  }

  useEffect(refresh, []);

  function nicknameFor(id: string): string {
    return connections.find((c) => c.id === id)?.nickname ?? id;
  }

  function toggleConnection(id: string) {
    setOrderedSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    await createPipeline({ name, connectionIds: orderedSelection });
    setName("");
    setOrderedSelection([]);
    refresh();
  }

  async function handleDelete(id: string) {
    await deletePipeline(id);
    refresh();
  }

  return (
    <div>
      <h1>Pipelines</h1>
      <ul>
        {pipelines.map((p) => (
          <li key={p.id}>
            {p.name}: {p.connectionIds.map(nicknameFor).join(" → ")}
            <button onClick={() => handleDelete(p.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Create Pipeline</h2>
      <form onSubmit={handleCreate}>
        <label>
          Pipeline name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p>Select connections in the order they should appear (click order = pipeline order):</p>
        {connections.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={orderedSelection.includes(c.id)} onChange={() => toggleConnection(c.id)} />
            {c.nickname}
          </label>
        ))}
        <button type="submit">Create pipeline</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 9: Add both pages as routes in `web/src/App.tsx`**

```typescript
import { NavLink, Route, Routes } from "react-router-dom";
import { Connections } from "./pages/Connections.js";
import { Pipelines } from "./pages/Pipelines.js";

export function App() {
  return (
    <div>
      <nav>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/pipelines">Pipelines</NavLink>
        <NavLink to="/deploy/new">New Deployment</NavLink>
        <NavLink to="/history">History</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<div>Welcome to SFCowboy</div>} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/pipelines" element={<Pipelines />} />
        </Routes>
      </main>
    </div>
  );
}
```

- [ ] **Step 10: Run the full frontend test suite**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add web/src/pages/Connections.tsx web/src/pages/Connections.test.tsx web/src/pages/Pipelines.tsx web/src/pages/Pipelines.test.tsx web/src/App.tsx
git commit -m "feat: add Connections and Pipelines pages"
```

### Task 19: `DiffTree` component + New Deployment page

**Files:**
- Create: `web/src/components/DiffTree.tsx`
- Create: `web/src/pages/NewDeployment.tsx`
- Test: `web/src/components/DiffTree.test.tsx`
- Test: `web/src/pages/NewDeployment.test.tsx`
- Modify: `web/src/App.tsx` (add `/deploy/new` route)

**Interfaces:**
- Consumes: `DiffItem`, `TestLevel`, `DeployComponentSelection`, `ConnectionSummary`, `fetchConnections`, `fetchDiff`, `createDeployment` (Task 17).
- Produces: `diffItemKey(item)`, `<DiffTree/>` from `components/DiffTree.tsx` — reused as-is by Task 20 if a diff preview is ever added there (not required, but kept generic for that reason). `<NewDeployment/>` route component wired into `App.tsx`.

- [ ] **Step 1: Write the failing test for `DiffTree`**

```typescript
// web/src/components/DiffTree.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiffTree, diffItemKey } from "./DiffTree.js";

describe("DiffTree", () => {
  it("groups components by metadata type and shows their status", () => {
    render(
      <DiffTree
        items={[
          { type: "ApexClass", fullName: "MyClass", status: "modified" },
          { type: "CustomObject", fullName: "Account", status: "added" },
        ]}
        selected={new Set([diffItemKey({ type: "ApexClass", fullName: "MyClass" })])}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("ApexClass")).toBeInTheDocument();
    expect(screen.getByText(/MyClass \(modified\)/)).toBeInTheDocument();
    expect(screen.getByText(/Account \(added\)/)).toBeInTheDocument();
  });

  it("calls onToggle with the item's key when its checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(
      <DiffTree
        items={[{ type: "ApexClass", fullName: "MyClass", status: "modified" }]}
        selected={new Set()}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByLabelText(/MyClass/));
    expect(onToggle).toHaveBeenCalledWith("ApexClass::MyClass");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./DiffTree.js` module not found.

- [ ] **Step 3: Implement `web/src/components/DiffTree.tsx`**

```typescript
import type { DiffItem } from "../api/client.js";

export function diffItemKey(item: { type: string; fullName: string }): string {
  return `${item.type}::${item.fullName}`;
}

export interface DiffTreeProps {
  items: DiffItem[];
  selected: Set<string>;
  onToggle: (key: string) => void;
}

export function DiffTree({ items, selected, onToggle }: DiffTreeProps) {
  const byType = new Map<string, DiffItem[]>();
  for (const item of items) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type)!.push(item);
  }

  return (
    <div>
      {Array.from(byType.entries()).map(([type, typeItems]) => (
        <fieldset key={type}>
          <legend>{type}</legend>
          {typeItems.map((item) => {
            const key = diffItemKey(item);
            return (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => onToggle(key)}
                  disabled={item.status === "unchanged"}
                />
                {item.fullName} ({item.status})
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing test for the New Deployment page**

```typescript
// web/src/pages/NewDeployment.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { NewDeployment } from "./NewDeployment.js";

vi.mock("../api/client.js");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "src1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "tgt1", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
});

describe("NewDeployment page", () => {
  it("loads a diff and pre-selects added/modified components", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([
      { type: "ApexClass", fullName: "New", status: "added" },
      { type: "ApexClass", fullName: "Removed", status: "removed" },
    ]);
    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));

    await screen.findByText(/New \(added\)/);
    const addedCheckbox = screen.getByLabelText(/New \(added\)/) as HTMLInputElement;
    const removedCheckbox = screen.getByLabelText(/Removed \(removed\)/) as HTMLInputElement;
    expect(addedCheckbox.checked).toBe(true);
    expect(removedCheckbox.checked).toBe(false);
  });

  it("creates a deployment with the selected components and navigates to its detail page", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "New", status: "added" }]);
    vi.mocked(client.createDeployment).mockResolvedValue({ id: "deploy-1" });

    render(
      <MemoryRouter>
        <NewDeployment />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByLabelText(/^source/i), { target: { value: "src1" } });
    fireEvent.change(screen.getByLabelText(/^target/i), { target: { value: "tgt1" } });
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText(/New \(added\)/);

    fireEvent.click(screen.getByRole("button", { name: /^deploy$/i }));

    await waitFor(() =>
      expect(client.createDeployment).toHaveBeenCalledWith({
        sourceConnectionId: "src1",
        targetConnectionId: "tgt1",
        components: [{ type: "ApexClass", fullName: "New", action: "add" }],
        testLevel: "NoTestRun",
        validateOnly: false,
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith("/deployments/deploy-1");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./NewDeployment.js` module not found.

- [ ] **Step 7: Implement `web/src/pages/NewDeployment.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type ConnectionSummary,
  type DiffItem,
  type TestLevel,
  type DeployComponentSelection,
  fetchConnections,
  fetchDiff,
  createDeployment,
} from "../api/client.js";
import { DiffTree, diffItemKey } from "../components/DiffTree.js";

function actionForStatus(status: DiffItem["status"]): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

export function NewDeployment() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testLevel, setTestLevel] = useState<TestLevel>("NoTestRun");
  const [validateOnly, setValidateOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  async function handleLoadDiff() {
    setError(null);
    try {
      const items = await fetchDiff(sourceId, targetId);
      setDiffItems(items);
      setSelected(new Set(items.filter((i) => i.status === "added" || i.status === "modified").map(diffItemKey)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleDeploy() {
    setError(null);
    const components: DeployComponentSelection[] = diffItems
      .filter((item) => selected.has(diffItemKey(item)))
      .map((item) => ({ type: item.type, fullName: item.fullName, action: actionForStatus(item.status) }));

    try {
      const { id } = await createDeployment({
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        components,
        testLevel,
        validateOnly,
      });
      navigate(`/deployments/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>New Deployment</h1>
      {error && <p role="alert">{error}</p>}

      <label>
        Source
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">Select source</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">Select target</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
      </label>
      <button onClick={handleLoadDiff} disabled={!sourceId || !targetId}>
        Load Diff
      </button>

      {diffItems.length > 0 && (
        <>
          <DiffTree items={diffItems} selected={selected} onToggle={toggle} />

          <label>
            Test level
            <select value={testLevel} onChange={(e) => setTestLevel(e.target.value as TestLevel)}>
              <option value="NoTestRun">No Test Run</option>
              <option value="RunSpecifiedTests">Run Specified Tests</option>
              <option value="RunLocalTests">Run Local Tests</option>
              <option value="RunAllTestsInOrg">Run All Tests In Org</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={validateOnly} onChange={(e) => setValidateOnly(e.target.checked)} />
            Validate only (dry run)
          </label>

          <button onClick={handleDeploy} disabled={selected.size === 0}>
            {validateOnly ? "Validate" : "Deploy"}
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 9: Add the route in `web/src/App.tsx`**

Add the import `import { NewDeployment } from "./pages/NewDeployment.js";` and the route `<Route path="/deploy/new" element={<NewDeployment />} />` inside the existing `<Routes>` block.

- [ ] **Step 10: Run the full frontend test suite**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add web/src/components/DiffTree.tsx web/src/components/DiffTree.test.tsx web/src/pages/NewDeployment.tsx web/src/pages/NewDeployment.test.tsx web/src/App.tsx
git commit -m "feat: add diff tree component and New Deployment page"
```

### Task 20: Deployment detail/progress page (with rollback) + History page

**Files:**
- Create: `web/src/pages/DeploymentDetail.tsx`
- Create: `web/src/pages/History.tsx`
- Test: `web/src/pages/DeploymentDetail.test.tsx`
- Test: `web/src/pages/History.test.tsx`
- Modify: `web/src/App.tsx` (add `/deployments/:id` and `/history` routes)

**Interfaces:**
- Consumes: `DeploymentDetail`, `fetchDeployment`, `fetchDeployments`, `rollbackDeployment` (Task 17).
- Produces: `<DeploymentDetailPage/>` and `<History/>` route components wired into `App.tsx`. No later task depends on these.

- [ ] **Step 1: Write the failing test for the deployment detail page**

```typescript
// web/src/pages/DeploymentDetail.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { DeploymentDetailPage } from "./DeploymentDetail.js";

vi.mock("../api/client.js");

function baseDeployment(overrides: Partial<client.DeploymentDetail> = {}): client.DeploymentDetail {
  return {
    id: "d1",
    source_connection_id: "s",
    target_connection_id: "t",
    status: "succeeded",
    test_level: "NoTestRun",
    validate_only: 0,
    started_at: "2026-01-01T00:00:00.000Z",
    finished_at: "2026-01-01T00:01:00.000Z",
    error_detail: null,
    is_rollback_of: null,
    components: [],
    items: [],
    ...overrides,
  };
}

describe("DeploymentDetailPage", () => {
  it("shows the current status and per-component results", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(
      baseDeployment({ items: [{ metadata_type: "ApexClass", api_name: "MyClass", action: "modify", status: "succeeded", error_message: null }] })
    );
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/Status: succeeded/)).toBeInTheDocument();
    expect(screen.getByText(/MyClass — succeeded/)).toBeInTheDocument();
  });

  it("shows a Roll back button only when the deployment succeeded", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment({ status: "failed" }));
    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText(/Status: failed/);
    expect(screen.queryByRole("button", { name: /roll back/i })).not.toBeInTheDocument();
  });

  it("triggers a rollback and navigates to the resulting deployment", async () => {
    vi.mocked(client.fetchDeployment).mockResolvedValue(baseDeployment());
    vi.mocked(client.rollbackDeployment).mockResolvedValue({ id: "d2" });

    render(
      <MemoryRouter initialEntries={["/deployments/d1"]}>
        <Routes>
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/deployments/d2" element={<div>Rollback started</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /roll back/i }));
    expect(await screen.findByText("Rollback started")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./DeploymentDetail.js` module not found.

- [ ] **Step 3: Implement `web/src/pages/DeploymentDetail.tsx`**

```typescript
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type DeploymentDetail, fetchDeployment, rollbackDeployment } from "../api/client.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back"]);

export function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const detail = await fetchDeployment(id!);
        if (cancelled) return;
        setDeployment(detail);
        if (!TERMINAL_STATUSES.has(detail.status)) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function handleRollback() {
    if (!id) return;
    try {
      const { id: rollbackId } = await rollbackDeployment(id);
      navigate(`/deployments/${rollbackId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error) return <p role="alert">{error}</p>;
  if (!deployment) return <p>Loading…</p>;

  return (
    <div>
      <h1>Deployment {deployment.id}</h1>
      <p>Status: {deployment.status}</p>
      <p>Test level: {deployment.test_level}</p>
      {deployment.validate_only ? <p>Validation only (dry run)</p> : null}
      {deployment.error_detail && <pre>{deployment.error_detail}</pre>}
      <ul>
        {deployment.items.map((item) => (
          <li key={`${item.metadata_type}::${item.api_name}`}>
            {item.metadata_type} {item.api_name} — {item.status}
            {item.error_message ? `: ${item.error_message}` : ""}
          </li>
        ))}
      </ul>
      {deployment.status === "succeeded" && <button onClick={handleRollback}>Roll back</button>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing test for the History page**

```typescript
// web/src/pages/History.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { History } from "./History.js";

vi.mock("../api/client.js");

describe("History page", () => {
  it("lists past deployments with a link to each detail page", async () => {
    vi.mocked(client.fetchDeployments).mockResolvedValue([
      {
        id: "d1", source_connection_id: "s", target_connection_id: "t", status: "succeeded",
        test_level: "NoTestRun", validate_only: 0, started_at: "2026-01-01T00:00:00.000Z", finished_at: "2026-01-01T00:01:00.000Z",
        error_detail: null, is_rollback_of: null, components: [], items: [],
      },
    ]);
    render(
      <MemoryRouter>
        <History />
      </MemoryRouter>
    );

    const link = await screen.findByRole("link", { name: /succeeded/i });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npm test`
Expected: FAIL — `./History.js` module not found.

- [ ] **Step 7: Implement `web/src/pages/History.tsx`**

```typescript
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type DeploymentDetail, fetchDeployments } from "../api/client.js";

export function History() {
  const [deployments, setDeployments] = useState<DeploymentDetail[]>([]);

  useEffect(() => {
    fetchDeployments().then(setDeployments);
  }, []);

  return (
    <div>
      <h1>History</h1>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Test level</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.id}>
              <td>{d.started_at}</td>
              <td>
                <Link to={`/deployments/${d.id}`}>{d.status}</Link>
              </td>
              <td>{d.test_level}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd web && npm test`
Expected: PASS

- [ ] **Step 9: Add both routes in `web/src/App.tsx`**

Add the imports `import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";` and `import { History } from "./pages/History.js";`, and add these routes inside `<Routes>`:

```typescript
<Route path="/deployments/:id" element={<DeploymentDetailPage />} />
<Route path="/history" element={<History />} />
```

- [ ] **Step 10: Run the full frontend test suite**

Run: `cd web && npm test`
Expected: PASS (all tests from Tasks 17–20)

- [ ] **Step 11: Commit**

```bash
git add web/src/pages/DeploymentDetail.tsx web/src/pages/DeploymentDetail.test.tsx web/src/pages/History.tsx web/src/pages/History.test.tsx web/src/App.tsx
git commit -m "feat: add deployment detail/rollback page and history page"
```

### Task 21: Serve the built frontend from Express + Dockerfile

**Files:**
- Modify: `server/src/app.ts` (accept optional `webDistDir`, serve static files + SPA fallback)
- Modify: `server/src/app.test.ts` (test static serving)
- Modify: `server/src/index.ts` (pass `WEB_DIST_DIR` env var through)
- Create: `Dockerfile` (repo root)
- Create: `.dockerignore` (repo root)

**Interfaces:**
- Consumes: `createApp` (Task 16).
- Produces: `createApp(db, config, dataDir, webDistDir?)` — the final signature; Task 22's `fly.toml` and CI workflow build this Docker image. No other task depends on this beyond deployment config.

- [ ] **Step 1: Write the failing test for static serving**

```typescript
// server/src/app.test.ts (add to the existing file from Task 16)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("createApp static frontend serving", () => {
  it("serves index.html for a non-API route when webDistDir is provided", async () => {
    const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-webdist-"));
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test", webDistDir);

    const res = await request(app).get("/connections");
    expect(res.status).toBe(200);
    expect(res.text).toContain("SFCowboy");
  });

  it("does not intercept unmatched /api routes with the SPA fallback", async () => {
    const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-webdist-"));
    fs.writeFileSync(path.join(webDistDir, "index.html"), "<html><body>SFCowboy</body></html>");

    const db = openDb(":memory:");
    runMigrations(db);
    const app = createApp(db, config, "/tmp/sfcowboy-data-test", webDistDir);

    const res = await request(app).get("/api/does-not-exist");
    expect(res.text).not.toContain("SFCowboy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm test`
Expected: FAIL — `createApp` called with 4 arguments but accepts 3.

- [ ] **Step 3: Update `server/src/app.ts`**

```typescript
import path from "node:path";
import express from "express";
import type Database from "better-sqlite3";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";

export function createApp(db: Database.Database, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthRouter(db, config));
  app.use(createConnectionsRouter(db));
  app.use(createEngineRouter(db, config, dataDir));
  app.use(createPipelinesRouter(db));

  if (webDistDir) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/api|\/oauth).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm test`
Expected: PASS

- [ ] **Step 5: Update `server/src/index.ts` to pass `WEB_DIST_DIR`**

```typescript
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.dbPath);
runMigrations(db);

const app = createApp(db, config, dataDir, process.env.WEB_DIST_DIR);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
```

- [ ] **Step 6: Create `Dockerfile` at the repo root**

```dockerfile
FROM node:24-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:24-bookworm-slim AS server-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm install
COPY server/ ./
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server-build /app/server/node_modules ./node_modules
COPY --from=server-build /app/server/dist ./dist
COPY --from=server-build /app/server/package.json ./package.json
COPY --from=web-build /app/web/dist ./web-dist

ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web-dist
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

- [ ] **Step 7: Create `.dockerignore` at the repo root**

```
node_modules
server/node_modules
web/node_modules
server/dist
web/dist
*.db
data
.git
```

- [ ] **Step 8: Commit**

```bash
git add server/src/app.ts server/src/app.test.ts server/src/index.ts Dockerfile .dockerignore
git commit -m "feat: serve built frontend from Express and add Dockerfile"
```

### Task 22: Fly.io config + GitHub Actions CI/CD

**Files:**
- Create: `fly.toml` (repo root)
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the `Dockerfile` (Task 21).
- Produces: nothing consumed by later tasks — this is the last piece needed for `deploy.effluence.com.au` to go live per the spec's hosting section (§11).

This task has no automated test cycle (it's infrastructure config, not application code); each step below is verified by running the actual command against the real Fly.io/GitHub Actions services once the account exists.

- [ ] **Step 1: Create `fly.toml` at the repo root**

```toml
app = "sfcowboy"
primary_region = "syd"

[build]

[env]
  PORT = "3000"
  DATA_DIR = "/data"

[[mounts]]
  source = "sfcowboy_data"
  destination = "/data"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

> `primary_region = "syd"` (Sydney) is chosen since the target domain is `.com.au` — change it if you'd rather host closer to a different user base.

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: cd server && npm install && npm test
      - run: cd web && npm install && npm test

  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

- [ ] **Step 3: One-time manual setup (run locally, not part of the automated test suite)**

```bash
# install flyctl, then from the repo root:
fly auth login
fly launch --no-deploy --copy-config
fly volumes create sfcowboy_data --region syd --size 1
fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
fly secrets set SF_CLIENT_ID=<connected app consumer key>
fly secrets set SF_CLIENT_SECRET=<connected app consumer secret>
fly certs add deploy.effluence.com.au
```

`fly certs add` prints the DNS record (CNAME or A/AAAA) to create at Crazy Domains for `deploy.effluence.com.au` — add it there, then `fly certs check deploy.effluence.com.au` to confirm issuance.

- [ ] **Step 4: Add the `FLY_API_TOKEN` GitHub Actions secret**

```bash
fly tokens create deploy
```

Add the output as a repository secret named `FLY_API_TOKEN` at `https://github.com/phillipdta-boop/SFCowboy/settings/secrets/actions`.

- [ ] **Step 5: Commit**

```bash
git add fly.toml .github/workflows/ci.yml
git commit -m "chore: add Fly.io config and GitHub Actions CI/CD workflow"
```

### Task 23: README with local dev and production setup instructions

**Files:**
- Create: `README.md` (repo root)

**Interfaces:**
- Consumes: nothing — this is documentation only, written after every other task so it can describe the actual final commands/env vars.

This task has no automated test cycle. Verification is manual: follow the README's local dev steps and confirm `npm run dev` in both `server/` and `web/` actually starts the app and the health check responds.

- [ ] **Step 1: Create `README.md`**

```markdown
# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

## Local development

Requires Node.js 22+ and `git` on your PATH.

```bash
cd server && npm install
cd ../web && npm install
```

Create `server/.env` (not committed) with:

```
ENCRYPTION_KEY=<32-byte hex string, e.g. output of `openssl rand -hex 32`>
SF_CLIENT_ID=<Salesforce Connected App consumer key>
SF_CLIENT_SECRET=<Salesforce Connected App consumer secret>
OAUTH_CALLBACK_URL=http://localhost:3000/oauth/callback
DB_PATH=./sfcowboy.db
DATA_DIR=./data
PORT=3000
```

Run the backend and frontend in separate terminals:

```bash
cd server && npm run dev
cd web && npm run dev
```

The frontend dev server (Vite) proxies `/api` and `/oauth` to `localhost:3000`
(see `web/vite.config.ts`), so open the Vite URL it prints (typically
`http://localhost:5173`) during development.

Run tests:

```bash
cd server && npm test
cd web && npm test
```

## One-time production setup

1. **Salesforce Connected App** — in Setup of at least one org (production,
   if you want sandboxes refreshed afterward to inherit it):
   - Setup → App Manager → New Connected App
   - Enable OAuth Settings
   - Callback URL: `https://deploy.effluence.com.au/oauth/callback`
   - Selected OAuth Scopes: `Manage user data via APIs (api)`,
     `Perform requests at any time (refresh_token, offline_access)`
   - Save, then note the Consumer Key and Consumer Secret (Manage Consumer
     Details) — these become `SF_CLIENT_ID` / `SF_CLIENT_SECRET`.

2. **Fly.io app** — see `.github/workflows/ci.yml` and `fly.toml` for the
   deploy shape. One-time commands:

   ```bash
   fly auth login
   fly launch --no-deploy --copy-config
   fly volumes create sfcowboy_data --region syd --size 1
   fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
   fly secrets set SF_CLIENT_ID=<consumer key>
   fly secrets set SF_CLIENT_SECRET=<consumer secret>
   fly certs add deploy.effluence.com.au
   ```

3. **DNS at Crazy Domains** — add the record `fly certs add` printed for
   `deploy.effluence.com.au`. This does not touch the root `effluence.com.au`
   domain or its existing GitHub Pages site.

4. **GitHub Actions secret** — `fly tokens create deploy`, then add the
   output as the `FLY_API_TOKEN` secret on this repo
   (Settings → Secrets and variables → Actions). Once set, every push to
   `main` that passes tests deploys automatically.

5. **Git-repo connections** (optional, only if you plan to use a git repo as
   a deployment source/target) — generate a fine-grained GitHub personal
   access token with read/write access to the target repo, and enter it when
   adding the git connection in the app's Connections page. It's encrypted
   at rest the same way org refresh tokens are.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add local dev and production setup instructions"
```

---

## Plan Self-Review

**Spec coverage:** Every section of the design spec maps to a task — org connections/OAuth (Task 5), git connections (Task 6), diff engine (Task 10), deploy engine (Task 12), rollback (Task 13), pipelines (Task 14), history (folded into Task 12's `/api/deployments` list + Task 20's History page), hosting/domain/CI (Tasks 21–22), setup checklist (Task 23). No spec requirement is without a task.

**Placeholder scan:** No TBD/TODO markers; the two `> **Note for implementer**` callouts (Tasks 9 and 11) flag genuine library-version risk in `@salesforce/source-deploy-retrieve`'s conversion API rather than deferring work — they come with concrete code to start from, not blanks to fill in.

**Type consistency:** `ComponentRef` (Task 8) is reused unchanged by Tasks 9, 10, 12. `DeployComponentSelection`/`TestLevel` (Task 12) are reused unchanged by Task 13 (rollback) and Task 17 (frontend client, mirrored). `ConnectionSummary` (Task 5) is reused unchanged by Task 6 (git connections write into the same shape) and Task 17 (frontend). Route paths referenced by the frontend client in Task 17 (`/api/connections`, `/api/connections/git`, `/api/diff`, `/api/deployments`, `/api/deployments/:id`, `/api/deployments/:id/rollback`, `/api/pipelines`) all match routes defined in Tasks 5, 10, 12, 13, 14, 15.
