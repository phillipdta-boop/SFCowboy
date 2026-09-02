# Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap SFCowboy's persistence layer from `better-sqlite3` to Postgres, with zero behavior change and zero new features — the prerequisite for the multi-tenancy/licensing phases that follow.

**Architecture:** Same shape as today — a single `db` object (now a `pg.Pool` instead of a `better-sqlite3.Database`) threaded via constructor injection into every route module and domain module. No ORM, no query builder — raw parameterized SQL via the `pg` driver, same as today's raw SQL via `better-sqlite3`. Every function that touches the database becomes `async`.

**Tech Stack:** `pg` (node-postgres) for the driver, Postgres 16. Tests isolate each run in its own schema against a real, already-running Postgres server (see Task 1's amendment note — this environment has no working Docker, so `testcontainers` is not used).

**Spec:** `docs/superpowers/specs/2026-09-02-postgres-migration-design.md`

## Global Constraints

- No new tables, columns, endpoints, or features — every task in this plan is a mechanical translation of existing behavior.
- Booleans stay `INTEGER` (0/1), JSON-shaped columns stay `TEXT` with `JSON.stringify`/`JSON.parse`, timestamps stay `TEXT` ISO strings — do not upgrade any column's type.
- `?` positional placeholders become `$1, $2, ...`; `.prepare(sql).get(...)` becomes `(await pool.query(sql, params)).rows[0]`; `.all(...)` becomes `.rows`; `.run(...)` (no return value needed) becomes a bare `await pool.query(sql, params)`.
- The `db` parameter name is unchanged everywhere (still called `db`) — only its type annotation changes from `Database.Database` to `Pool` (imported from `pg`). This keeps every call site that just passes `db` through untouched.
- Every exported function that now does `await pool.query(...)` becomes `async` and returns a `Promise<T>` of whatever it returned before; every one of its callers gains `await`.
- Run `npm test` (server) and `npx tsc --noEmit` after every task. Both must be clean before moving to the next task.

---

## Task 1: Add Postgres dependencies and the test database helper

> **Amended 2026-09-02, during implementation:** this task originally used
> `testcontainers` to spin up a fresh Postgres container per test run. The
> machine this is being implemented on has no working Docker install
> (Docker Desktop's WSL2 backend won't start), so instead a real Postgres
> 16 server was installed natively — no admin rights, no Windows service —
> by downloading EDB's portable binaries zip, running `initdb`, and
> starting it with `pg_ctl` on port 5433:
> ```
> C:\Users\Phillip\pgportable\pgsql\bin\pg_ctl.exe -D C:\Users\Phillip\pgportable\data -l C:\Users\Phillip\pgportable\pg.log start
> ```
> It listens on `localhost:5433`, user `sfcowboy`, `trust` auth (no
> password — local dev only), database `sfcowboy` already created. This
> server must be running before any task's tests run; if a fresh
> implementer's session finds it stopped, restart it with the command
> above. `openTestDb()` below isolates each test run in its own schema
> against this one server instead of in its own container — see the spec's
> "Test infrastructure" section (amended the same day) for the full
> rationale. Every other task's use of `openTestDb()`/`TestDb` is
> unaffected — the interface is identical to the original design.

**Files:**
- Modify: `server/package.json`
- Create: `server/src/db/testDb.ts`
- Test: `server/src/db/testDb.test.ts`

**Interfaces:**
- Produces: `openTestDb(): Promise<{ pool: Pool; stop: () => Promise<void> }>` — every later task's test files use this.

- [ ] **Step 1: Update `server/package.json`**

Remove `better-sqlite3` and `@types/better-sqlite3`. Add `pg` as a dependency and `@types/pg` as a devDependency. Remove the `allowScripts` block (it only exists for `better-sqlite3`'s native build step). Do NOT add `testcontainers`/`@testcontainers/postgresql` — see the amendment note above.

```json
{
  "name": "sfcowboy-server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json && npm run copy-assets",
    "copy-assets": "node -e \"const fs=require('node:fs');fs.mkdirSync('dist/db',{recursive:true});fs.cpSync('src/db/schema.sql','dist/db/schema.sql')\"",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.2",
    "pg": "^8.13.0",
    "simple-git": "^3.25.0",
    "@salesforce/core": "^8.5.1",
    "@salesforce/source-deploy-retrieve": "^12.7.4",
    "diff": "^5.2.0",
    "adm-zip": "^0.5.14",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/pg": "^8.11.10",
    "@types/node": "^22.0.0",
    "@types/supertest": "^6.0.2",
    "@types/diff": "^5.2.1",
    "@types/adm-zip": "^0.5.5",
    "typescript": "^5.5.4",
    "tsx": "^4.16.2",
    "vitest": "^2.0.5",
    "supertest": "^7.0.0"
  }
}
```

Run: `cd server && npm install`
Expected: installs cleanly, `node_modules/pg` exists.

- [ ] **Step 2: Write the failing test for `openTestDb`**

Create `server/src/db/testDb.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb } from "./testDb.js";

describe("openTestDb", () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop) await stop();
    stop = undefined;
  });

  it("returns a working Postgres pool, isolated in its own schema, with the current schema already applied", async () => {
    const db = await openTestDb();
    stop = db.stop;

    const result = await db.pool.query("SELECT 1 + 1 AS sum");
    expect(result.rows[0].sum).toBe(2);

    const tables = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name`
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"])
    );
  }, 30_000);

  it("isolates two concurrently-open test databases from each other", async () => {
    const dbA = await openTestDb();
    const dbB = await openTestDb();
    try {
      await dbA.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('only-in-a', 'org', 'A', now()::text)`);
      const inB = await dbB.pool.query(`SELECT id FROM connections WHERE id = 'only-in-a'`);
      expect(inB.rows).toHaveLength(0);
    } finally {
      await dbA.stop();
      await dbB.stop();
    }
  }, 30_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run src/db/testDb.test.ts`
Expected: FAIL — `testDb.js` does not exist / `openTestDb` is not exported.

- [ ] **Step 4: Create `server/src/db/testDb.ts`**

This depends on `runMigrations` from `client.ts`, which Task 2 rewrites to accept a `Pool`. Write this file now with that expectation — Task 2 makes it compile.

```ts
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { runMigrations } from "./client.js";

export interface TestDb {
  pool: Pool;
  stop: () => Promise<void>;
}

// Points at a real, already-running Postgres server rather than spinning one up per test run —
// this project's dev/CI environment has no Docker available, so there is no testcontainers-style
// ephemeral-container option here. Defaults to the local, no-admin-rights install this
// implementation set up: `initdb` + `pg_ctl start` on port 5433, user `sfcowboy`, trust auth.
// Override with TEST_DATABASE_URL to point at a different reachable Postgres server (e.g. in CI).
const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? "postgres://sfcowboy@localhost:5433/sfcowboy";

/**
 * Isolates a single test file/run inside its own freshly created schema on the shared server
 * above, with the current schema already applied, then drops that schema on stop(). This is the
 * schema-per-run equivalent of what `openDb(":memory:")` + `runMigrations(db)` gave for free under
 * SQLite (a throwaway, isolated database per run) — a container-per-run isn't available here, but
 * two concurrently open openTestDb() calls still never see each other's data.
 */
export async function openTestDb(): Promise<TestDb> {
  const schemaName = `test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING });
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  await adminPool.end();

  const pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
  await runMigrations(pool);

  return {
    pool,
    stop: async () => {
      await pool.end();
      const cleanupPool = new Pool({ connectionString: ADMIN_CONNECTION_STRING });
      await cleanupPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      await cleanupPool.end();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

This won't pass yet — `client.ts`'s `runMigrations` still expects a `better-sqlite3.Database`. Skip running it standalone; it becomes green at the end of Task 2's Step 4. Note this dependency and move on.

- [ ] **Step 6: Confirm the local Postgres server is reachable**

Run: `cd server && node -e "const {Pool}=require('pg'); new Pool({connectionString:'postgres://sfcowboy@localhost:5433/sfcowboy'}).query('SELECT 1').then(()=>{console.log('OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `OK`. If this fails with a connection error, the local server (see the amendment note at the top of this task) needs to be (re)started before continuing with any later task.

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/src/db/testDb.ts server/src/db/testDb.test.ts
git commit -m "build: add pg dependency, add schema-per-run openTestDb helper"
```

---

## Task 2: Convert `server/src/db/client.ts` (schema + migrations)

> **Amended after task review:** the review found two real gaps in this
> task's originally-specified code, both fixed and folded into the text
> below: (1) the `source_connection_id` nullability query needed
> `AND table_schema = current_schema()` to stay schema-safe under
> concurrent `openTestDb()` schemas (its sibling `regclass`-based query
> already was); (2) the two "upgrade an existing database" migration-guard
> branches had no test exercising the branch actually being taken. Two
> regression tests are added at the end of Step 2's test file: one that
> recreates `deployments_status_check` without `'cancelled'` and asserts
> `runMigrations` repairs it, one that sets `source_connection_id NOT NULL`
> and asserts `runMigrations` relaxes it — same "induce the old state, run
> migrations again, assert the guard fires" pattern as the original SQLite
> suite's equivalents.

**Files:**
- Modify: `server/src/db/client.ts`
- Modify: `server/src/db/client.test.ts`
- No change: `server/src/db/schema.sql` (see Step 1 — it's already valid Postgres DDL)

**Interfaces:**
- Produces: `openDb(connectionString: string): Pool`, `runMigrations(db: Pool): Promise<void>`, `withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T>` — every later task imports these from `./db/client.js`.

- [ ] **Step 1: Confirm `schema.sql` needs no changes**

Every type used (`TEXT`, `INTEGER`, `REAL`, `CHECK (...)`, `REFERENCES table(id)`, `CREATE TABLE IF NOT EXISTS`) is valid, unmodified Postgres syntax — this file is already portable. No edit needed. This gets exercised for real by Task 1's `testDb.test.ts` once this task's Step 4 makes it runnable.

- [ ] **Step 2: Write the failing tests for the rewritten `client.ts`**

Replace `server/src/db/client.test.ts` entirely with:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "./testDb.js";
import { runMigrations, withTransaction } from "./client.js";

describe("runMigrations", () => {
  let db: TestDb | undefined;

  afterEach(async () => {
    if (db) await db.stop();
    db = undefined;
  });

  it("is idempotent — running it twice on the same database does not error", async () => {
    db = await openTestDb();
    await expect(runMigrations(db.pool)).resolves.not.toThrow();
  }, 60_000);

  it("creates the deployments table with 'cancelled' already in the status CHECK constraint", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'cancelled', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("allows source_connection_id to be NULL (an imported deployment has no source)", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'pending', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("enforces the deployments.status CHECK constraint against an invalid value", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'not-a-real-status', now()::text)`
      )
    ).rejects.toThrow();
  }, 60_000);

  it("enforces the deployment_items.deployment_id foreign key against deployments", async () => {
    db = await openTestDb();
    await expect(
      db.pool.query(
        `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status)
         VALUES ('item1', 'no-such-deployment', 'ApexClass', 'A', 'add', 'pending')`
      )
    ).rejects.toThrow();
  }, 60_000);

  it("upgrades an existing database whose deployments_status_check predates 'cancelled'", async () => {
    db = await openTestDb();
    await db.pool.query(`ALTER TABLE deployments DROP CONSTRAINT deployments_status_check`);
    await db.pool.query(
      `ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
       CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back'))`
    );
    await runMigrations(db.pool);
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 't', '[]', 'NoTestRun', 'cancelled', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);

  it("upgrades an existing database whose source_connection_id is still NOT NULL", async () => {
    db = await openTestDb();
    await db.pool.query(`ALTER TABLE deployments ALTER COLUMN source_connection_id SET NOT NULL`);
    await runMigrations(db.pool);
    await expect(
      db.pool.query(
        `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', NULL, 't', '[]', 'NoTestRun', 'pending', now()::text)`
      )
    ).resolves.not.toThrow();
  }, 60_000);
});

describe("withTransaction", () => {
  let db: TestDb | undefined;

  afterEach(async () => {
    if (db) await db.stop();
    db = undefined;
  });

  it("commits all writes when the callback succeeds", async () => {
    db = await openTestDb();
    await withTransaction(db.pool, async (client) => {
      await client.query(
        `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', now()::text)`
      );
    });
    const result = await db.pool.query(`SELECT id FROM connections WHERE id = 'c1'`);
    expect(result.rows).toHaveLength(1);
  }, 60_000);

  it("rolls back all writes when the callback throws", async () => {
    db = await openTestDb();
    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(
          `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', now()::text)`
        );
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const result = await db.pool.query(`SELECT id FROM connections WHERE id = 'c1'`);
    expect(result.rows).toHaveLength(0);
  }, 60_000);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/db/client.test.ts src/db/testDb.test.ts`
Expected: FAIL — `client.ts` still exports the `better-sqlite3`-based `openDb`/`runMigrations`, no `withTransaction`.

- [ ] **Step 4: Rewrite `server/src/db/client.ts`**

```ts
import { Pool, type PoolClient } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function openDb(connectionString: string): Pool {
  return new Pool({ connectionString });
}

/**
 * Runs `fn` inside a single Postgres transaction on a dedicated client, committing on success and
 * rolling back on any thrown error. Used wherever a multi-statement write needs atomicity — today,
 * only the deployments-table constraint fixes below, which is why this lives in this file rather
 * than a shared db-utils module; promote it if a second caller ever needs it.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(db: Pool): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  await db.query(schema);

  // schema.sql's CREATE TABLE IF NOT EXISTS won't alter a table that already exists from an
  // older schema version — these are idempotent no-ops on a fresh database (CREATE TABLE above
  // already includes every column) and only do real work when upgrading an existing database
  // created from an older version of this file. Kept anyway: this IS the mechanism future schema
  // changes use (e.g. the org-scoping columns the next phase adds).
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS encrypted_client_id TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS last_error TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS login_username TEXT`);
  await db.query(`ALTER TABLE connections ADD COLUMN IF NOT EXISTS min_code_coverage_percent INTEGER`);

  await db.query(
    `ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))`
  );
  await db.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS track_components_independently INTEGER NOT NULL DEFAULT 1`);

  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS title TEXT`);
  for (const column of ["ignore_warnings", "allow_missing_files", "auto_update_package"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} INTEGER NOT NULL DEFAULT 0`);
  }
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS run_tests TEXT NOT NULL DEFAULT '[]'`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS sf_job_id TEXT`);
  for (const column of ["components_deployed", "components_total", "tests_completed", "tests_total"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} INTEGER`);
  }
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS run_by TEXT`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pipeline_run_id TEXT REFERENCES pipeline_runs(id)`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS pipeline_step_index INTEGER`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS coverage_percent REAL`);
  await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS coverage_details TEXT`);
  for (const column of ["source_branch", "target_branch", "static_analysis_findings", "scheduled_at", "package_path"]) {
    await db.query(`ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ${column} TEXT`);
  }

  // Postgres can ALTER a CHECK/NOT NULL constraint directly — no SQLite-style rebuild needed.
  // These are no-ops on a fresh database (schema.sql's CREATE TABLE already has both fixes) and
  // only matter for a database created from an older version of this file.
  const statusCheck = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid = 'deployments'::regclass AND contype = 'c' AND conname = 'deployments_status_check'`
  );
  if (statusCheck.rows[0] && !statusCheck.rows[0].definition.includes("cancelled")) {
    await withTransaction(db, async (client) => {
      await client.query(`ALTER TABLE deployments DROP CONSTRAINT deployments_status_check`);
      await client.query(
        `ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
         CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back','cancelled'))`
      );
    });
  }

  const sourceConnectionIdNullable = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = 'deployments' AND column_name = 'source_connection_id' AND table_schema = current_schema()`
  );
  if (sourceConnectionIdNullable.rows[0]?.is_nullable === "NO") {
    await db.query(`ALTER TABLE deployments ALTER COLUMN source_connection_id DROP NOT NULL`);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/db/client.test.ts src/db/testDb.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/db/client.ts server/src/db/client.test.ts
git commit -m "feat: convert db/client.ts migrations from SQLite to Postgres idioms"
```

---

## Task 3: Update `config.ts`, `index.ts`, `app.ts`, `scheduler.ts`

**Files:**
- Modify: `server/src/config.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/scheduler.ts`
- Modify: `server/src/app.test.ts`
- Modify: `server/src/scheduler.test.ts`

**Interfaces:**
- Consumes: `openDb(connectionString: string): Pool`, `runMigrations(db: Pool): Promise<void>` (Task 2).
- Produces: `Config.databaseUrl: string` — read by `index.ts` only.

- [ ] **Step 1: Update `server/src/config.ts`**

```ts
export interface Config {
  port: number;
  databaseUrl: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
  sfClientId: string;
}

// The Consumer Key of the "SFCowboy" Connected App. A Connected App's Consumer Key is globally
// resolvable by Salesforce's OAuth endpoints regardless of which org owns the app definition, so
// this one value works for authorizing any org — sandbox or production, whether or not that org
// has ever seen this app before. It is a public client ID, not a secret — the app uses PKCE (no
// client secret required), so there is nothing confidential to protect here. Overridable only in
// case the Connected App is ever recreated under a new Consumer Key.
const DEFAULT_SF_CLIENT_ID = "3MVG9rZjd7MXFdLjkcY3ibNjVfGj3em_cbzSYg4O1HRTUjHIFhnJuRbDQ1WCxObsXPufnupzSx_sdsMroZ.Zd";

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY", "DATABASE_URL"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    databaseUrl: process.env.DATABASE_URL!,
    encryptionKey: process.env.ENCRYPTION_KEY!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
    sfClientId: process.env.SF_CLIENT_ID ?? DEFAULT_SF_CLIENT_ID,
  };
}
```

- [ ] **Step 2: Update `server/src/index.ts`**

```ts
import "dotenv/config";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.databaseUrl);
await runMigrations(db);

const app = createApp(db, config, dataDir, process.env.WEB_DIST_DIR);

// Catches up on anything scheduled while the server wasn't running, then polls for newly-due
// scheduled deployments every 30s — see scheduler.ts.
startScheduler(db, config, dataDir, 30_000);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
```

- [ ] **Step 3: Update `server/src/app.ts`** (type annotation only)

```ts
import path from "node:path";
import express from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";

export function createApp(db: Pool, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  // Raised from Express's 100kb default so an imported deployment's zip (sent as base64 JSON —
  // see /api/deployments/import) doesn't get rejected before it ever reaches validation.
  app.use(express.json({ limit: "50mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthRouter(db, config));
  app.use(createConnectionsRouter(db, config));
  app.use(createEngineRouter(db, config, dataDir));
  app.use(createPipelinesRouter(db, config, dataDir));

  if (webDistDir) {
    app.use(express.static(webDistDir));
    app.get(/^(?!\/api|\/oauth).*/, (_req, res) => {
      res.sendFile(path.join(webDistDir, "index.html"));
    });
  }

  return app;
}
```

- [ ] **Step 4: Update `server/src/scheduler.ts`** (type annotation only)

```ts
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
```

- [ ] **Step 5: Update test setup in `server/src/app.test.ts` and `server/src/scheduler.test.ts`**

In both files, find the setup that does `openDb(":memory:")` + `runMigrations(db)` synchronously and replace with the `openTestDb()` helper from Task 1, adding a `stop()` call in `afterEach`/`afterAll`. Example shape (apply the same substitution used in Task 2's `client.test.ts`):

```ts
// Before:
const db = openDb(":memory:");
runMigrations(db);

// After:
let testDb: TestDb;
beforeEach(async () => {
  testDb = await openTestDb();
});
afterEach(async () => {
  await testDb.stop();
});
// use testDb.pool wherever `db` was used
```

Update every call into `createApp`/`startScheduler`/`runDueScheduledDeployments` in these two files to pass `testDb.pool`, and update any assertion that reads deployment/connection rows back out to `await` the query.

- [ ] **Step 6: Run the full server test suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run src/app.test.ts src/scheduler.test.ts`
Expected: both clean. (Other test files still fail at this point — they're converted in later tasks.)

- [ ] **Step 7: Commit**

```bash
git add server/src/config.ts server/src/index.ts server/src/app.ts server/src/scheduler.ts server/src/app.test.ts server/src/scheduler.test.ts
git commit -m "feat: wire config/index/app/scheduler to a pg.Pool instead of better-sqlite3"
```

---

## Task 4: Convert `server/src/connections/gitConnections.ts`

**Files:**
- Modify: `server/src/connections/gitConnections.ts`
- Modify: `server/src/connections/gitConnections.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createGitConnection(db: Pool, input): Promise<ConnectionSummary>` — was synchronous; every caller (Task 10's `connections/routes.ts`) now awaits it.

- [ ] **Step 1: Convert the one query site**

In `server/src/connections/gitConnections.ts`, change the import and `createGitConnection`:

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { simpleGit } from "simple-git";
import { encrypt } from "../crypto/encryption.js";
import type { ConnectionSummary } from "./orgConnections.js";

// Generate HTTP Basic auth header for git HTTP operations
// Passed via -c http.extraheader flag (ephemeral, not persisted to config)
export function gitAuthHeader(token: string): string {
  const credentials = `x-access-token:${token}`;
  const base64 = Buffer.from(credentials).toString("base64");
  return `http.extraheader=AUTHORIZATION: basic ${base64}`;
}

export async function createGitConnection(
  db: Pool,
  input: { nickname: string; remoteUrl: string; defaultBranch: string; authToken: string }
): Promise<ConnectionSummary> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    `INSERT INTO connections (id, type, nickname, created_at, remote_url, default_branch, encrypted_auth_token)
     VALUES ($1, 'git', $2, $3, $4, $5, $6)`,
    [id, input.nickname, createdAt, input.remoteUrl, input.defaultBranch, encrypt(input.authToken)]
  );

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
```

Every other function in this file (`testGitConnection`, `localCloneDir`, `ensureLocalClone`, `commitAllAndPush`) is unchanged — none of them touch the database.

- [ ] **Step 2: Update `server/src/connections/gitConnections.test.ts`**

Apply the standard setup swap (Task 3, Step 5's pattern) to this file's test DB setup, and add `await` in front of every `createGitConnection(...)` call.

- [ ] **Step 3: Run the tests**

Run: `cd server && npx vitest run src/connections/gitConnections.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/connections/gitConnections.ts server/src/connections/gitConnections.test.ts
git commit -m "feat: convert gitConnections.ts to async pg"
```

---

## Task 5: Convert `server/src/connections/orgConnections.ts`

**Files:**
- Modify: `server/src/connections/orgConnections.ts`
- Modify: `server/src/connections/orgConnections.test.ts`

**Interfaces:**
- Produces (all now `async`, returning the same shape wrapped in `Promise`): `createOrgConnection`, `listConnections`, `getConnectionSummary`, `deleteConnection`, `renameConnection`, `setMinCodeCoveragePercent`, `getConnectionRow`, `getValidAccessToken` (already async, unchanged signature), `reauthorizeOrgConnection`, `testOrgConnection` (already async, unchanged signature). `getConnectionRow` in particular is called from almost every other module in this codebase — every one of those call sites needs `await` added (tracked in later tasks).

- [ ] **Step 1: Rewrite `server/src/connections/orgConnections.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
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
  lastError?: string | null;
  username?: string | null;
  minCodeCoveragePercent?: number | null;
}

export async function createOrgConnection(
  db: Pool,
  input: {
    nickname: string;
    orgType: "sandbox" | "production";
    instanceUrl: string;
    refreshToken: string;
    clientId: string;
    username?: string;
  }
): Promise<ConnectionSummary> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  await db.query(
    `INSERT INTO connections (id, type, nickname, created_at, instance_url, org_type, encrypted_refresh_token, encrypted_client_id, login_username)
     VALUES ($1, 'org', $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.nickname, createdAt, input.instanceUrl, input.orgType, encrypt(input.refreshToken), encrypt(input.clientId), input.username ?? null]
  );

  return {
    id, type: "org", nickname: input.nickname, createdAt, lastUsedAt: null,
    instanceUrl: input.instanceUrl, orgType: input.orgType, username: input.username ?? null,
  };
}

const CONNECTION_SUMMARY_COLUMNS = `id, type, nickname,
              created_at as "createdAt", last_used_at as "lastUsedAt",
              instance_url as "instanceUrl", org_type as "orgType",
              remote_url as "remoteUrl", default_branch as "defaultBranch",
              last_error as "lastError", login_username as username,
              min_code_coverage_percent as "minCodeCoveragePercent"`;

export async function listConnections(db: Pool): Promise<ConnectionSummary[]> {
  const result = await db.query<ConnectionSummary>(`SELECT ${CONNECTION_SUMMARY_COLUMNS} FROM connections`);
  return result.rows;
}

export async function getConnectionSummary(db: Pool, id: string): Promise<ConnectionSummary | undefined> {
  const result = await db.query<ConnectionSummary>(`SELECT ${CONNECTION_SUMMARY_COLUMNS} FROM connections WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function deleteConnection(db: Pool, id: string): Promise<void> {
  await db.query(`DELETE FROM connections WHERE id = $1`, [id]);
}

/** Renames a connection (org or git) — just a label, safe at any time. */
export async function renameConnection(db: Pool, id: string, nickname: string): Promise<void> {
  if (!nickname || !nickname.trim()) {
    throw new Error("nickname must not be blank");
  }
  const row = await getConnectionRow(db, id);
  if (!row) throw new Error(`No connection with id ${id}`);
  await db.query(`UPDATE connections SET nickname = $1 WHERE id = $2`, [nickname.trim(), id]);
}

/**
 * Sets (or clears, with null) the minimum aggregate Apex coverage a deploy to this connection
 * must meet — see the coverage gate in engine/deploy.ts. Org connections only: a git target never
 * runs Apex tests, so a threshold there could never be satisfied.
 */
export async function setMinCodeCoveragePercent(db: Pool, id: string, percent: number | null): Promise<void> {
  const row = await getConnectionRow(db, id);
  if (!row) throw new Error(`No connection with id ${id}`);
  if (row.type !== "org") {
    throw new Error("A minimum coverage threshold only applies to an org connection");
  }
  if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
    throw new Error("minCodeCoveragePercent must be a number between 0 and 100, or null");
  }
  await db.query(`UPDATE connections SET min_code_coverage_percent = $1 WHERE id = $2`, [percent, id]);
}

export async function getConnectionRow(db: Pool, id: string): Promise<any> {
  const result = await db.query(`SELECT * FROM connections WHERE id = $1`, [id]);
  return result.rows[0];
}

// Two requests for the same connection can land close together (e.g. a page that fetches
// metadata types and loads a diff at the same time). With refresh token rotation enabled,
// Salesforce invalidates a refresh token the instant it's used, so if both requests read the
// same stored token and both try to exchange it, the loser gets invalid_grant — and can leave
// the DB holding a token that's already been superseded, permanently breaking the connection.
// Coalescing concurrent calls into a single in-flight exchange avoids that race entirely.
const inFlightRefreshes = new Map<string, Promise<{ accessToken: string; instanceUrl: string }>>();

export async function getValidAccessToken(
  db: Pool,
  id: string,
  _config: Config
): Promise<{ accessToken: string; instanceUrl: string }> {
  const existing = inFlightRefreshes.get(id);
  if (existing) return existing;

  const exchange = (async () => {
    const row = await getConnectionRow(db, id);
    if (!row || row.type !== "org") {
      throw new Error(`No org connection with id ${id}`);
    }
    const refreshToken = decrypt(row.encrypted_refresh_token);
    const clientId = decrypt(row.encrypted_client_id);
    const loginUrl = row.org_type === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";

    let result;
    try {
      result = await refreshAccessToken({ loginUrl, refreshToken, clientId });
    } catch (err) {
      // Recorded so the Connections page can flag this org as needing re-authorization, instead
      // of the failure only ever surfacing as a one-off error on whatever action triggered it.
      await db.query(`UPDATE connections SET last_error = $1 WHERE id = $2`, [(err as Error).message, id]);
      throw err;
    }

    // Connected Apps with refresh token rotation enabled invalidate the old refresh token as soon
    // as a new one is issued — if we don't persist it here, the next refresh fails with
    // invalid_grant even though nothing else is wrong.
    if (result.refreshToken) {
      await db.query(
        `UPDATE connections SET last_used_at = $1, encrypted_refresh_token = $2, last_error = NULL WHERE id = $3`,
        [new Date().toISOString(), encrypt(result.refreshToken), id]
      );
    } else {
      await db.query(`UPDATE connections SET last_used_at = $1, last_error = NULL WHERE id = $2`, [new Date().toISOString(), id]);
    }

    return { accessToken: result.accessToken, instanceUrl: result.instanceUrl };
  })();

  inFlightRefreshes.set(id, exchange);
  try {
    return await exchange;
  } finally {
    inFlightRefreshes.delete(id);
  }
}

/**
 * Replaces an org connection's credentials after the user re-authorizes it through Salesforce
 * again — used to recover a connection whose refresh token expired or was revoked, without
 * creating a duplicate connection or losing its id (and everything referencing it, like past
 * deployments).
 */
export async function reauthorizeOrgConnection(
  db: Pool,
  id: string,
  input: { instanceUrl: string; refreshToken: string; username?: string }
): Promise<void> {
  const row = await getConnectionRow(db, id);
  if (!row || row.type !== "org") {
    throw new Error(`No org connection with id ${id}`);
  }
  // Omitting username (e.g. the identity lookup failed) must not blank out whatever was already
  // stored — COALESCE keeps the existing value in that case.
  await db.query(
    `UPDATE connections
     SET instance_url = $1, encrypted_refresh_token = $2, last_error = NULL, last_used_at = $3, login_username = COALESCE($4, login_username)
     WHERE id = $5`,
    [input.instanceUrl, encrypt(input.refreshToken), new Date().toISOString(), input.username ?? null, id]
  );
}

/**
 * Verifies an org connection's stored credentials still work by attempting a token refresh —
 * the same operation every real deploy/diff call already depends on, so success here is a
 * meaningful signal without needing a separate Salesforce API call. Reports failure as a result
 * rather than throwing, so the route handler can hand it straight to the UI.
 */
export async function testOrgConnection(db: Pool, config: Config, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getValidAccessToken(db, id, config);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
```

Note the `CONNECTION_SUMMARY_COLUMNS` change: SQLite's `AS lastUsedAt` (unquoted) silently folds to lowercase in SQLite's own result object keys but `better-sqlite3` returns whatever case you asked for; Postgres unquoted identifiers are folded to lowercase, so an unquoted `as lastUsedAt` would come back as `lastusedat`. Every camelCase alias here is now double-quoted (`as "lastUsedAt"`) to preserve exact casing — this is the one place in this file where Postgres's identifier-folding rules require a real (not cosmetic) change, not just `?`→`$n`.

- [ ] **Step 2: Update `server/src/connections/orgConnections.test.ts`**

Apply the standard setup swap. Add `await` to every call into the now-async functions listed in this task's Interfaces section, and change `const x = fn(...)` to `const x = await fn(...)` throughout.

- [ ] **Step 3: Run the tests**

Run: `cd server && npx vitest run src/connections/orgConnections.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/connections/orgConnections.ts server/src/connections/orgConnections.test.ts
git commit -m "feat: convert orgConnections.ts to async pg"
```

---

## Task 6: Convert `server/src/pipelines/pipelines.ts`

**Files:**
- Modify: `server/src/pipelines/pipelines.ts`
- Modify: `server/src/pipelines/pipelines.test.ts`

**Interfaces:**
- Produces (all now `async`): `createPipeline(db: Pool, input): Promise<Pipeline>`, `listPipelines(db: Pool): Promise<Pipeline[]>`, `getPipeline(db: Pool, id: string): Promise<Pipeline | undefined>`, `updatePipeline(db: Pool, id, input): Promise<boolean>`, `setPipelineStatus(db: Pool, id, status): Promise<boolean>`, `pipelineHasRuns(db: Pool, id): Promise<boolean>`, `deletePipeline(db: Pool, id): Promise<boolean>`.
- This is the one module with **no existing async functions** — every one of these is a first-time `async` conversion, and Task 10 updates every caller in `pipelines/routes.ts` to `await` them.

- [ ] **Step 1: Rewrite `server/src/pipelines/pipelines.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
  trackComponentsIndependently: boolean;
}

function rowToPipeline(row: any): Pipeline {
  return {
    id: row.id,
    name: row.name,
    connectionIds: JSON.parse(row.connection_ids),
    status: row.status,
    trackComponentsIndependently: !!row.track_components_independently,
  };
}

const SELECT_COLUMNS = `id, name, connection_ids, status, track_components_independently`;

export async function createPipeline(db: Pool, input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO pipelines (id, name, connection_ids, status, track_components_independently) VALUES ($1, $2, $3, 'active', 1)`,
    [id, input.name, JSON.stringify(input.connectionIds)]
  );
  return { id, name: input.name, connectionIds: input.connectionIds, status: "active", trackComponentsIndependently: true };
}

export async function listPipelines(db: Pool): Promise<Pipeline[]> {
  const result = await db.query(`SELECT ${SELECT_COLUMNS} FROM pipelines`);
  return result.rows.map(rowToPipeline);
}

export async function getPipeline(db: Pool, id: string): Promise<Pipeline | undefined> {
  const result = await db.query(`SELECT ${SELECT_COLUMNS} FROM pipelines WHERE id = $1`, [id]);
  return result.rows[0] ? rowToPipeline(result.rows[0]) : undefined;
}

export async function updatePipeline(
  db: Pool,
  id: string,
  input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }
): Promise<boolean> {
  // Omitting trackComponentsIndependently must leave the stored value untouched (e.g. a plain
  // rename shouldn't silently reset the tracking mode) — COALESCE keeps the existing value when
  // the bound parameter is NULL.
  const trackValue = input.trackComponentsIndependently === undefined ? null : input.trackComponentsIndependently ? 1 : 0;
  const result = await db.query(
    `UPDATE pipelines SET name = $1, connection_ids = $2, track_components_independently = COALESCE($3, track_components_independently) WHERE id = $4`,
    [input.name, JSON.stringify(input.connectionIds), trackValue, id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setPipelineStatus(db: Pool, id: string, status: "active" | "closed"): Promise<boolean> {
  const result = await db.query(`UPDATE pipelines SET status = $1 WHERE id = $2`, [status, id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether any run has ever been started on this pipeline.
 *
 * pipeline_runs.pipeline_id is a real FK, so deleting a pipeline that still has runs raises a
 * foreign key violation. Callers check this first so they can refuse with a clear message instead
 * of surfacing a raw constraint error — deleting a pipeline's run history is a separate, more
 * sensitive decision than a plain "delete this pipeline" is allowed to make.
 */
export async function pipelineHasRuns(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM pipeline_runs WHERE pipeline_id = $1 LIMIT 1`, [id]);
  return result.rows.length > 0;
}

export async function deletePipeline(db: Pool, id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM pipelines WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
```

Note `result.changes` (better-sqlite3's row-count field on a `.run()` result) becomes `result.rowCount` (`pg`'s equivalent on a `query()` result) — `rowCount` is `number | null` in `pg`'s types, hence `?? 0`.

> **Amended after task review found a plan gap:** this task's original text
> incorrectly claimed "this file has no test file of its own." It does:
> `server/src/pipelines/pipelines.test.ts` (8 tests, all synchronous calls
> against `openDb(":memory:")` + `runMigrations(db)`). Step 2 below replaces
> the old Step 2 ("just typecheck") with the same async/`openTestDb()`
> conversion every other domain module's test file gets.

- [ ] **Step 2: Convert `server/src/pipelines/pipelines.test.ts`**

Replace it entirely with:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, setPipelineStatus, getPipeline } from "./pipelines.js";

describe("pipelines", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a pipeline defaulting to active status, and lists it", async () => {
    db = await openTestDb();
    await createPipeline(db.pool, { name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"] });
    const list = await listPipelines(db.pool);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1", "conn2", "conn3"], status: "active" });
  });

  it("closes and reopens a pipeline without touching its name or connections", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main Pipeline", connectionIds: ["conn1"] });

    const closed = await setPipelineStatus(db.pool, created.id, "closed");
    expect(closed).toBe(true);
    expect((await listPipelines(db.pool))[0]).toMatchObject({ name: "Main Pipeline", connectionIds: ["conn1"], status: "closed" });

    await setPipelineStatus(db.pool, created.id, "active");
    expect((await listPipelines(db.pool))[0].status).toBe("active");
  });

  it("returns false when setting status on a nonexistent pipeline", async () => {
    db = await openTestDb();
    expect(await setPipelineStatus(db.pool, "does-not-exist", "closed")).toBe(false);
  });

  it("updates a pipeline's name and connection order", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Original", connectionIds: ["conn1", "conn2"] });
    await updatePipeline(db.pool, created.id, { name: "Renamed", connectionIds: ["conn2", "conn1"] });
    const list = await listPipelines(db.pool);
    expect(list[0]).toMatchObject({ name: "Renamed", connectionIds: ["conn2", "conn1"] });
  });

  it("deletes a pipeline", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "ToDelete", connectionIds: [] });
    await deletePipeline(db.pool, created.id);
    expect(await listPipelines(db.pool)).toHaveLength(0);
  });

  it("defaults a new pipeline to tracking components independently", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    expect(created.trackComponentsIndependently).toBe(true);
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(true);
  });

  it("updates the tracking mode when explicitly provided", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    await updatePipeline(db.pool, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(false);
  });

  it("leaves the tracking mode untouched when the update omits it", async () => {
    db = await openTestDb();
    const created = await createPipeline(db.pool, { name: "Main", connectionIds: ["a", "b"] });
    await updatePipeline(db.pool, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    await updatePipeline(db.pool, created.id, { name: "Renamed", connectionIds: ["a", "b"] });
    expect((await getPipeline(db.pool, created.id))!.trackComponentsIndependently).toBe(false);
    expect((await getPipeline(db.pool, created.id))!.name).toBe("Renamed");
  });
});
```

- [ ] **Step 3: Run the test**

Run: `cd server && npx vitest run src/pipelines/pipelines.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 4: Run the typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: errors only in files not yet converted (`pipelineRuns.ts`, `routes.ts` files, `deploy.ts`, `rollback.ts`) — confirm no NEW errors in `pipelines.ts`/`pipelines.test.ts` themselves.

- [ ] **Step 5: Commit**

```bash
git add server/src/pipelines/pipelines.ts server/src/pipelines/pipelines.test.ts
git commit -m "feat: convert pipelines.ts and its tests to async pg"
```

---

## Task 6b: Convert `server/src/engine/sfConnection.ts`

> **Added after implementation began — a gap in the original plan's file
> inventory.** `sfConnection.ts` was missed when the plan's file-by-file
> research was done: it contains no raw SQL of its own, but it takes a
> `db: Database.Database` parameter and calls `getConnectionRow(db,
> connectionId)` **without `await`** (a latent bug the instant
> `orgConnections.ts`, Task 5, made that function real-async — currently
> masked only because `sfConnection.test.ts` mocks `getConnectionRow` with
> `mockReturnValue` instead of `mockResolvedValue`, so the mock's
> synchronous return value hides the missing await). `deploy.ts`,
> `rollback.ts`, and `engine/routes.ts` all import and call
> `buildOrgConnection` from this file and will pass a `Pool` — this file
> must be fixed before any of those three are converted (i.e. before the
> merged Task 8+9 dispatch).

**Files:**
- Modify: `server/src/engine/sfConnection.ts`
- Modify: `server/src/engine/sfConnection.test.ts`

**Interfaces:**
- Produces: `buildOrgConnection(db: Pool, connectionId: string, config: Config): Promise<Connection>` — was already `async`; only its `db` parameter type changes, plus the missing `await` is added. `deploy.ts`, `rollback.ts`, and `engine/routes.ts` (Tasks 8+9 merged, and 10a) import this.

- [ ] **Step 1: Write the failing test**

`server/src/engine/sfConnection.test.ts` currently mocks `getConnectionRow` with `mockReturnValue`, which doesn't exercise the real async contract. Change both `mockReturnValue` calls to `mockResolvedValue` so the test actually requires `buildOrgConnection` to `await` the call:

```ts
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
    vi.spyOn(orgConnections, "getConnectionRow").mockResolvedValue({ id: "conn1", type: "org" } as any);
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
    vi.spyOn(orgConnections, "getConnectionRow").mockResolvedValue({ id: "conn2", type: "git" } as any);
    await expect(buildOrgConnection({} as any, "conn2", {} as any)).rejects.toThrow(/No org connection/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/engine/sfConnection.test.ts`
Expected: FAIL — `buildOrgConnection` doesn't `await` `getConnectionRow`, so `row` is a pending Promise and `row.type !== "org"` is always true, so the first test's assertions on `AuthInfo.create`/`Connection.create` never run (it throws instead).

- [ ] **Step 3: Fix `server/src/engine/sfConnection.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/engine/sfConnection.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/sfConnection.ts server/src/engine/sfConnection.test.ts
git commit -m "fix: buildOrgConnection was missing await on the now-async getConnectionRow"
```

---

## Task 7: Convert `server/src/pipelines/pipelineRuns.ts`

**Files:**
- Modify: `server/src/pipelines/pipelineRuns.ts`
- Modify: `server/src/pipelines/pipelineRuns.test.ts`

**Interfaces:**
- Consumes: `getPipeline(db: Pool, id): Promise<Pipeline | undefined>` (Task 6), `resolveComponents` (already async — Task 10 converts its internals), `createDraftDeployment`, `attachComponentsAndQueue`, `setRunBy`, `tagDeploymentToPipelineStep`, `runDeployment` (all converted in Task 9).
- Produces: `deriveComponentPositions` (pure function, unchanged — no DB access), `createPipelineRun(db: Pool, input): Promise<{ id: string }>`, `listPipelineRuns(db: Pool, pipelineId): Promise<PipelineRunSummary[]>`, `getPipelineRunDetail(db: Pool, runId): Promise<PipelineRunDetail | undefined>`, `deployPipelineStep(db: Pool, config, dataDir, runId, stepIndex, options): Promise<{ deploymentId: string; skipped: boolean }>` (already async).

- [ ] **Step 1: Rewrite `server/src/pipelines/pipelineRuns.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPipeline } from "./pipelines.js";
import type { Config } from "../config.js";
import { resolveComponents } from "../engine/routes.js";
import { diffComponents } from "../engine/diff.js";
import { createDraftDeployment, attachComponentsAndQueue, setRunBy, runDeployment, tagDeploymentToPipelineStep, type DeployComponentSelection } from "../engine/deploy.js";

export interface PipelineRunComponent {
  type: string;
  fullName: string;
}

export interface StepDeploymentItem {
  metadataType: string;
  apiName: string;
  status: "pending" | "succeeded" | "failed";
}

export interface StepDeployment {
  stepIndex: number;
  status: string;
  validateOnly: boolean;
  finishedAt: string | null;
  items: StepDeploymentItem[];
}

export interface ComponentPosition {
  type: string;
  fullName: string;
  stage: number;
  reachedAt: string | null;
}

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

function itemKey(i: StepDeploymentItem): string {
  return `${i.metadataType}::${i.apiName}`;
}

const UNDONE_STATUSES = new Set(["rolled_back", "cancelled"]);
const TERMINAL_DEPLOYMENT_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);

/**
 * Computes each component's current stage in a pipeline run and when it got there, purely from
 * the run's tagged deployments — there is no separate "position" table (see the design spec).
 * Pure function — no database access, unchanged from the SQLite version.
 */
export function deriveComponentPositions(
  components: PipelineRunComponent[],
  deployments: StepDeployment[],
  trackIndependently: boolean
): ComponentPosition[] {
  const positions = new Map<string, ComponentPosition>(
    components.map((c) => [componentKey(c), { type: c.type, fullName: c.fullName, stage: 0, reachedAt: null }])
  );

  const maxStep = deployments.reduce((max, d) => Math.max(max, d.stepIndex), -1);

  for (let stepIndex = 0; stepIndex <= maxStep; stepIndex++) {
    const attempts = deployments
      .filter((d) => d.stepIndex === stepIndex && !d.validateOnly && !UNDONE_STATUSES.has(d.status))
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    if (attempts.length === 0) continue;

    const pendingKeys = [...positions.values()].filter((p) => p.stage === stepIndex).map((p) => componentKey(p));
    if (pendingKeys.length === 0) continue;

    if (trackIndependently) {
      for (const attempt of attempts) {
        for (const key of pendingKeys) {
          const pos = positions.get(key)!;
          if (pos.stage !== stepIndex) continue;
          const item = attempt.items.find((i) => itemKey(i) === key);
          const itemCleared = item ? item.status === "succeeded" : attempt.status === "succeeded";
          if (itemCleared) {
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
        }
      }
    } else {
      for (const attempt of attempts) {
        const stillPending = pendingKeys.filter((key) => positions.get(key)!.stage === stepIndex);
        if (stillPending.length === 0) break;
        const allClear = stillPending.every((key) => {
          const item = attempt.items.find((i) => itemKey(i) === key);
          return item ? item.status === "succeeded" : attempt.status === "succeeded";
        });
        if (allClear) {
          for (const key of stillPending) {
            const pos = positions.get(key)!;
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
          break;
        }
      }
    }
  }

  return [...positions.values()];
}

export interface PipelineRunSummary {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentCount: number;
  componentsAtFinalStage: number;
}

export async function createPipelineRun(
  db: Pool,
  input: { pipelineId: string; title?: string; components: PipelineRunComponent[] }
): Promise<{ id: string }> {
  const pipeline = await getPipeline(db, input.pipelineId);
  if (!pipeline) throw new Error(`No pipeline with id ${input.pipelineId}`);
  if (pipeline.connectionIds.length < 2) throw new Error("Pipeline must have at least two connections to run");
  if (input.components.length === 0) throw new Error("A run needs at least one component");

  const id = randomUUID();
  await db.query(
    `INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, input.pipelineId, input.title ?? null, JSON.stringify(input.components), new Date().toISOString()]
  );
  return { id };
}

// Bulk-fetches every run's tagged deployments (plus their items) in two queries total, regardless
// of how many runs there are — the same N+1-avoidance pattern already used by listDeployments()
// for the History page.
async function loadStepDeploymentsByRun(
  db: Pool,
  runIds: string[]
): Promise<Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>> {
  const result = new Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>();
  if (runIds.length === 0) return result;

  const placeholders = runIds.map((_, i) => `$${i + 1}`).join(",");
  const deploymentRows = (
    await db.query(
      `SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, started_at, finished_at, error_detail FROM deployments WHERE pipeline_run_id IN (${placeholders}) ORDER BY pipeline_step_index ASC, started_at ASC`,
      runIds
    )
  ).rows;
  if (deploymentRows.length === 0) return result;

  const deploymentIds = deploymentRows.map((d) => d.id);
  const itemPlaceholders = deploymentIds.map((_, i) => `$${i + 1}`).join(",");
  const itemRows = (
    await db.query(
      `SELECT deployment_id, metadata_type, api_name, status FROM deployment_items WHERE deployment_id IN (${itemPlaceholders})`,
      deploymentIds
    )
  ).rows;
  const itemsByDeployment = new Map<string, StepDeploymentItem[]>();
  for (const item of itemRows) {
    const bucket = itemsByDeployment.get(item.deployment_id);
    const entry = { metadataType: item.metadata_type, apiName: item.api_name, status: item.status };
    if (bucket) bucket.push(entry);
    else itemsByDeployment.set(item.deployment_id, [entry]);
  }

  for (const row of deploymentRows) {
    const stepDeployment: StepDeployment & { id: string; startedAt: string; errorDetail: string | null } = {
      id: row.id,
      stepIndex: row.pipeline_step_index,
      status: row.status,
      validateOnly: !!row.validate_only,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorDetail: row.error_detail,
      items: itemsByDeployment.get(row.id) ?? [],
    };
    const bucket = result.get(row.pipeline_run_id);
    if (bucket) bucket.push(stepDeployment);
    else result.set(row.pipeline_run_id, [stepDeployment]);
  }
  return result;
}

export async function listPipelineRuns(db: Pool, pipelineId: string): Promise<PipelineRunSummary[]> {
  const pipeline = await getPipeline(db, pipelineId);
  // Tiebreak on ctid too: created_at has only millisecond resolution, so two runs created in
  // quick succession (e.g. back-to-back API calls, or in tests) can land on the identical
  // timestamp — without a tiebreaker, ORDER BY created_at DESC then returns tied rows in an
  // unspecified order. ctid is Postgres's physical-row-location pseudo-column, playing the same
  // "stable enough to break ties" role SQLite's rowid did.
  const runRows = (
    await db.query(
      `SELECT id, title, component_list, created_at FROM pipeline_runs WHERE pipeline_id = $1 ORDER BY created_at DESC, ctid DESC`,
      [pipelineId]
    )
  ).rows;
  const deploymentsByRun = await loadStepDeploymentsByRun(db, runRows.map((r) => r.id));
  const finalStage = pipeline ? pipeline.connectionIds.length - 1 : 0;
  const trackIndependently = pipeline?.trackComponentsIndependently ?? true;

  return runRows.map((row) => {
    const components: PipelineRunComponent[] = JSON.parse(row.component_list);
    const positions = deriveComponentPositions(components, deploymentsByRun.get(row.id) ?? [], trackIndependently);
    return {
      id: row.id,
      pipelineId,
      title: row.title,
      createdAt: row.created_at,
      componentCount: components.length,
      componentsAtFinalStage: positions.filter((p) => p.stage >= finalStage).length,
    };
  });
}

export interface PipelineRunDetail {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentList: PipelineRunComponent[];
  connectionIds: string[];
  trackComponentsIndependently: boolean;
  deployments: (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[];
  positions: ComponentPosition[];
}

export async function getPipelineRunDetail(db: Pool, runId: string): Promise<PipelineRunDetail | undefined> {
  const row = (await db.query(`SELECT * FROM pipeline_runs WHERE id = $1`, [runId])).rows[0];
  if (!row) return undefined;
  const pipeline = await getPipeline(db, row.pipeline_id);
  if (!pipeline) return undefined;

  const componentList: PipelineRunComponent[] = JSON.parse(row.component_list);
  const deployments = (await loadStepDeploymentsByRun(db, [runId])).get(runId) ?? [];
  const positions = deriveComponentPositions(componentList, deployments, pipeline.trackComponentsIndependently);

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    title: row.title,
    createdAt: row.created_at,
    componentList,
    connectionIds: pipeline.connectionIds,
    trackComponentsIndependently: pipeline.trackComponentsIndependently,
    deployments,
    positions,
  };
}

function actionForDiffStatus(status: "added" | "modified" | "removed" | "unchanged"): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

/**
 * Records components the hop's diff found already present and identical in both orgs as real,
 * already-succeeded deployment_items — even though they were never sent to Salesforce. See the
 * original SQLite-era comment in git history for the full rationale; behavior is unchanged.
 */
async function recordConfirmedUnchangedItems(db: Pool, deploymentId: string, components: PipelineRunComponent[]): Promise<void> {
  for (const c of components) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, 'modify', 'succeeded')`,
      [randomUUID(), deploymentId, c.type, c.fullName]
    );
  }
}

/**
 * Validates/deploys one hop of a pipeline run. Diffs only the components currently eligible for
 * this step (see deriveComponentPositions), creates a normal deployment tagged to the run/step,
 * and either runs it for real or — if the diff shows nothing actually needs to move — marks it
 * succeeded immediately without ever contacting Salesforce, so the derivation function still has
 * a tagged "this step was checked and cleared" record to read.
 */
export async function deployPipelineStep(
  db: Pool,
  config: Config,
  dataDir: string,
  runId: string,
  stepIndex: number,
  options: { validateOnly: boolean; runBy?: string | null }
): Promise<{ deploymentId: string; skipped: boolean }> {
  const run = await getPipelineRunDetail(db, runId);
  if (!run) throw new Error(`No pipeline run with id ${runId}`);
  if (stepIndex < 0 || stepIndex >= run.connectionIds.length - 1) {
    throw new Error(`step ${stepIndex} is out of range for a pipeline with ${run.connectionIds.length} stages`);
  }

  const eligible = run.positions.filter((p) => p.stage === stepIndex);
  if (eligible.length === 0) {
    throw new Error("No components are eligible for this step yet — they haven't succeeded the previous hop.");
  }

  if (run.deployments.some((d) => d.stepIndex === stepIndex && !TERMINAL_DEPLOYMENT_STATUSES.has(d.status))) {
    throw new Error("A deployment is already in progress for this step");
  }

  const sourceId = run.connectionIds[stepIndex];
  const targetId = run.connectionIds[stepIndex + 1];
  const types = [...new Set(eligible.map((c) => c.type))];
  const eligibleKeys = new Set(eligible.map((c) => `${c.type}::${c.fullName}`));

  const [source, target] = await Promise.all([
    resolveComponents(db, config, dataDir, sourceId, types),
    resolveComponents(db, config, dataDir, targetId, types),
  ]);
  const scopedDiff = diffComponents(source.components, target.components).filter((d) => eligibleKeys.has(`${d.type}::${d.fullName}`));
  const actionable = scopedDiff.filter((d) => d.status !== "unchanged");
  const confirmedUnchanged = scopedDiff.filter((d) => d.status === "unchanged").map((d) => ({ type: d.type, fullName: d.fullName }));
  const components: DeployComponentSelection[] = actionable.map((d) => ({
    type: d.type,
    fullName: d.fullName,
    action: actionForDiffStatus(d.status),
  }));

  const deploymentId = await createDraftDeployment(db, {
    title: run.title ? `${run.title} — step ${stepIndex + 1}` : `Pipeline step ${stepIndex + 1}`,
    sourceConnectionId: sourceId,
    targetConnectionId: targetId,
  });
  await tagDeploymentToPipelineStep(db, deploymentId, runId, stepIndex);

  if (components.length === 0) {
    await attachComponentsAndQueue(db, deploymentId, { components: [], testLevel: "NoTestRun", validateOnly: options.validateOnly });
    await recordConfirmedUnchangedItems(db, deploymentId, confirmedUnchanged);
    await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    return { deploymentId, skipped: true };
  }

  await attachComponentsAndQueue(db, deploymentId, { components, testLevel: "NoTestRun", validateOnly: options.validateOnly });
  await recordConfirmedUnchangedItems(db, deploymentId, confirmedUnchanged);
  await setRunBy(db, deploymentId, options.runBy ?? null);
  runDeployment(db, config, dataDir, deploymentId).catch((err) => {
    console.error(`Pipeline step deployment ${deploymentId} failed unexpectedly`, err);
  });

  return { deploymentId, skipped: false };
}
```

- [ ] **Step 2: Update `server/src/pipelines/pipelineRuns.test.ts`**

Apply the standard setup swap. Add `await` in front of every call to a now-async function from this file or `pipelines.ts`/`deploy.ts`.

- [ ] **Step 3: Run the tests**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: PASS. (This depends on `deploy.ts` being converted — if Task 9 hasn't landed yet, this file won't compile. Do Task 9 before this Step if executing out of order; otherwise this is already satisfied.)

- [ ] **Step 4: Commit**

```bash
git add server/src/pipelines/pipelineRuns.ts server/src/pipelines/pipelineRuns.test.ts
git commit -m "feat: convert pipelineRuns.ts to async pg"
```

---

## Task 8: Convert `server/src/engine/rollback.ts`

**Files:**
- Modify: `server/src/engine/rollback.ts`
- Modify: `server/src/engine/rollback.test.ts`

**Interfaces:**
- Consumes: `getDeployment(db: Pool, id): Promise<any>` (Task 9).
- Produces: `rollbackDeployment(db: Pool, config, deploymentId): Promise<string>` (already async, signature unchanged).

- [ ] **Step 1: Rewrite `server/src/engine/rollback.ts`**

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Pool } from "pg";
import { buildOrgConnection } from "./sfConnection.js";
import { deployZipToOrg } from "./deployPrimitive.js";
import { stripUnpackagedPrefix } from "./convert.js";
import { buildDestructiveChangesZip } from "./destructiveChanges.js";
import { getDeployment, type DeployComponentSelection } from "./deploy.js";
import type { Config } from "../config.js";

async function applyDeployResultToItems(
  db: Pool,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): Promise<void> {
  for (const cr of componentResults) {
    await db.query(
      `UPDATE deployment_items SET status = $1, error_message = $2 WHERE deployment_id = $3 AND metadata_type = $4 AND api_name = $5`,
      [cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName]
    );
  }
}

export async function rollbackDeployment(db: Pool, config: Config, deploymentId: string): Promise<string> {
  const original = await getDeployment(db, deploymentId);
  if (!original) throw new Error(`No deployment with id ${deploymentId}`);
  if (original.status !== "succeeded") {
    throw new Error(`Cannot roll back a deployment that did not succeed (status: ${original.status})`);
  }
  if (original.validate_only) {
    throw new Error("Cannot roll back a validate-only (dry run) deployment — it never changed the target");
  }
  if (original.target_connection_type !== "org") {
    throw new Error("Cannot roll back a deployment whose target is not an org connection");
  }

  const components: DeployComponentSelection[] = original.components;
  const existingComponents = components.filter((c) => c.action !== "add");
  const addedComponents = components.filter((c) => c.action === "add");

  const rollbackId = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, is_rollback_of)
     VALUES ($1, $2, $3, $4, $5, 'deploying', 0, $6, $7)`,
    [rollbackId, original.target_connection_id, original.target_connection_id, JSON.stringify(components), original.test_level, now, deploymentId]
  );

  for (const c of components) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), rollbackId, c.type, c.fullName, c.action === "add" ? "delete" : c.action]
    );
  }

  try {
    const targetConn = await buildOrgConnection(db, original.target_connection_id, config);

    if (existingComponents.length > 0) {
      if (!original.snapshot_path || !fs.existsSync(original.snapshot_path)) {
        throw new Error("No snapshot available to roll back to");
      }
      const snapshotZip = stripUnpackagedPrefix(fs.readFileSync(original.snapshot_path));
      const result = await deployZipToOrg(targetConn, snapshotZip, { testLevel: original.test_level, checkOnly: false });
      await applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deploy of prior versions failed");
    }

    if (addedComponents.length > 0) {
      const destructiveZip = buildDestructiveChangesZip(addedComponents);
      const result = await deployZipToOrg(targetConn, destructiveZip, { testLevel: original.test_level, checkOnly: false });
      await applyDeployResultToItems(db, rollbackId, result.componentResults);
      if (!result.success) throw new Error("Rollback deletion of newly added components failed");
    }

    await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), rollbackId]);
    await db.query(`UPDATE deployments SET status = 'rolled_back' WHERE id = $1`, [deploymentId]);
  } catch (err) {
    await db.query(
      `UPDATE deployments SET status = 'failed', finished_at = $1, error_detail = $2 WHERE id = $3`,
      [new Date().toISOString(), JSON.stringify({ message: (err as Error).message }), rollbackId]
    );
    throw err;
  }

  return rollbackId;
}
```

- [ ] **Step 2: Update `server/src/engine/rollback.test.ts`**

Apply the standard setup swap; add `await` in front of `rollbackDeployment(...)` calls (already async, so this is likely already present — verify) and any direct `db.prepare(...)`/query calls the test makes to set up fixture rows.

- [ ] **Step 3: Run the tests**

Run: `cd server && npx vitest run src/engine/rollback.test.ts`
Expected: PASS (depends on Task 9's `deploy.ts` being converted first, since `rollback.ts` imports `getDeployment` from it).

- [ ] **Step 4: Commit**

```bash
git add server/src/engine/rollback.ts server/src/engine/rollback.test.ts
git commit -m "feat: convert rollback.ts to async pg"
```

---

## Task 9: Convert `server/src/engine/deploy.ts`

The largest and most critical file — 44 query call sites across every deployment lifecycle function. Do this task in one sitting; the functions call each other within the file, so a half-converted state won't compile.

**Files:**
- Modify: `server/src/engine/deploy.ts`
- Modify: `server/src/engine/deploy.test.ts`

**Interfaces:**
- Consumes: `getConnectionRow(db: Pool, id): Promise<any>` (Task 5).
- Produces (every one of these is now `async`, wrapping its previous return type in `Promise`): `createDraftDeployment`, `attachComponentsAndQueue`, `updateDeploymentTitle`, `setRunBy`, `scheduleDeployment`, `cancelSchedule`, `tagDeploymentToPipelineStep`, `deleteDeployment`, `cloneDeployment`, `cancelDeployment` (already async), `listDueScheduledDeployments`, `getDeployment`, `listDeployments`, `resolvePackageDir` (pure function — unchanged, still synchronous), `runDeployment` (already async).

- [ ] **Step 1: Rewrite `server/src/engine/deploy.ts`**

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { getConnectionRow } from "../connections/orgConnections.js";
import { ensureLocalClone, commitAllAndPush } from "../connections/gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import { buildOrgConnection } from "./sfConnection.js";
import { retrieveOrgZip } from "./orgComponents.js";
import { convertZipToSourceDir, convertSourceDirToZip, stripUnpackagedPrefix } from "./convert.js";
import { deployZipToOrg, type DeployProgress, type DeployResult } from "./deployPrimitive.js";
import { buildDestructiveChangesZip } from "./destructiveChanges.js";
import { rollbackDeployment } from "./rollback.js";
import { analyzeApexZip } from "./staticAnalysis.js";
import type { Config } from "../config.js";

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

/**
 * Creates the deployment record before any components are chosen — a source, a target, and an
 * optional title, so it exists (and can be Saved/committed to) before the user works through the
 * diff to pick what to actually deploy. Starts empty and 'pending'; attachComponentsAndQueue fills
 * in the rest once components are chosen.
 */
export async function createDraftDeployment(
  db: Pool,
  input: {
    title?: string;
    sourceConnectionId: string;
    targetConnectionId: string;
    sourceBranch?: string | null;
    targetBranch?: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO deployments (id, title, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, source_branch, target_branch)
     VALUES ($1, $2, $3, $4, '[]', 'NoTestRun', 'pending', 0, $5, $6, $7)`,
    [id, input.title ?? null, input.sourceConnectionId, input.targetConnectionId, now, input.sourceBranch ?? null, input.targetBranch ?? null]
  );
  return id;
}

/**
 * Attaches the chosen components/options to an existing draft, ready for runDeployment.
 *
 * Replaces (rather than appends to) any components already attached, so this is safe to call
 * repeatedly as the user's selection changes while still editing a draft — e.g. autosaving as
 * they check/uncheck components — without piling up stale deployment_items rows.
 */
export async function attachComponentsAndQueue(
  db: Pool,
  id: string,
  input: {
    components: DeployComponentSelection[];
    testLevel: TestLevel;
    validateOnly: boolean;
    ignoreWarnings?: boolean;
    allowMissingFiles?: boolean;
    autoUpdatePackage?: boolean;
    runTests?: string[];
  }
): Promise<void> {
  const targetIdRow = (await db.query(`SELECT target_connection_id FROM deployments WHERE id = $1`, [id])).rows[0];
  const targetRow = await getConnectionRow(db, targetIdRow.target_connection_id);
  const effectiveTestLevel: TestLevel =
    targetRow?.type === "org" && targetRow.org_type === "production" && input.testLevel === "NoTestRun"
      ? "RunLocalTests"
      : input.testLevel;

  await db.query(
    `UPDATE deployments
     SET component_list = $1, test_level = $2, validate_only = $3, ignore_warnings = $4, allow_missing_files = $5, auto_update_package = $6, run_tests = $7
     WHERE id = $8`,
    [
      JSON.stringify(input.components),
      effectiveTestLevel,
      input.validateOnly ? 1 : 0,
      input.ignoreWarnings ? 1 : 0,
      input.allowMissingFiles ? 1 : 0,
      input.autoUpdatePackage ? 1 : 0,
      JSON.stringify(input.runTests ?? []),
      id,
    ]
  );

  await db.query(`DELETE FROM deployment_items WHERE deployment_id = $1`, [id]);
  for (const c of input.components) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), id, c.type, c.fullName, c.action]
    );
  }
}

/** Renames a deployment. Allowed at any status — the title is just a label, not part of what runs. */
export async function updateDeploymentTitle(db: Pool, id: string, title: string | null): Promise<void> {
  const row = (await db.query(`SELECT id FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  await db.query(`UPDATE deployments SET title = $1 WHERE id = $2`, [title, id]);
}

/**
 * Labels who triggered a run — a self-reported display name from the browser (see
 * web/src/displayName.ts), not an authenticated identity. There's no login system here, so this
 * is attribution/bookkeeping only, not access control: anyone using that browser can type any
 * name. Set at run time (not draft-save time), since it describes who actually ran it.
 */
export async function setRunBy(db: Pool, id: string, runBy: string | null): Promise<void> {
  await db.query(`UPDATE deployments SET run_by = $1 WHERE id = $2`, [runBy, id]);
}

/**
 * Schedules a pending draft to run automatically at a future time — see scheduler.ts, which polls
 * for deployments due to fire. runBy is captured now (not at fire time, when nobody is present)
 * since it's the same self-reported attribution setRunBy always was.
 */
export async function scheduleDeployment(db: Pool, id: string, scheduledAt: string, runBy: string | null): Promise<void> {
  const row: any = (await db.query(`SELECT status FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  if (row.status !== "pending") throw new Error(`Only a pending draft can be scheduled (status: ${row.status})`);
  await db.query(`UPDATE deployments SET scheduled_at = $1, run_by = $2 WHERE id = $3`, [scheduledAt, runBy, id]);
}

/** Cancels a pending schedule — the draft itself is untouched and can be run manually or rescheduled. */
export async function cancelSchedule(db: Pool, id: string): Promise<void> {
  const row: any = (await db.query(`SELECT status, scheduled_at FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  if (row.status !== "pending" || !row.scheduled_at) throw new Error("This deployment isn't currently scheduled");
  await db.query(`UPDATE deployments SET scheduled_at = NULL WHERE id = $1`, [id]);
}

/** Marks a deployment as belonging to a specific hop of a pipeline run — see pipelineRuns.ts. */
export async function tagDeploymentToPipelineStep(db: Pool, deploymentId: string, pipelineRunId: string, stepIndex: number): Promise<void> {
  await db.query(`UPDATE deployments SET pipeline_run_id = $1, pipeline_step_index = $2 WHERE id = $3`, [pipelineRunId, stepIndex, deploymentId]);
}

/** Permanently removes a deployment and its per-component items. */
export async function deleteDeployment(db: Pool, id: string): Promise<void> {
  const row = (await db.query(`SELECT id FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!row) throw new Error(`No deployment with id ${id}`);
  await db.query(`DELETE FROM deployment_items WHERE deployment_id = $1`, [id]);
  await db.query(`DELETE FROM deployments WHERE id = $1`, [id]);
}

/**
 * Duplicates a deployment (any status, including a finished one) into a fresh 'pending' draft
 * with the same source, target, title, and components — ready to review and run again, e.g. to
 * redeploy the same set to another window or retry after fixing something outside SFCowboy.
 */
export async function cloneDeployment(db: Pool, id: string): Promise<string> {
  const original: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!original) throw new Error(`No deployment with id ${id}`);

  const newId = randomUUID();
  const now = new Date().toISOString();
  // package_path is deliberately NOT carried over — cloning re-resolves fresh content from the
  // source connection at run time (or waits for a fresh import), rather than reusing whatever
  // zip the original happened to have on disk.
  await db.query(
    `INSERT INTO deployments (
       id, title, source_connection_id, target_connection_id, component_list, test_level, status,
       validate_only, ignore_warnings, allow_missing_files, auto_update_package, run_tests, started_at,
       source_branch, target_branch
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      newId,
      original.title,
      original.source_connection_id,
      original.target_connection_id,
      original.component_list,
      original.test_level,
      original.validate_only,
      original.ignore_warnings,
      original.allow_missing_files,
      original.auto_update_package,
      original.run_tests,
      now,
      original.source_branch,
      original.target_branch,
    ]
  );

  const items: any[] = (await db.query(`SELECT * FROM deployment_items WHERE deployment_id = $1`, [id])).rows;
  for (const item of items) {
    await db.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [randomUUID(), newId, item.metadata_type, item.api_name, item.action]
    );
  }

  return newId;
}

/**
 * Cancels an in-progress deployment. Only meaningful once Salesforce has actually accepted the
 * async job (sf_job_id is set) and the deployment hasn't already finished — cancelDeploy on a
 * completed job has nothing left to cancel.
 */
export async function cancelDeployment(db: Pool, config: Config, id: string): Promise<void> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!deployment) throw new Error(`No deployment with id ${id}`);
  if (deployment.status !== "validating" && deployment.status !== "deploying") {
    throw new Error("Only an in-progress deployment can be cancelled");
  }
  if (!deployment.sf_job_id) {
    throw new Error("The deployment hasn't reached Salesforce yet — nothing to cancel");
  }
  const targetConn: any = await buildOrgConnection(db, deployment.target_connection_id, config);
  await targetConn.metadata.cancelDeploy(deployment.sf_job_id);
}

/** Every pending deployment scheduled to have already fired by `asOf` — see scheduler.ts. */
export async function listDueScheduledDeployments(db: Pool, asOf: Date): Promise<string[]> {
  const rows = (
    await db.query(`SELECT id FROM deployments WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= $1`, [asOf.toISOString()])
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

export async function getDeployment(db: Pool, id: string): Promise<any> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [id])).rows[0];
  if (!deployment) return undefined;
  const items = (await db.query(`SELECT * FROM deployment_items WHERE deployment_id = $1`, [id])).rows;
  // The target's connection type travels with the detail payload so callers (the rollback guard
  // and the UI's Roll back button) can tell an org target from a git one without a second lookup.
  const targetRow = await getConnectionRow(db, deployment.target_connection_id);
  return {
    ...deployment,
    components: JSON.parse(deployment.component_list),
    run_tests: JSON.parse(deployment.run_tests),
    items,
    target_connection_type: targetRow?.type ?? null,
  };
}

/**
 * Attaches each deployment's own items in one bulk query rather than one query per row — the
 * History page needs every run's component list, and fetching that per-deployment would turn a
 * single page load into an N+1 (see listOrgComponents' batching fix for the same class of bug).
 */
export async function listDeployments(db: Pool): Promise<any[]> {
  const deployments: any[] = (await db.query(`SELECT * FROM deployments ORDER BY started_at DESC`)).rows;
  if (deployments.length === 0) return deployments;

  const placeholders = deployments.map((_, i) => `$${i + 1}`).join(",");
  const items: any[] = (
    await db.query(`SELECT * FROM deployment_items WHERE deployment_id IN (${placeholders})`, deployments.map((d) => d.id))
  ).rows;

  const itemsByDeployment = new Map<string, any[]>();
  for (const item of items) {
    const bucket = itemsByDeployment.get(item.deployment_id);
    if (bucket) bucket.push(item);
    else itemsByDeployment.set(item.deployment_id, [item]);
  }

  return deployments.map((d) => ({ ...d, items: itemsByDeployment.get(d.id) ?? [] }));
}

async function applyDeployResultToItems(
  db: Pool,
  deploymentId: string,
  componentResults: { type: string; fullName: string; success: boolean; errorMessage?: string }[]
): Promise<void> {
  for (const cr of componentResults) {
    await db.query(
      `UPDATE deployment_items SET status = $1, error_message = $2 WHERE deployment_id = $3 AND metadata_type = $4 AND api_name = $5`,
      [cr.success ? "succeeded" : "failed", cr.errorMessage ?? null, deploymentId, cr.type, cr.fullName]
    );
  }
}

/**
 * A failed DeployResult's componentResults array includes every component Salesforce touched —
 * successes and failures alike — plus job bookkeeping (jobId/status). Dumping that whole object
 * as error_detail means the UI ends up rendering the raw API payload instead of a reason. This
 * reduces one or more DeployResults down to a short, human-readable line naming just what broke.
 * Pure function — unchanged.
 */
function summarizeDeployFailure(results: DeployResult[]): string {
  const failedComponents = results.flatMap((r) => r.componentResults.filter((c) => !c.success));
  if (failedComponents.length === 0) {
    return `Deploy failed (status: ${results[0]?.status ?? "unknown"})`;
  }
  return failedComponents.map((c) => `${c.type}.${c.fullName}: ${c.errorMessage ?? "failed"}`).join("; ");
}

/**
 * Resolves the package directory a git target's source should be written into. Pure
 * filesystem-reading function — no database access, unchanged from the SQLite version.
 */
export function resolvePackageDir(cloneDir: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cloneDir, "sfdx-project.json"), "utf-8"));
    const dirs: unknown = parsed?.packageDirectories;
    if (Array.isArray(dirs)) {
      const usable = dirs.filter((d: any) => d && typeof d.path === "string" && d.path.length > 0);
      const chosen = usable.find((d: any) => d.default) ?? usable[0];
      if (chosen) return chosen.path as string;
    }
  } catch {
    // Missing or unreadable sfdx-project.json — fall through to the SFDX default.
  }
  return "force-app";
}

async function markPendingItemsSucceeded(db: Pool, deploymentId: string, components: DeployComponentSelection[]): Promise<void> {
  for (const c of components) {
    await db.query(
      `UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1 AND metadata_type = $2 AND api_name = $3 AND status = 'pending'`,
      [deploymentId, c.type, c.fullName]
    );
  }
}

export async function runDeployment(db: Pool, config: Config, dataDir: string, deploymentId: string): Promise<void> {
  const deployment: any = (await db.query(`SELECT * FROM deployments WHERE id = $1`, [deploymentId])).rows[0];
  const components: DeployComponentSelection[] = JSON.parse(deployment.component_list);
  const targetRow = await getConnectionRow(db, deployment.target_connection_id);

  const contentComponents = components.filter((c) => c.action !== "delete");
  const deleteComponents = components.filter((c) => c.action === "delete");

  try {
    if (deleteComponents.length > 0 && targetRow.type !== "org") {
      throw new Error("Deleting components is only supported for org targets");
    }

    await db.query(`UPDATE deployments SET status = 'validating' WHERE id = $1`, [deploymentId]);

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
    await db.query(`UPDATE deployments SET snapshot_path = $1 WHERE id = $2`, [snapshotPath, deploymentId]);

    const packagePath: string = deployment.package_path ?? path.join(dataDir, "packages", `${deploymentId}.zip`);
    let zip: Buffer | null = null;
    if (deployment.package_path && fs.existsSync(deployment.package_path)) {
      zip = fs.readFileSync(deployment.package_path);
    } else if (contentComponents.length > 0) {
      const sourceRow = await getConnectionRow(db, deployment.source_connection_id);
      if (sourceRow.type === "org") {
        const sourceConn = await buildOrgConnection(db, deployment.source_connection_id, config);
        zip = stripUnpackagedPrefix(await retrieveOrgZip(sourceConn, contentComponents));
      } else {
        const sourceDir = await ensureLocalClone({
          dataDir,
          connectionId: deployment.source_connection_id,
          remoteUrl: sourceRow.remote_url,
          branch: deployment.source_branch ?? sourceRow.default_branch,
          authToken: decrypt(sourceRow.encrypted_auth_token),
        });
        zip = await convertSourceDirToZip(sourceDir, contentComponents);
      }
      if (zip) {
        fs.mkdirSync(path.dirname(packagePath), { recursive: true });
        fs.writeFileSync(packagePath, zip);
        await db.query(`UPDATE deployments SET package_path = $1 WHERE id = $2`, [packagePath, deploymentId]);
      }
    }

    if (zip) {
      const findings = analyzeApexZip(zip);
      await db.query(`UPDATE deployments SET static_analysis_findings = $1 WHERE id = $2`, [
        findings.length > 0 ? JSON.stringify(findings) : null,
        deploymentId,
      ]);
    }

    await db.query(`UPDATE deployments SET status = 'deploying' WHERE id = $1`, [deploymentId]);

    if (targetRow.type === "org") {
      const targetConn = await buildOrgConnection(db, deployment.target_connection_id, config);
      const checkOnly = !!deployment.validate_only;
      const deployOptions = {
        testLevel: deployment.test_level,
        checkOnly,
        ignoreWarnings: !!deployment.ignore_warnings,
        allowMissingFiles: !!deployment.allow_missing_files,
        autoUpdatePackage: !!deployment.auto_update_package,
        runTests: JSON.parse(deployment.run_tests) as string[],
      };
      const failures: unknown[] = [];
      let cancelled = false;
      let coverageResult: Pick<DeployResult, "coveragePercent" | "codeCoverage"> | undefined;
      const onProgress = (p: DeployProgress) => {
        void db.query(
          `UPDATE deployments SET sf_job_id = $1, components_deployed = $2, components_total = $3, tests_completed = $4, tests_total = $5 WHERE id = $6`,
          [p.jobId, p.numberComponentsDeployed, p.numberComponentsTotal, p.numberTestsCompleted, p.numberTestsTotal, deploymentId]
        );
      };
      const noteIfCancelled = (result: DeployResult) => {
        if (result.status === "Canceled") cancelled = true;
      };
      const noteCoverage = (result: DeployResult) => {
        if (result.coveragePercent !== undefined) coverageResult = result;
      };

      if (zip) {
        const result = await deployZipToOrg(targetConn, zip, deployOptions, undefined, undefined, onProgress);
        await applyDeployResultToItems(db, deploymentId, result.componentResults);
        noteIfCancelled(result);
        noteCoverage(result);
        if (!result.success) failures.push(result);
      }

      if (deleteComponents.length > 0) {
        const destructiveZip = buildDestructiveChangesZip(deleteComponents);
        const result = await deployZipToOrg(targetConn, destructiveZip, deployOptions, undefined, undefined, onProgress);
        await applyDeployResultToItems(db, deploymentId, result.componentResults);
        noteIfCancelled(result);
        noteCoverage(result);
        if (result.success) {
          await markPendingItemsSucceeded(db, deploymentId, deleteComponents);
        } else {
          failures.push(result);
        }
      }

      const success = failures.length === 0;
      await db.query(`UPDATE deployments SET coverage_percent = $1, coverage_details = $2 WHERE id = $3`, [
        coverageResult?.coveragePercent ?? null,
        coverageResult?.codeCoverage ? JSON.stringify(coverageResult.codeCoverage) : null,
        deploymentId,
      ]);

      const minCoverage = targetRow.min_code_coverage_percent as number | null;
      const gateFailed =
        success && !cancelled && minCoverage != null && coverageResult?.coveragePercent !== undefined && coverageResult.coveragePercent < minCoverage;
      const coverageMessage = gateFailed
        ? `Coverage gate: ${coverageResult!.coveragePercent!.toFixed(1)}% is below the required ${minCoverage}% minimum for this connection.`
        : null;

      if (gateFailed && checkOnly) {
        await db.query(`UPDATE deployments SET status = 'failed', finished_at = $1, error_detail = $2 WHERE id = $3`, [
          new Date().toISOString(),
          JSON.stringify({ message: coverageMessage }),
          deploymentId,
        ]);
      } else if (gateFailed) {
        await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
        try {
          await rollbackDeployment(db, config, deploymentId);
          await db.query(`UPDATE deployments SET error_detail = $1 WHERE id = $2`, [JSON.stringify({ message: coverageMessage }), deploymentId]);
        } catch (rollbackErr) {
          await db.query(`UPDATE deployments SET error_detail = $1 WHERE id = $2`, [
            JSON.stringify({ message: `${coverageMessage} Automatic rollback also failed: ${(rollbackErr as Error).message}` }),
            deploymentId,
          ]);
        }
      } else {
        await db.query(`UPDATE deployments SET status = $1, finished_at = $2, error_detail = $3 WHERE id = $4`, [
          cancelled ? "cancelled" : success ? "succeeded" : "failed",
          new Date().toISOString(),
          success || cancelled ? null : JSON.stringify({ message: summarizeDeployFailure(failures as DeployResult[]) }),
          deploymentId,
        ]);
      }
    } else {
      const targetDir = await ensureLocalClone({
        dataDir,
        connectionId: deployment.target_connection_id,
        remoteUrl: targetRow.remote_url,
        branch: deployment.target_branch ?? targetRow.default_branch,
        authToken: decrypt(targetRow.encrypted_auth_token),
      });
      if (zip) {
        await convertZipToSourceDir(zip, path.join(targetDir, resolvePackageDir(targetDir)));
      }
      await commitAllAndPush({
        dataDir,
        connectionId: deployment.target_connection_id,
        message: `SFCowboy deployment ${deploymentId}`,
        authToken: decrypt(targetRow.encrypted_auth_token),
      });
      await db.query(`UPDATE deployment_items SET status = 'succeeded' WHERE deployment_id = $1`, [deploymentId]);
      await db.query(`UPDATE deployments SET status = 'succeeded', finished_at = $1 WHERE id = $2`, [new Date().toISOString(), deploymentId]);
    }
  } catch (err) {
    await db.query(`UPDATE deployments SET status = 'failed', finished_at = $1, error_detail = $2 WHERE id = $3`, [
      new Date().toISOString(),
      JSON.stringify({ message: (err as Error).message }),
      deploymentId,
    ]);
  }
}
```

Note the one behavioral wrinkle called out inline: `onProgress` (the live-progress callback passed into `deployZipToOrg`) was synchronous and fire-and-forget under `better-sqlite3` by construction (every call was synchronous). Under `pg` it's still fire-and-forget — deliberately `void db.query(...)` rather than `await`, so progress updates never block or reorder the deploy call itself — but a query error inside it would now be an unhandled rejection instead of a synchronous throw. This is an accepted, deliberate behavior difference (progress bookkeeping failing silently is preferable to it interrupting a live deploy) — flag it in code review, but do not change it without discussing first.

- [ ] **Step 2: Update `server/src/engine/deploy.test.ts`**

Apply the standard setup swap from Task 2. Every call to a function from this task's Interfaces list needs `await` added — this file has the most such call sites of any test file in the codebase (mirrors the 44 in the source file). Work through it function-by-function; there is no shortcut here given the file's size.

- [ ] **Step 3: Run the tests**

Run: `cd server && npx vitest run src/engine/deploy.test.ts`
Expected: PASS (all tests from the existing suite, unchanged assertions).

- [ ] **Step 4: Run the full server suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: every test file converted so far (Tasks 2-9) passes; any file not yet touched by this plan (routes files, migration script — not yet written) still fails or doesn't compile. Confirm no NEW failures beyond what's expected from not-yet-done tasks.

- [ ] **Step 5: Commit**

```bash
git add server/src/engine/deploy.ts server/src/engine/deploy.test.ts
git commit -m "feat: convert deploy.ts to async pg"
```

---

## Task 10: Update the 4 route files for async propagation

**Files:**
- Modify: `server/src/auth/routes.ts`
- Modify: `server/src/connections/routes.ts`
- Modify: `server/src/engine/routes.ts`
- Modify: `server/src/pipelines/routes.ts`
- Modify: `server/src/connections/routes.test.ts`
- Modify: `server/src/engine/routes.test.ts`
- Modify: `server/src/pipelines/routes.test.ts`
- Modify: `server/src/auth/routes.test.ts`

No SQL in any of these four files changes — every domain function they call was already converted in Tasks 4-9. The only change is: any route handler that calls one of those domain functions becomes `async (req, res) => { ... }`, and every call gets `await`. Every one of these route handlers already returns `void` (they call `res.json(...)`/`res.send(...)` rather than `return`ing a value), so making a handler `async` changes nothing about its external behavior — Express doesn't care whether a handler returns `undefined` or `Promise<undefined>`.

- [ ] **Step 1: Rewrite `server/src/auth/routes.ts`**

```ts
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { generateCodeVerifier, generateCodeChallenge, buildAuthorizationUrl, exchangeCodeForToken } from "./oauth.js";
import { createOrgConnection, reauthorizeOrgConnection, getConnectionRow } from "../connections/orgConnections.js";
import type { Config } from "../config.js";

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

interface PendingAuth {
  orgType: "sandbox" | "production";
  codeVerifier: string;
  loginUrl: string;
  createdAt: number;
  nickname?: string;
  reauthorizeConnectionId?: string;
}

export function createAuthRouter(db: Pool, config: Config): Router {
  const router = Router();
  const pending = new Map<string, PendingAuth>();

  function loginUrlFor(orgType: "sandbox" | "production"): string {
    return orgType === "sandbox" ? "https://test.salesforce.com" : "https://login.salesforce.com";
  }

  router.post("/api/connections/org/authorize", async (req, res) => {
    const body = req.body as { nickname?: unknown; orgType?: unknown; connectionId?: unknown };

    let orgType: "sandbox" | "production";
    let nickname: string | undefined;
    let reauthorizeConnectionId: string | undefined;

    if (body.connectionId !== undefined) {
      if (typeof body.connectionId !== "string" || body.connectionId === "") {
        res.status(400).json({ error: "connectionId must be a non-empty string" });
        return;
      }
      const row = await getConnectionRow(db, body.connectionId);
      if (!row || row.type !== "org") {
        res.status(404).json({ error: "org connection not found" });
        return;
      }
      orgType = row.org_type;
      reauthorizeConnectionId = body.connectionId;
    } else {
      if (!body.nickname || typeof body.nickname !== "string") {
        res.status(400).json({ error: "nickname is required" });
        return;
      }
      if (body.orgType !== "sandbox" && body.orgType !== "production") {
        res.status(400).json({ error: "orgType must be 'sandbox' or 'production'" });
        return;
      }
      nickname = body.nickname;
      orgType = body.orgType;
    }

    const state = randomUUID();
    const codeVerifier = generateCodeVerifier();
    const loginUrl = loginUrlFor(orgType);
    pending.set(state, { nickname, orgType, codeVerifier, loginUrl, createdAt: Date.now(), reauthorizeConnectionId });

    const authorizeUrl = buildAuthorizationUrl({
      loginUrl,
      clientId: config.sfClientId,
      redirectUri: config.oauthCallbackUrl,
      state,
      codeChallenge: generateCodeChallenge(codeVerifier),
    });

    res.json({ authorizeUrl });
  });

  router.get("/oauth/callback", async (req, res) => {
    const { code, state, error: sfError } = req.query as { code?: string; state?: string; error?: string };

    if (!state || !pending.has(state)) {
      res.redirect("/connections?error=" + encodeURIComponent("The connection attempt expired or was invalid. Please try again."));
      return;
    }

    const entry = pending.get(state)!;
    pending.delete(state);

    if (sfError || !code || Date.now() - entry.createdAt > PENDING_AUTH_TTL_MS) {
      res.redirect("/connections?error=" + encodeURIComponent("Salesforce did not authorize the connection. Please try again."));
      return;
    }

    try {
      const tokens = await exchangeCodeForToken({
        loginUrl: entry.loginUrl,
        code,
        clientId: config.sfClientId,
        redirectUri: config.oauthCallbackUrl,
        codeVerifier: entry.codeVerifier,
      });

      if (entry.reauthorizeConnectionId) {
        await reauthorizeOrgConnection(db, entry.reauthorizeConnectionId, {
          instanceUrl: tokens.instanceUrl,
          refreshToken: tokens.refreshToken,
          username: tokens.username,
        });
        res.redirect("/connections?reconnected=1");
        return;
      }

      await createOrgConnection(db, {
        nickname: entry.nickname!,
        orgType: entry.orgType,
        instanceUrl: tokens.instanceUrl,
        refreshToken: tokens.refreshToken,
        clientId: config.sfClientId,
        username: tokens.username,
      });

      res.redirect("/connections?connected=1");
    } catch (err) {
      console.error("Salesforce org authorization failed", err);
      res.redirect("/connections?error=" + encodeURIComponent("Could not connect to Salesforce. Please try again."));
    }
  });

  return router;
}
```

- [ ] **Step 2: Rewrite `server/src/connections/routes.ts`**

```ts
import { Router } from "express";
import type { Pool } from "pg";
import {
  listConnections,
  getConnectionSummary,
  deleteConnection,
  getConnectionRow,
  renameConnection,
  setMinCodeCoveragePercent,
  testOrgConnection,
} from "./orgConnections.js";
import { createGitConnection, testGitConnection } from "./gitConnections.js";
import { decrypt } from "../crypto/encryption.js";
import type { Config } from "../config.js";

export function createConnectionsRouter(db: Pool, config: Config): Router {
  const router = Router();

  router.get("/api/connections", async (_req, res) => {
    res.json(await listConnections(db));
  });

  router.get("/api/connections/:id", async (req, res) => {
    const connection = await getConnectionSummary(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    res.json(connection);
  });

  router.patch("/api/connections/:id", async (req, res) => {
    const connection = await getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    const { nickname, minCodeCoveragePercent } = req.body as { nickname?: unknown; minCodeCoveragePercent?: unknown };
    if (typeof nickname !== "string" || !nickname.trim()) {
      res.status(400).json({ error: "nickname is required and must be a non-empty string" });
      return;
    }
    if (minCodeCoveragePercent !== undefined && minCodeCoveragePercent !== null && typeof minCodeCoveragePercent !== "number") {
      res.status(400).json({ error: "minCodeCoveragePercent must be a number or null when provided" });
      return;
    }
    try {
      await renameConnection(db, req.params.id, nickname);
      if (minCodeCoveragePercent !== undefined) {
        await setMinCodeCoveragePercent(db, req.params.id, minCodeCoveragePercent);
      }
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.json({ id: req.params.id });
  });

  router.post("/api/connections/:id/test", async (req, res) => {
    const connection = await getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    const result =
      connection.type === "org"
        ? await testOrgConnection(db, config, req.params.id)
        : await testGitConnection({
            remoteUrl: connection.remote_url,
            authToken: connection.encrypted_auth_token ? decrypt(connection.encrypted_auth_token) : undefined,
          });
    res.json(result);
  });

  router.post("/api/connections/git", async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "request body must be a JSON object" });
      return;
    }
    const { nickname, remoteUrl, defaultBranch, authToken } = body as Record<string, unknown>;
    for (const [field, value] of Object.entries({ nickname, remoteUrl, defaultBranch, authToken })) {
      if (typeof value !== "string" || value === "") {
        res.status(400).json({ error: `${field} is required and must be a non-empty string` });
        return;
      }
    }
    const connection = await createGitConnection(db, {
      nickname: nickname as string,
      remoteUrl: remoteUrl as string,
      defaultBranch: defaultBranch as string,
      authToken: authToken as string,
    });
    res.status(201).json(connection);
  });

  router.delete("/api/connections/:id", async (req, res) => {
    const connection = await getConnectionRow(db, req.params.id);
    if (!connection) {
      res.status(404).json({ error: "connection not found" });
      return;
    }
    await deleteConnection(db, req.params.id);
    res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 3: Rewrite `server/src/pipelines/routes.ts`**

```ts
import { Router } from "express";
import type { Pool } from "pg";
import { createPipeline, listPipelines, updatePipeline, deletePipeline, getPipeline, setPipelineStatus, pipelineHasRuns } from "./pipelines.js";
import type { Config } from "../config.js";
import { createPipelineRun, listPipelineRuns, getPipelineRunDetail, deployPipelineStep } from "./pipelineRuns.js";

function validatePipelineBody(
  body: unknown
): { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { name, connectionIds, trackComponentsIndependently } = body as {
    name?: unknown;
    connectionIds?: unknown;
    trackComponentsIndependently?: unknown;
  };
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required and must be a non-empty string" };
  if (!Array.isArray(connectionIds) || connectionIds.some((id) => typeof id !== "string")) {
    return { error: "connectionIds is required and must be an array of strings" };
  }
  if (trackComponentsIndependently !== undefined && typeof trackComponentsIndependently !== "boolean") {
    return { error: "trackComponentsIndependently must be a boolean when provided" };
  }
  return { name, connectionIds: connectionIds as string[], trackComponentsIndependently: trackComponentsIndependently as boolean | undefined };
}

export function createPipelinesRouter(db: Pool, config: Config, dataDir: string): Router {
  const router = Router();

  router.post("/api/pipelines", async (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const pipeline = await createPipeline(db, validated);
    res.status(201).json(pipeline);
  });

  router.get("/api/pipelines", async (_req, res) => {
    res.json(await listPipelines(db));
  });

  router.get("/api/pipelines/:id", async (req, res) => {
    const pipeline = await getPipeline(db, req.params.id);
    if (!pipeline) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.json(pipeline);
  });

  router.put("/api/pipelines/:id", async (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { name, connectionIds, trackComponentsIndependently } = validated;
    const existing = await getPipeline(db, req.params.id);
    if (!existing) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    const connectionsChanged = JSON.stringify(existing.connectionIds) !== JSON.stringify(connectionIds);
    if (connectionsChanged && (await pipelineHasRuns(db, req.params.id))) {
      res.status(409).json({ error: "This pipeline has run history, so its connections can't be changed" });
      return;
    }
    const updated = await updatePipeline(db, req.params.id, { name, connectionIds, trackComponentsIndependently });
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(await getPipeline(db, req.params.id));
  });

  router.patch("/api/pipelines/:id/status", async (req, res) => {
    const { status } = req.body as { status?: unknown };
    if (status !== "active" && status !== "closed") {
      res.status(400).json({ error: "status is required and must be 'active' or 'closed'" });
      return;
    }
    const updated = await setPipelineStatus(db, req.params.id, status);
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(await getPipeline(db, req.params.id));
  });

  router.delete("/api/pipelines/:id", async (req, res) => {
    if (await pipelineHasRuns(db, req.params.id)) {
      res.status(409).json({ error: "This pipeline has runs and can't be deleted" });
      return;
    }
    const deleted = await deletePipeline(db, req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(204).send();
  });

  router.post("/api/pipelines/:id/runs", async (req, res) => {
    const body = req.body as { title?: unknown; components?: unknown };
    if (
      !Array.isArray(body.components) ||
      body.components.some((c) => typeof c !== "object" || c === null || typeof (c as any).type !== "string" || typeof (c as any).fullName !== "string")
    ) {
      res.status(400).json({ error: "components is required and must be an array of { type, fullName }" });
      return;
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string when provided" });
      return;
    }
    try {
      const run = await createPipelineRun(db, {
        pipelineId: req.params.id,
        title: body.title as string | undefined,
        components: body.components as { type: string; fullName: string }[],
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/pipelines/:id/runs", async (req, res) => {
    res.json(await listPipelineRuns(db, req.params.id));
  });

  router.get("/api/pipeline-runs/:runId", async (req, res) => {
    const detail = await getPipelineRunDetail(db, req.params.runId);
    if (!detail) {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.json(detail);
  });

  router.post("/api/pipeline-runs/:runId/steps/:stepIndex/deploy", async (req, res) => {
    const stepIndex = Number(req.params.stepIndex);
    const body = req.body as { validateOnly?: unknown; runBy?: unknown };
    if (typeof body.validateOnly !== "boolean") {
      res.status(400).json({ error: "validateOnly is required and must be a boolean" });
      return;
    }
    if (body.runBy !== undefined && body.runBy !== null && typeof body.runBy !== "string") {
      res.status(400).json({ error: "runBy must be a string when provided" });
      return;
    }
    try {
      const result = await deployPipelineStep(db, config, dataDir, req.params.runId, stepIndex, {
        validateOnly: body.validateOnly,
        runBy: (body.runBy as string | null | undefined) ?? null,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
```

- [ ] **Step 4: Rewrite `server/src/engine/routes.ts`**

Same mechanical treatment as the three files above — every handler becomes `async`, every domain-function call gains `await`. `validateDraftBody` also becomes `async` since it calls `getConnectionRow` twice.

```ts
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { getConnectionRow } from "../connections/orgConnections.js";
import { buildOrgConnection } from "./sfConnection.js";
import { listOrgComponents, describeAvailableTypes, type ComponentRef } from "./orgComponents.js";
import { ensureLocalClone } from "../connections/gitConnections.js";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";
import { decrypt } from "../crypto/encryption.js";
import { diffComponents, diffFileContents } from "./diff.js";
import {
  createDraftDeployment,
  attachComponentsAndQueue,
  updateDeploymentTitle,
  deleteDeployment,
  cloneDeployment,
  cancelDeployment,
  setRunBy,
  scheduleDeployment,
  cancelSchedule,
  getDeployment,
  listDeployments,
  runDeployment,
  type DeployComponentSelection,
  type TestLevel,
} from "./deploy.js";
import { rollbackDeployment } from "./rollback.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);

function extractRunBy(body: unknown): { value: string | null } | { error: string } {
  const { runBy } = (body ?? {}) as Record<string, unknown>;
  if (runBy === undefined || runBy === null) return { value: null };
  if (typeof runBy !== "string") return { error: "runBy must be a string" };
  const trimmed = runBy.trim();
  return { value: trimmed.length > 0 ? trimmed : null };
}

export async function resolveComponents(
  db: Pool,
  config: Config,
  dataDir: string,
  connectionId: string,
  types?: string[],
  branchOverride?: string
): Promise<{ kind: "org" | "git"; components: ComponentRef[]; sourceDir?: string }> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return { kind: "org", components: await listOrgComponents(connection, { types }) };
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: branchOverride ?? row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  const components = listGitComponents(sourceDir);
  return {
    kind: "git",
    components: types && types.length > 0 ? components.filter((c) => types.includes(c.type)) : components,
    sourceDir,
  };
}

export async function resolveAvailableTypes(
  db: Pool,
  config: Config,
  dataDir: string,
  connectionId: string,
  branchOverride?: string
): Promise<string[]> {
  const row = await getConnectionRow(db, connectionId);
  if (!row) throw new Error(`No connection with id ${connectionId}`);

  if (row.type === "org") {
    const connection = await buildOrgConnection(db, connectionId, config);
    return describeAvailableTypes(connection);
  }

  const sourceDir = await ensureLocalClone({
    dataDir,
    connectionId,
    remoteUrl: row.remote_url,
    branch: branchOverride ?? row.default_branch,
    authToken: decrypt(row.encrypted_auth_token),
  });
  return Array.from(new Set(listGitComponents(sourceDir).map((c) => c.type))).sort();
}

const TEST_LEVELS: TestLevel[] = ["NoTestRun", "RunSpecifiedTests", "RunLocalTests", "RunAllTestsInOrg"];
const ACTIONS: DeployComponentSelection["action"][] = ["add", "modify", "delete"];

interface ValidatedDraftBody {
  title?: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  sourceBranch?: string;
  targetBranch?: string;
}

/** Validates a draft-creation request body before any row is written. */
async function validateDraftBody(db: Pool, body: unknown): Promise<{ value: ValidatedDraftBody } | { error: string }> {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { title, sourceConnectionId, targetConnectionId, sourceBranch, targetBranch } = body as Record<string, unknown>;

  for (const [field, value] of Object.entries({ sourceConnectionId, targetConnectionId })) {
    if (typeof value !== "string" || value === "") return { error: `${field} is required and must be a non-empty string` };
  }
  if (title !== undefined && typeof title !== "string") {
    return { error: "title must be a string" };
  }

  const source = await getConnectionRow(db, sourceConnectionId as string);
  if (!source) return { error: "sourceConnectionId does not match a known connection" };
  const target = await getConnectionRow(db, targetConnectionId as string);
  if (!target) return { error: "targetConnectionId does not match a known connection" };

  for (const [field, value, row] of [
    ["sourceBranch", sourceBranch, source],
    ["targetBranch", targetBranch, target],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value === "") return { error: `${field} must be a non-empty string when provided` };
    if (row.type !== "git") return { error: `${field} only applies to a git connection` };
  }

  return {
    value: {
      title: title as string | undefined,
      sourceConnectionId: sourceConnectionId as string,
      targetConnectionId: targetConnectionId as string,
      sourceBranch: sourceBranch as string | undefined,
      targetBranch: targetBranch as string | undefined,
    },
  };
}

interface ValidatedComponentsBody {
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly: boolean;
  ignoreWarnings: boolean;
  allowMissingFiles: boolean;
  autoUpdatePackage: boolean;
  runTests: string[];
}

function validateComponentsBody(
  targetConnectionType: string | null,
  body: unknown,
  { requireNonEmpty }: { requireNonEmpty: boolean }
): { value: ValidatedComponentsBody } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { components, testLevel, validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage, runTests } = body as Record<string, unknown>;

  if (!Array.isArray(components) || (requireNonEmpty && components.length === 0)) {
    return {
      error: requireNonEmpty
        ? "components is required and must be a non-empty array"
        : "components is required and must be an array",
    };
  }
  for (const c of components as unknown[]) {
    if (typeof c !== "object" || c === null) return { error: "each component must be an object" };
    const { type, fullName, action } = c as Record<string, unknown>;
    if (typeof type !== "string" || type === "") return { error: "each component needs a non-empty type" };
    if (typeof fullName !== "string" || fullName === "") return { error: "each component needs a non-empty fullName" };
    if (typeof action !== "string" || !ACTIONS.includes(action as DeployComponentSelection["action"])) {
      return { error: `each component's action must be one of: ${ACTIONS.join(", ")}` };
    }
  }
  if (typeof testLevel !== "string" || !TEST_LEVELS.includes(testLevel as TestLevel)) {
    return { error: `testLevel must be one of: ${TEST_LEVELS.join(", ")}` };
  }
  for (const [field, value] of Object.entries({ validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage })) {
    if (value !== undefined && typeof value !== "boolean") {
      return { error: `${field} must be a boolean` };
    }
  }
  if (runTests !== undefined && (!Array.isArray(runTests) || runTests.some((t) => typeof t !== "string" || t === ""))) {
    return { error: "runTests must be an array of non-empty strings" };
  }
  if (requireNonEmpty && testLevel === "RunSpecifiedTests" && (!Array.isArray(runTests) || runTests.length === 0)) {
    return { error: "runTests is required and must be a non-empty array when testLevel is RunSpecifiedTests" };
  }

  const typed = components as DeployComponentSelection[];
  if (targetConnectionType !== "org" && typed.some((c) => c.action === "delete")) {
    return { error: "Deleting components is only supported for org targets" };
  }

  return {
    value: {
      components: typed,
      testLevel: testLevel as TestLevel,
      validateOnly: (validateOnly as boolean | undefined) ?? false,
      ignoreWarnings: (ignoreWarnings as boolean | undefined) ?? false,
      allowMissingFiles: (allowMissingFiles as boolean | undefined) ?? false,
      autoUpdatePackage: (autoUpdatePackage as boolean | undefined) ?? false,
      runTests: (runTests as string[] | undefined) ?? [],
    },
  };
}

function validateRunBody(targetConnectionType: string | null, body: unknown): { value: ValidatedComponentsBody } | { error: string } {
  return validateComponentsBody(targetConnectionType, body, { requireNonEmpty: true });
}

function validateSaveBody(targetConnectionType: string | null, body: unknown): { value: ValidatedComponentsBody } | { error: string } {
  return validateComponentsBody(targetConnectionType, body, { requireNonEmpty: false });
}

export function createEngineRouter(db: Pool, config: Config, dataDir: string): Router {
  const router = Router();

  router.get("/api/diff", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const typesParam = req.query.types;
    const types = typeof typesParam === "string" && typesParam.length > 0 ? typesParam.split(",") : undefined;
    const sourceBranch = typeof req.query.sourceBranch === "string" ? req.query.sourceBranch : undefined;
    const targetBranch = typeof req.query.targetBranch === "string" ? req.query.targetBranch : undefined;
    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId, types, sourceBranch),
        resolveComponents(db, config, dataDir, targetConnectionId, types, targetBranch),
      ]);
      res.json(diffComponents(source.components, target.components));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/metadata-types", async (req, res) => {
    const connectionId = String(req.query.connectionId ?? "");
    const branch = typeof req.query.branch === "string" ? req.query.branch : undefined;
    try {
      res.json(await resolveAvailableTypes(db, config, dataDir, connectionId, branch));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.get("/api/diff/content", async (req, res) => {
    const sourceConnectionId = String(req.query.sourceConnectionId ?? "");
    const targetConnectionId = String(req.query.targetConnectionId ?? "");
    const type = String(req.query.type ?? "");
    const fullName = String(req.query.fullName ?? "");
    const sourceBranch = typeof req.query.sourceBranch === "string" ? req.query.sourceBranch : undefined;
    const targetBranch = typeof req.query.targetBranch === "string" ? req.query.targetBranch : undefined;

    try {
      const [source, target] = await Promise.all([
        resolveComponents(db, config, dataDir, sourceConnectionId, undefined, sourceBranch),
        resolveComponents(db, config, dataDir, targetConnectionId, undefined, targetBranch),
      ]);

      const sourceFiles = source.kind === "git" && source.sourceDir ? readGitComponentFiles(source.sourceDir, type, fullName) : [];
      const targetFiles = target.kind === "git" && target.sourceDir ? readGitComponentFiles(target.sourceDir, type, fullName) : [];

      res.json(diffFileContents(sourceFiles, targetFiles));
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments", async (req, res) => {
    const validated = await validateDraftBody(db, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    const id = await createDraftDeployment(db, {
      title: body.title,
      sourceConnectionId: body.sourceConnectionId,
      targetConnectionId: body.targetConnectionId,
      sourceBranch: body.sourceBranch,
      targetBranch: body.targetBranch,
    });

    res.status(201).json({ id });
  });

  router.get("/api/deployments", async (_req, res) => {
    res.json(await listDeployments(db));
  });

  router.get("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    res.json(deployment);
  });

  router.get("/api/deployments/:id/export", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const lines = deployment.components.map((c: { type: string; fullName: string }) => `${c.type}/${c.fullName}`);
    res.setHeader("Content-Disposition", `attachment; filename="deployment-${req.params.id}-components.txt"`);
    res.setHeader("Content-Type", "text/plain");
    res.send(lines.join("\n"));
  });

  router.get("/api/deployments/:id/export/package", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (!deployment.package_path || !fs.existsSync(deployment.package_path)) {
      res.status(404).json({ error: "No metadata package is available for this deployment" });
      return;
    }
    res.setHeader("Content-Disposition", `attachment; filename="deployment-${req.params.id}-package.zip"`);
    res.setHeader("Content-Type", "application/zip");
    res.sendFile(path.resolve(deployment.package_path));
  });

  router.patch("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (deployment.status !== "pending") {
      res.status(400).json({ error: "components can only be saved while the deployment is still pending" });
      return;
    }
    const validated = validateSaveBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const body = validated.value;
    await attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });

    res.status(200).json({ id: req.params.id });
  });

  router.patch("/api/deployments/:id/title", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const body = req.body as { title?: unknown };
    if (body.title !== undefined && body.title !== null && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string or null" });
      return;
    }
    const title = typeof body.title === "string" ? body.title.trim() || null : null;
    await updateDeploymentTitle(db, req.params.id, title);

    res.status(200).json({ id: req.params.id });
  });

  router.delete("/api/deployments/:id", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    await deleteDeployment(db, req.params.id);
    res.status(204).send();
  });

  router.post("/api/deployments/:id/clone", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const id = await cloneDeployment(db, req.params.id);
    res.status(201).json({ id });
  });

  router.post("/api/deployments/:id/run", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    const validated = validateRunBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const runByResult = extractRunBy(req.body);
    if ("error" in runByResult) {
      res.status(400).json({ error: runByResult.error });
      return;
    }
    const body = validated.value;
    await attachComponentsAndQueue(db, req.params.id, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });
    await setRunBy(db, req.params.id, runByResult.value);

    runDeployment(db, config, dataDir, req.params.id).catch((err) => {
      console.error(`Deployment ${req.params.id} failed unexpectedly`, err);
    });

    res.status(202).json({ id: req.params.id });
  });

  router.post("/api/deployments/:id/rerun", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    if (!TERMINAL_STATUSES.has(deployment.status)) {
      res.status(400).json({ error: "Only a finished deployment can be re-run; use Deploy/Validate on a pending draft instead" });
      return;
    }
    const validated = validateRunBody(deployment.target_connection_type, req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const runByResult = extractRunBy(req.body);
    if ("error" in runByResult) {
      res.status(400).json({ error: runByResult.error });
      return;
    }
    const body = validated.value;
    const newId = await cloneDeployment(db, req.params.id);
    await attachComponentsAndQueue(db, newId, {
      components: body.components,
      testLevel: body.testLevel,
      validateOnly: body.validateOnly,
      ignoreWarnings: body.ignoreWarnings,
      allowMissingFiles: body.allowMissingFiles,
      autoUpdatePackage: body.autoUpdatePackage,
      runTests: body.runTests,
    });
    await setRunBy(db, newId, runByResult.value);

    runDeployment(db, config, dataDir, newId).catch((err) => {
      console.error(`Deployment ${newId} failed unexpectedly`, err);
    });

    res.status(202).json({ id: newId });
  });

  router.post("/api/deployments/:id/cancel", async (req, res) => {
    const deployment = await getDeployment(db, req.params.id);
    if (!deployment) {
      res.status(404).json({ error: "deployment not found" });
      return;
    }
    try {
      await cancelDeployment(db, config, req.params.id);
      res.status(202).json({ id: req.params.id });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments/:id/schedule", async (req, res) => {
    const { scheduledAt, runBy } = req.body as { scheduledAt?: unknown; runBy?: unknown };
    if (typeof scheduledAt !== "string" || Number.isNaN(Date.parse(scheduledAt))) {
      res.status(400).json({ error: "scheduledAt is required and must be a valid ISO timestamp" });
      return;
    }
    if (runBy !== undefined && runBy !== null && typeof runBy !== "string") {
      res.status(400).json({ error: "runBy must be a string when provided" });
      return;
    }
    try {
      await scheduleDeployment(db, req.params.id, scheduledAt, (runBy as string | null | undefined) ?? null);
      res.status(200).json(await getDeployment(db, req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments/:id/schedule/cancel", async (req, res) => {
    try {
      await cancelSchedule(db, req.params.id);
      res.status(200).json(await getDeployment(db, req.params.id));
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/deployments/:id/rollback", async (req, res) => {
    try {
      const rollbackId = await rollbackDeployment(db, config, req.params.id);
      res.status(202).json({ id: rollbackId });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  return router;
}
```

- [ ] **Step 5: Update the 4 corresponding test files**

Apply the standard setup swap (Task 2's pattern) to `server/src/auth/routes.test.ts`, `server/src/connections/routes.test.ts`, `server/src/engine/routes.test.ts`, `server/src/pipelines/routes.test.ts`. These use `supertest` against an Express app built with `createApp`/the individual router factories — update whatever builds that app in each file's setup to pass `testDb.pool` instead of a `better-sqlite3` instance, and add `await` to any direct fixture-setup calls into the now-async domain functions (e.g. `createOrgConnection`, `createDraftDeployment`) that these test files call directly.

- [ ] **Step 6: Run the full server suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: every server test file passes. This is the point where the entire converted codebase should be green end-to-end (the migration script and Docker changes, Tasks 12-13, don't have their own tests yet).

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/routes.ts server/src/connections/routes.ts server/src/engine/routes.ts server/src/pipelines/routes.ts server/src/auth/routes.test.ts server/src/connections/routes.test.ts server/src/engine/routes.test.ts server/src/pipelines/routes.test.ts
git commit -m "feat: propagate async/await through all 4 route modules"
```

---

## Task 11: Write the one-time SQLite-to-Postgres migration script

**Files:**
- Create: `server/scripts/migrate-sqlite-to-postgres.ts`
- Create: `server/scripts/migrate-sqlite-to-postgres.test.ts`

**Interfaces:**
- Consumes: `openDb(connectionString: string): Pool`, `runMigrations(db: Pool): Promise<void>` (Task 2). Reads SQLite via a direct, temporary `better-sqlite3` import scoped to this script only (this is the one file in the whole codebase still allowed to depend on `better-sqlite3`, since its entire job is reading the old format — re-add `better-sqlite3`/`@types/better-sqlite3` as devDependencies for this script alone).
- Produces: `migrateSqliteToPostgres(sqliteFilePath: string, pgPool: Pool): Promise<Record<string, number>>` — returns a map of table name to row count copied, used both by the CLI entrypoint and by this task's own test.

- [ ] **Step 1: Add `better-sqlite3` back as a devDependency (script-only use)**

In `server/package.json`, add to `devDependencies`: `"better-sqlite3": "^13.0.3"`, `"@types/better-sqlite3": "^9.6.0"`.

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing test**

Create `server/scripts/migrate-sqlite-to-postgres.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { migrateSqliteToPostgres } from "./migrate-sqlite-to-postgres.js";

describe("migrateSqliteToPostgres", () => {
  let testDb: TestDb | undefined;
  let sqlitePath: string | undefined;

  afterEach(async () => {
    if (testDb) await testDb.stop();
    if (sqlitePath) fs.rmSync(sqlitePath, { force: true });
    testDb = undefined;
    sqlitePath = undefined;
  });

  it("copies every row from a representative SQLite file into Postgres, matching row counts and content", async () => {
    sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-migrate-")), "sfcowboy.db");
    const sqlite = new Database(sqlitePath);
    sqlite.exec(`
      CREATE TABLE connections (id TEXT PRIMARY KEY, type TEXT NOT NULL, nickname TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, instance_url TEXT, org_type TEXT, encrypted_refresh_token TEXT, remote_url TEXT, default_branch TEXT, encrypted_auth_token TEXT, encrypted_client_id TEXT, last_error TEXT, login_username TEXT, min_code_coverage_percent INTEGER);
      CREATE TABLE pipelines (id TEXT PRIMARY KEY, name TEXT NOT NULL, connection_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', track_components_independently INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL, title TEXT, component_list TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE deployments (id TEXT PRIMARY KEY, title TEXT, source_connection_id TEXT, target_connection_id TEXT NOT NULL, component_list TEXT NOT NULL, test_level TEXT NOT NULL, status TEXT NOT NULL, validate_only INTEGER NOT NULL DEFAULT 0, ignore_warnings INTEGER NOT NULL DEFAULT 0, allow_missing_files INTEGER NOT NULL DEFAULT 0, auto_update_package INTEGER NOT NULL DEFAULT 0, run_tests TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT, error_detail TEXT, snapshot_path TEXT, is_rollback_of TEXT, sf_job_id TEXT, components_deployed INTEGER, components_total INTEGER, tests_completed INTEGER, tests_total INTEGER, run_by TEXT, pipeline_run_id TEXT, pipeline_step_index INTEGER, coverage_percent REAL, coverage_details TEXT, source_branch TEXT, target_branch TEXT, static_analysis_findings TEXT, scheduled_at TEXT, package_path TEXT);
      CREATE TABLE deployment_items (id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, metadata_type TEXT NOT NULL, api_name TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT);
    `);
    sqlite.prepare(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'org', 'Dev', '2026-01-01T00:00:00.000Z')`).run();
    sqlite.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '["c1"]')`).run();
    sqlite
      .prepare(
        `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, started_at)
         VALUES ('d1', 'c1', 'c1', '[]', 'NoTestRun', 'pending', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    sqlite
      .prepare(
        `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ('i1', 'd1', 'ApexClass', 'A', 'add', 'pending')`
      )
      .run();
    sqlite.close();

    testDb = await openTestDb();
    const counts = await migrateSqliteToPostgres(sqlitePath, testDb.pool);

    expect(counts).toEqual({ connections: 1, pipelines: 1, pipeline_runs: 0, deployments: 1, deployment_items: 1 });

    const connectionRow = (await testDb.pool.query(`SELECT id, type, nickname FROM connections WHERE id = 'c1'`)).rows[0];
    expect(connectionRow).toEqual({ id: "c1", type: "org", nickname: "Dev" });

    const deploymentRow = (await testDb.pool.query(`SELECT id, status, component_list FROM deployments WHERE id = 'd1'`)).rows[0];
    expect(deploymentRow).toEqual({ id: "d1", status: "pending", component_list: "[]" });
  }, 60_000);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run scripts/migrate-sqlite-to-postgres.test.ts`
Expected: FAIL — the script doesn't exist yet.

- [ ] **Step 4: Write `server/scripts/migrate-sqlite-to-postgres.ts`**

```ts
import Database from "better-sqlite3";
import type { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { openDb, runMigrations } from "../src/db/client.js";

// Dependency order matters: deployments references connections and pipeline_runs;
// deployment_items references deployments; pipeline_runs references pipelines.
const TABLES_IN_DEPENDENCY_ORDER = ["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"] as const;

/**
 * One-time cutover script: copies every row from an existing SQLite database into a Postgres
 * database that already has the current schema applied (via runMigrations), in dependency order
 * so foreign keys never point at a row that hasn't been inserted yet. Read-only against the
 * SQLite file — never writes to it. Returns the row count copied per table, for the operator to
 * verify against a `SELECT COUNT(*)` on the original file before proceeding with the cutover.
 */
export async function migrateSqliteToPostgres(sqliteFilePath: string, pgPool: Pool): Promise<Record<string, number>> {
  const sqlite = new Database(sqliteFilePath, { readonly: true });
  const counts: Record<string, number> = {};

  try {
    for (const table of TABLES_IN_DEPENDENCY_ORDER) {
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      counts[table] = rows.length;
      for (const row of rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const values = columns.map((c) => row[c]);
        await pgPool.query(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          values
        );
      }
    }
  } finally {
    sqlite.close();
  }

  return counts;
}

async function main() {
  const sqliteFilePath = process.argv[2];
  if (!sqliteFilePath) {
    console.error("Usage: tsx scripts/migrate-sqlite-to-postgres.ts <path-to-sqlite-file>");
    process.exit(1);
  }

  const config = loadConfig();
  const pool = openDb(config.databaseUrl);
  await runMigrations(pool);

  console.log(`Migrating ${sqliteFilePath} -> ${config.databaseUrl} ...`);
  const counts = await migrateSqliteToPostgres(sqliteFilePath, pool);
  console.log("Rows copied per table:");
  for (const [table, count] of Object.entries(counts)) {
    console.log(`  ${table}: ${count}`);
  }

  await pool.end();
}

// Only run the CLI entrypoint when this file is executed directly (`tsx scripts/migrate-...`),
// not when migrateSqliteToPostgres is imported by the test above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run scripts/migrate-sqlite-to-postgres.test.ts`
Expected: PASS.

- [ ] **Step 6: Add an npm script for the CLI**

In `server/package.json`'s `"scripts"` block, add:

```json
"migrate-sqlite-to-postgres": "tsx scripts/migrate-sqlite-to-postgres.ts"
```

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/scripts/migrate-sqlite-to-postgres.ts server/scripts/migrate-sqlite-to-postgres.test.ts
git commit -m "feat: add one-time SQLite-to-Postgres data migration script"
```

---

## Task 12: Add the Postgres service to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:** none — infrastructure only.

- [ ] **Step 1: Update `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    environment:
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - OAUTH_CALLBACK_URL=${OAUTH_CALLBACK_URL:-https://deploy.effluence.com.au/oauth/callback}
      - DATABASE_URL=postgres://sfcowboy:${POSTGRES_PASSWORD}@postgres:5432/sfcowboy
    volumes:
      - sfcowboy_data:/data
    expose:
      - "3000"
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      - POSTGRES_USER=sfcowboy
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
      - POSTGRES_DB=sfcowboy
    volumes:
      - postgres_data:/var/lib/postgresql/data
    expose:
      - "5432"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - app

volumes:
  sfcowboy_data:
  postgres_data:
  caddy_data:
  caddy_config:
```

`sfcowboy_data` (the old SQLite volume) is kept, unused by `app` going forward — this is deliberate, matching the spec's rollback plan: the volume must survive, untouched, so the pre-cutover SQLite file remains recoverable. `POSTGRES_PASSWORD` is a new required environment variable, generated once and stored the same way `ENCRYPTION_KEY` already is (outside version control, in whatever secret store/`.env` file the deployment already uses).

- [ ] **Step 2: Verify the compose file parses**

Run: `docker compose config --quiet`
Expected: no output, exit code 0 (this only validates YAML/interpolation syntax — it does not require Docker to actually be running).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: add a postgres service to docker-compose.yml"
```

---

## Task 13: Full-suite verification, typecheck, and build

**Files:** none created or modified — this task is pure verification, matching the spec's "Testing approach" section.

- [ ] **Step 1: Run the full server test suite**

Run: `cd server && npx vitest run`
Expected: every test file passes. This is the first point where the entire suite (not just the files touched by an individual task) has run against Postgres end-to-end.

- [ ] **Step 2: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `cd server && npm run build`
Expected: succeeds, `dist/index.js` and `dist/db/schema.sql` both exist.

- [ ] **Step 4: Confirm no remaining references to `better-sqlite3` outside the migration script**

Run: `grep -rn "better-sqlite3" server/src`
Expected: no matches (the only remaining reference is `server/scripts/migrate-sqlite-to-postgres.ts`, which is outside `server/src`).

- [ ] **Step 5: Commit** (only if any fixes were needed in Steps 1-4; otherwise skip — there's nothing to commit for a clean verification pass)

```bash
git add -A
git commit -m "fix: address issues found during full-suite Postgres verification"
```

---

## Task 14: Cutover rehearsal and runbook

**Files:**
- Create: `docs/RUNBOOK-postgres-cutover.md`

**Interfaces:** none — this task produces a document plus a live rehearsal against a copy of production data; it doesn't touch application code.

- [ ] **Step 1: Write the runbook**

Create `docs/RUNBOOK-postgres-cutover.md`:

```markdown
# Postgres cutover runbook

Rehearse this entire runbook (steps 2-8) against a **copy** of the production
SQLite file before ever running it against the real production volume. See
`docs/superpowers/specs/2026-09-02-postgres-migration-design.md` for the
full rollback rationale.

## 1. Generate and store the Postgres password

```bash
openssl rand -base64 32
```

Store this as `POSTGRES_PASSWORD` alongside the existing `ENCRYPTION_KEY` in
whatever secret store the deployment already uses.

## 2. Deploy the new code, but do not cut over yet

```bash
git pull
docker compose build app
docker compose up -d postgres
```

`app` is intentionally not restarted here — it keeps running against SQLite
while `postgres` starts up empty in the background.

## 3. Stop the app (starts the maintenance window)

```bash
docker compose stop app
```

From this instant, the SQLite file is guaranteed static.

## 4. Back up the SQLite file independently

```bash
docker compose exec -T postgres true  # confirms postgres container is up
docker cp $(docker compose ps -q app):/data/sfcowboy.db ./sfcowboy-backup-$(date +%Y%m%d-%H%M%S).db
```

Copy this file off-box (durable storage, not just this host) before continuing.

## 5. Run the migration script

```bash
docker compose run --rm \
  -e DATABASE_URL="postgres://sfcowboy:${POSTGRES_PASSWORD}@postgres:5432/sfcowboy" \
  app npm run migrate-sqlite-to-postgres -- /data/sfcowboy.db
```

Record the printed row counts per table.

## 6. Verify row counts independently

```bash
docker compose run --rm app node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/sfcowboy.db', { readonly: true });
for (const t of ['connections','pipelines','pipeline_runs','deployments','deployment_items']) {
  console.log(t, db.prepare('SELECT COUNT(*) as c FROM ' + t).get().c);
}
"
docker compose exec postgres psql -U sfcowboy -d sfcowboy -c "
SELECT 'connections', COUNT(*) FROM connections
UNION ALL SELECT 'pipelines', COUNT(*) FROM pipelines
UNION ALL SELECT 'pipeline_runs', COUNT(*) FROM pipeline_runs
UNION ALL SELECT 'deployments', COUNT(*) FROM deployments
UNION ALL SELECT 'deployment_items', COUNT(*) FROM deployment_items;
"
```

**Every row count must match exactly.** If any table's counts differ, STOP —
do not proceed to step 7. Investigate before continuing.

## 7. Smoke test against Postgres before real traffic touches it

```bash
docker compose run --rm -p 3001:3000 \
  -e DATABASE_URL="postgres://sfcowboy:${POSTGRES_PASSWORD}@postgres:5432/sfcowboy" \
  app node dist/index.js
```

Against `http://localhost:3001` (not the real domain — `caddy`/DNS still
point at nothing new yet), confirm: the deployments list loads with the
expected data, a connection's detail page loads, History shows past runs.
Stop this container once satisfied (Ctrl+C).

## 8. Cut over

Only proceed here once steps 6 and 7 both passed cleanly.

```bash
docker compose up -d app
```

`app` now starts with `DATABASE_URL` already pointing at `postgres` (see
Task 12's `docker-compose.yml`). This is the moment real traffic starts
touching Postgres.

## 9. Immediately back up the newly-live Postgres database

```bash
docker compose exec postgres pg_dump -U sfcowboy sfcowboy > postgres-backup-$(date +%Y%m%d-%H%M%S).sql
```

Copy this off-box too. This is the rollback point for anything discovered
**after** this point — see "Rollback," below.

## Rollback

**Before step 8:** free — just don't run step 8. Nothing has touched
Postgres in production yet. Confirm `app` is still running against the
original SQLite file (it never stopped being able to, unless step 3
happened — if step 3 already ran, restart it: `docker compose up -d app`
with `DATABASE_URL` unset/pointing nowhere new).

**After step 8:** do **not** revert to SQLite — real writes may already
exist in Postgres that don't exist in the SQLite file. Instead:
- For a data problem: restore the step 9 backup (or a later one) with
  `psql -U sfcowboy sfcowboy < backup.sql`.
- For a code problem: deploy a forward fix against the same Postgres
  database, same as any other bug fix.

Keep the SQLite backup from step 4 indefinitely.
```

- [ ] **Step 2: Rehearse the runbook against a copy of production data**

This step has no automated test — it's a manual, deliberate walkthrough. Obtain a **copy** of the current production `sfcowboy.db` (not the live file), and run through runbook steps 2-9 against it in a non-production environment (a separate Docker host, or the same host with `app`/`postgres` service names temporarily aliased so they don't collide with the real running production containers). Confirm every step's expected output actually occurs, and — separately, once — deliberately trigger the "before step 8" rollback path too, to confirm restarting against the original SQLite file genuinely still works after the rehearsal's `docker compose stop app`.

Expected: the full rehearsal completes with matching row counts, a working smoke test, and a confirmed rollback path, before this is ever attempted against the real production volume.

- [ ] **Step 3: Commit**

```bash
git add docs/RUNBOOK-postgres-cutover.md
git commit -m "docs: add the Postgres cutover runbook"
```

---

## After this plan ships

The production cutover itself (running the rehearsed runbook against the real `deploy.effluence.com.au` volume) is a deliberate, scheduled action taken by a human once every task above is merged and verified — it is not automated as part of this plan, and should be scheduled as its own explicit step with the user's direct involvement, not executed unattended.
