# Supabase Auth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the abandoned custom auth system (PR #1, unmerged, to be closed) with Supabase Cloud as the identity provider, move the app's entire database onto Supabase's managed Postgres, and ship admin-provisioned team management (invite, reset-password-by-email, remove) — all while leaving every *existing* domain route's authorization behavior untouched (that's Plan 2's job).

**Architecture:** Two Supabase Cloud projects (`sfcowboy-dev` for local dev/tests, `sfcowboy-prod` for production). Supabase's Postgres becomes the app's only database. The Express backend verifies Supabase-issued JWTs locally (JWKS) via a new `requireSupabaseUser` middleware, used only by the new `/api/team/*` routes in this plan. The React frontend uses `@supabase/supabase-js` directly for login/logout/password-reset — no server round-trip for those. Existing domain tables gain a `NOT NULL` `organization_id` column with a column-level `DEFAULT` pointing at one well-known organization, so every existing, untouched `INSERT` keeps working unchanged.

**Tech Stack:** `@supabase/supabase-js` (server admin client + browser client), `jose` (local JWT verification against Supabase's JWKS), existing stack otherwise unchanged (Express, raw `pg`, React, Vite, Vitest).

**Spec:** `docs/superpowers/specs/2026-09-11-supabase-auth-migration-design.md` — read this in full before starting. It documents *why* several choices below were made (token storage trade-off, no RLS, no local emulator, the Plan 1/Plan 2 split, the `DEFAULT` column trick) and lists what Plan 2 covers instead.

## Prerequisites (human action, before Task 1)

This plan cannot begin until two real Supabase Cloud projects exist — creating them requires signing in with a human's own account, which no agent in this plan should do.

1. Create a Supabase account (or use an existing one) at supabase.com.
2. Create two projects: `sfcowboy-dev` and `sfcowboy-prod`. Same region for both is fine; pick one close to where the app will actually run.
3. For **each** project, from its dashboard (Project Settings → API, and Project Settings → Database), collect:
   - Project URL (`https://<ref>.supabase.co`)
   - `anon` public key
   - `service_role` secret key
   - The Postgres connection string. Supabase offers several modes (Direct connection, Session pooler, Transaction pooler) — **Task 1's own verification step determines which one this codebase actually needs; don't guess at this stage.** Collect the Session pooler string as the starting candidate (see Task 1).
4. Create `server/.env` (git-ignored, never commit it) with the `sfcowboy-dev` project's values, following the shape `server/.env.example` will have after Task 1. Task 1's implementer needs this file to exist with real values to verify against.

## Global Constraints

- No behavior change to any existing domain route's authorization: `connections`, `pipelines`, `pipeline_runs`, `deployments`, `deployment_items` routes stay exactly as open/unauthenticated as they are on `main` today. Only the new `/api/team/*` routes are gated by `requireSupabaseUser`.
- `organization_id` on the 5 existing tables is `NOT NULL` with `DEFAULT '00000000-0000-0000-0000-000000000000'` — never add it as nullable, and never remove the `DEFAULT` in this plan (Plan 2's job).
- The well-known default organization's id is the literal string `00000000-0000-0000-0000-000000000000` (the nil UUID) — use this exact value everywhere it's needed; don't generate a random one.
- No Row Level Security policies anywhere in this plan.
- No local Supabase emulator — every task that needs a real Supabase Auth/Postgres round-trip uses the `sfcowboy-dev` project via `server/.env`, over the network.
- Every new domain function that touches the database is `async` and takes `db: Pool` as its first parameter, matching every existing module in this codebase. Functions that only call Supabase's API (no direct SQL) take the Supabase client as their first parameter instead — `team.ts`'s `createInvite`/`sendPasswordReset` are the two examples in this plan.
- Every new backend test file uses `openTestDb()`-equivalent isolation against `sfcowboy-dev` (see Task 1 for the exact mechanism, once verified).
- Run `cd server && npx vitest run <this task's test file(s)>` and `npx tsc --noEmit` after every backend task; `cd web && npx vitest run <file>` and `npx tsc --noEmit` after every frontend task — scoped to that task's own files; do not run the full suite until the final task.

---

## Task 1: Supabase clients, config, and connection-mode verification

**Files:**
- Modify: `server/package.json` (add `@supabase/supabase-js`, `jose`)
- Modify: `server/.env.example`
- Modify: `server/src/config.ts`
- Modify: `server/src/db/testDb.ts`
- Create: `server/src/supabase.ts`
- Create: `server/src/supabase.test.ts`

**Interfaces:**
- Produces: `Config` gains `supabaseUrl`, `supabaseServiceRoleKey`, `bootstrapAdminEmail?`, `bootstrapAdminPassword?`, `bootstrapOrgName` (defaulted). `createSupabaseAdminClient(config): SupabaseClient`, `verifySupabaseJwt(config): (token: string) => Promise<{ userId: string }>` — both consumed by Task 3 (middleware) and Task 4 (team.ts).

- [ ] **Step 1: Install dependencies**

```bash
cd server && npm install @supabase/supabase-js jose
```

- [ ] **Step 2: Verify the Postgres connection mode this codebase needs**

Before writing any code, confirm which Supabase connection string `pg.Pool` needs for this codebase's two session-dependent features: (a) `testDb.ts`'s `options: '-c search_path=...'` per-schema isolation trick, and (b) `node-postgres`'s default use of prepared statements for every parameterized query. Both require session-level state to survive across queries on the same logical connection — Supabase's Transaction-mode pooler (typically port 6543) does not guarantee this; the Session-mode pooler (typically port 5432 via the pooler host) or a Direct connection does.

Using the `sfcowboy-dev` project's connection string from `server/.env` (Prerequisites step 4), run this one-off check:

```bash
cd server && node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=public' });
(async () => {
  const a = await pool.query('SET search_path TO public');
  const b = await pool.query('SELECT current_setting(\'search_path\') AS sp');
  console.log('search_path after SET on same pool:', b.rows[0].sp);
  const c = await pool.query('SELECT 1::int AS one WHERE \$1::int = 1', [1]);
  console.log('parameterized query result:', c.rows[0].one);
  await pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
"
```

Expected on a Session-mode or Direct connection string: both lines print successfully, no error. If this fails (an error mentioning prepared statements, or `search_path` not taking effect), retry with the project's Direct connection string instead of the pooler string, and use that as `DATABASE_URL` from here on. **Document whichever string mode actually worked** as a comment in `server/.env.example` (Step 3) — do not guess or leave this unverified.

- [ ] **Step 3: Update `server/.env.example`**

Add, near the existing `DATABASE_URL` line (read the current file first to match its exact comment style):

```
# Supabase project URL and keys (Project Settings -> API in the Supabase dashboard).
# SUPABASE_SERVICE_ROLE_KEY is a secret with full admin access to this project's Auth and
# database (bypasses Row Level Security entirely) -- never expose it to the browser, never log it.
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=

# DATABASE_URL must use Supabase's Session-mode pooler or Direct connection string, NOT the
# Transaction-mode pooler (typically port 6543) -- this codebase relies on session-level state
# (search_path in tests, and node-postgres's default prepared statements) that Transaction-mode
# pooling does not preserve across queries. [Task 1's implementer: replace this sentence with
# whichever string actually verified working in Step 2, naming the exact port/host pattern.]

# Required only on first boot against a database with no admin user yet.
BOOTSTRAP_ADMIN_EMAIL=
BOOTSTRAP_ADMIN_PASSWORD=
# Optional (default shown) -- name of the one organization every pre-Plan-2 row belongs to.
BOOTSTRAP_ORG_NAME=My Organization
```

- [ ] **Step 4: Update `server/src/config.ts`**

```ts
export interface Config {
  port: number;
  databaseUrl: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
  sfClientId: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  bootstrapOrgName: string;
}

// ... DEFAULT_SF_CLIENT_ID unchanged ...

export function loadConfig(): Config {
  const required = ["ENCRYPTION_KEY", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    databaseUrl: process.env.DATABASE_URL!,
    encryptionKey: process.env.ENCRYPTION_KEY!,
    oauthCallbackUrl: process.env.OAUTH_CALLBACK_URL ?? "https://deploy.effluence.com.au/oauth/callback",
    sfClientId: process.env.SF_CLIENT_ID ?? DEFAULT_SF_CLIENT_ID,
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapOrgName: process.env.BOOTSTRAP_ORG_NAME ?? "My Organization",
  };
}
```

Every existing test file that builds a fixture `Config` object literal needs `supabaseUrl`/`supabaseServiceRoleKey` added (`bootstrapAdminEmail`/`bootstrapAdminPassword` are optional, `bootstrapOrgName` has a default so can be omitted). Find every one: `grep -rn "databaseUrl:" server/src --include=*.test.ts` — add `supabaseUrl: "https://unused-in-tests.supabase.co"` and `supabaseServiceRoleKey: "unused-in-tests"` to each.

- [ ] **Step 5: Create `server/src/supabase.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

/**
 * Server-side client using the service_role key -- full admin access, bypasses every Auth
 * restriction. Never expose this client or its key to the browser. Used only for admin
 * operations: inviting users, listing users to join with app_users, generating password-reset
 * links. See the design spec's Security Considerations section.
 */
export function createSupabaseAdminClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Cached per Config instance rather than module-level global, so tests using different fixture
// configs (different supabaseUrl) each get their own JWKS fetcher instead of silently sharing one
// pointed at the wrong project.
const jwksCache = new WeakMap<Config, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(config: Config) {
  let jwks = jwksCache.get(config);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`));
    jwksCache.set(config, jwks);
  }
  return jwks;
}

export interface VerifiedSupabaseUser {
  userId: string;
}

/**
 * Verifies a Supabase-issued access token's signature locally against the project's published
 * signing keys (cached, not re-fetched per call) -- no network call to Supabase on the request's
 * hot path. Throws if the token is malformed, expired, or signed by a different project.
 */
export async function verifySupabaseJwt(config: Config, token: string): Promise<VerifiedSupabaseUser> {
  const { payload } = await jwtVerify(token, getJwks(config), {
    issuer: `${config.supabaseUrl}/auth/v1`,
  });
  if (typeof payload.sub !== "string") throw new Error("Token payload missing sub claim");
  return { userId: payload.sub };
}
```

- [ ] **Step 6: Write `server/src/supabase.test.ts`**

This test needs a real Supabase project to get a real, validly-signed token to verify — read `server/.env` for `SUPABASE_URL` (via `dotenv/config`, matching how other test files that need real external config already load it — check `server/src/db/testDb.ts` and any existing test importing `dotenv/config` for the pattern) and skip gracefully if it's not the real dev project (e.g. if `SUPABASE_URL` is unset, `describe.skip`).

```ts
import "dotenv/config";
import { describe, it, expect } from "vitest";
import { createSupabaseAdminClient, verifySupabaseJwt } from "./supabase.js";
import { loadConfig } from "./config.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("verifySupabaseJwt", () => {
  it("verifies a real access token minted by the dev project and rejects a tampered one", async () => {
    const config = loadConfig();
    const admin = createSupabaseAdminClient(config);

    const email = `supabase-test-${Date.now()}@example.com`;
    const { data: userData, error: createError } = await admin.auth.admin.createUser({
      email,
      password: "a-good-test-password-1",
      email_confirm: true,
    });
    expect(createError).toBeNull();

    try {
      const { data: sessionData, error: signInError } = await admin.auth.signInWithPassword({
        email,
        password: "a-good-test-password-1",
      });
      expect(signInError).toBeNull();
      const token = sessionData.session!.access_token;

      const verified = await verifySupabaseJwt(config, token);
      expect(verified.userId).toBe(userData.user!.id);

      await expect(verifySupabaseJwt(config, token + "tampered")).rejects.toThrow();
    } finally {
      await admin.auth.admin.deleteUser(userData.user!.id);
    }
  });
});
```

- [ ] **Step 7: Update `server/src/db/testDb.ts`'s connection string**, if Step 2 found the Session-mode/Direct string is required, to read `TEST_DATABASE_URL` exactly as it does today (no code change needed if the env var itself just needs to point at the right string) — but update its doc comment to state which mode is required and why, referencing Step 2's finding.

- [ ] **Step 8: Run tests and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run src/supabase.test.ts src/config.test.ts` (or wherever config fixtures live)
Expected: clean, `supabase.test.ts`'s real-project test passes against `sfcowboy-dev`.

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/package-lock.json server/.env.example server/src/config.ts server/src/config.test.ts server/src/supabase.ts server/src/supabase.test.ts server/src/db/testDb.ts
git commit -m "feat: add Supabase admin client, JWT verification, and config"
```

---

## Task 2: Schema — organizations, app_users, organization_id columns, invite-acceptance trigger

> **A structural point that shapes every step below:** Supabase's `auth.users` table is global to the whole project — it is NOT namespaced per-schema the way this codebase's existing tables are. `openTestDb()`'s isolation trick (a fresh `CREATE SCHEMA` per test run, with that schema first in the connection's `search_path`) works perfectly for the 5 pre-existing domain tables, which have no relationship to `auth.users`. But `app_users` has a hard FK to `auth.users(id)`, and the trigger that populates it fires from a single, global table — there is exactly one `auth.users`, so there can only usefully be one `app_users` and one trigger pointed at it, not one per test schema. `organizations` inherits the same constraint transitively (`app_users.organization_id REFERENCES organizations(id)`). **Resolution:** `organizations` and `app_users` are explicitly created in the `public` schema regardless of which schema a connection's `search_path` starts with, and `testDb.ts`'s per-test `search_path` gains `public` as a fallback (after the test's own schema) — so every test's queries against `connections`/`pipelines`/etc. keep resolving to that test's own isolated copy exactly as before (nothing changes there), while queries against `organizations`/`app_users` naturally fall through to the one shared `public` copy, since that's the only place those two tables exist. No application code needs to know about this — every unqualified `FROM app_users`/`FROM organizations` query in later tasks resolves correctly under this search_path with zero changes.

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/client.ts`
- Modify: `server/src/db/testDb.ts`
- Modify: `server/vitest.config.ts`

**Interfaces:**
- Produces: `organizations` table (with the one well-known default row), `app_users` table, `organization_id` on the 5 existing tables (`NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'`), a Postgres trigger that inserts into `app_users` whenever a new `auth.users` row carries `organization_id`/`role` in its metadata. Consumed by Task 4 (team.ts), Task 5 (bootstrap.ts).

- [ ] **Step -1: Disable test-file parallelism in `server/vitest.config.ts`**

`organizations`/`app_users` being shared, project-wide tables (this task's opening note) has a consequence beyond schema.sql: Vitest's default `fileParallelism: true` runs test files concurrently across worker threads. Every existing test file is safe under that default because each gets its own throwaway schema — but starting with this task, some test files (this one's own `schema.test.ts`, and Tasks 4/5/6's `team.test.ts`/`bootstrap.test.ts`/`routes.test.ts`) create and query rows in the ONE shared `app_users`/`organizations` tables in the real `sfcowboy-dev` project. Running those files concurrently risks one file's test polluting another's — most acutely, `bootstrap.test.ts`'s "is app_users empty" check racing against `team.test.ts`/`routes.test.ts` creating real rows in the same table at the same time. Add:

```ts
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // organizations/app_users are shared, project-wide tables in the real Supabase project (see
    // schema.sql's comments) -- unlike every other table, they are NOT isolated per test file's
    // own throwaway schema. Running test files in parallel risks one file's test data racing
    // against another's, most acutely bootstrapIfNeeded's "is app_users empty" check against any
    // other file creating real rows in that same shared table at the same time.
    fileParallelism: false,
  },
});
```

This makes the full server suite slower (sequential rather than parallel file execution) — an accepted, disclosed trade-off directly caused by Supabase's `auth.users` being a single global table with no per-schema equivalent, not something to work around with cleverer isolation.

- [ ] **Step 0: Update `server/src/db/testDb.ts`'s search_path option**

Change:

```ts
  const pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName}` });
```

to:

```ts
  // "public" is a fallback, not the primary target: an unqualified table name that exists in
  // this test's own schema (every pre-existing domain table) resolves there first, unaffected.
  // organizations/app_users exist ONLY in public (see Task 2's schema.sql -- they're tied to
  // Supabase's single, global auth.users table, so they can't be duplicated per test schema the
  // way the rest of this isolation trick duplicates everything else), so queries against them
  // fall through to the one shared copy instead of erroring "relation does not exist".
  const pool = new Pool({ connectionString: ADMIN_CONNECTION_STRING, options: `-c search_path=${schemaName},public` });
```

- [ ] **Step 1: Add to the top of `server/src/db/schema.sql`** (before the existing `connections` table — every other table's new `organization_id` column references this one, so it must exist first, exactly as this codebase's earlier schema work already learned the hard way):

```sql
-- Explicitly schema-qualified (unlike every other CREATE TABLE in this file) because this table
-- must always live in the one shared "public" schema, never inside a test run's own isolated
-- schema -- see this task's opening note on why organizations/app_users can't be duplicated
-- per-schema the way the rest of this file's tables are.
CREATE TABLE IF NOT EXISTS public.organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- The one organization every row belongs to until Plan 2 threads real per-request organization_id
-- values through every write path. Its id is a fixed, well-known constant (the nil UUID) rather
-- than a randomly generated one specifically so the DEFAULT clauses below can reference it as a
-- literal -- a random id wouldn't be knowable at schema-authoring time. ON CONFLICT DO NOTHING
-- makes this safe to re-run on every boot (matches this file's CREATE TABLE IF NOT EXISTS
-- idempotency elsewhere).
INSERT INTO public.organizations (id, name, created_at)
VALUES ('00000000-0000-0000-0000-000000000000', 'My Organization', '1970-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Add `organization_id` to the 5 existing tables' `CREATE TABLE` blocks**

In `connections`, `pipelines`, `pipeline_runs`, `deployments`, `deployment_items`, add this column (exact position doesn't matter, but keep it near the top of each block for readability). Leave `REFERENCES organizations(id)` unqualified here (unlike Step 1's `public.organizations`) — at the point this `CREATE TABLE` runs, `organizations` exists only in `public`, so the unqualified reference correctly resolves there via the search_path fallback Step 0 set up, in both a test schema and production's default search_path:

```sql
  organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id),
```

- [ ] **Step 3: Add to the end of `server/src/db/schema.sql`**

```sql
-- Explicitly schema-qualified for the same reason as public.organizations above -- tied to
-- Supabase's single, global auth.users table via the FK below, so it must always be the one
-- shared table, never duplicated per test schema.
CREATE TABLE IF NOT EXISTS public.app_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name TEXT NOT NULL,
  disabled_at TIMESTAMPTZ
);

-- Fires whenever Supabase creates a new auth.users row (via admin.inviteUserByEmail or
-- admin.createUser) that was given organization_id/role metadata at creation time -- both
-- Task 4's createInvite and Task 5's bootstrapIfNeeded pass this metadata, so this single
-- trigger is the one place app_users rows get created, for both flows. A user created with no
-- such metadata (shouldn't happen given this plan's own code, but defensively) is simply not
-- given an app_users row and therefore can never pass requireSupabaseUser's lookup.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user() RETURNS trigger AS $$
DECLARE
  org_id TEXT := NEW.raw_app_meta_data->>'organization_id';
  user_role TEXT := NEW.raw_app_meta_data->>'role';
  user_name TEXT := COALESCE(NEW.raw_app_meta_data->>'name', NEW.email);
BEGIN
  IF org_id IS NOT NULL AND user_role IS NOT NULL THEN
    INSERT INTO public.app_users (id, organization_id, role, name)
    VALUES (NEW.id, org_id, user_role, user_name)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();
```

- [ ] **Step 4: Update `server/src/db/client.ts`'s `runMigrations`**

Add, after the existing `ALTER TABLE` calls (idempotent upgrade path for a database that already ran an older version of this file):

```ts
  await db.query(
    `INSERT INTO organizations (id, name, created_at) VALUES ('00000000-0000-0000-0000-000000000000', 'My Organization', '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING`
  );
  for (const table of ["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"]) {
    await db.query(
      `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS organization_id TEXT NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' REFERENCES organizations(id)`
    );
  }
```

The `app_users` table and the trigger are created by `schema.sql`'s own `CREATE TABLE`/`CREATE OR REPLACE FUNCTION`/`DROP TRIGGER IF EXISTS`+`CREATE TRIGGER` statements, which already run unconditionally as part of the schema apply at the top of `runMigrations` — no separate `ALTER`-path equivalent is needed for a brand-new table or a replaceable function/trigger.

- [ ] **Step 5: Write `server/src/db/schema.test.ts`** (new file — this schema-level behavior isn't covered by any single domain module's own tests)

```ts
import { describe, it, expect } from "vitest";
import { openTestDb, type TestDb } from "./testDb.js";

describe("organizations + organization_id defaults", () => {
  let db: TestDb;

  it("creates the well-known default organization on a fresh database", async () => {
    db = await openTestDb();
    const result = await db.pool.query(`SELECT id, name FROM organizations WHERE id = '00000000-0000-0000-0000-000000000000'`);
    expect(result.rows).toHaveLength(1);
    await db.stop();
  });

  it("defaults organization_id to the well-known org on every existing table when omitted from an insert", async () => {
    db = await openTestDb();
    await db.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Test', '2026-01-01T00:00:00.000Z')`);
    const result = await db.pool.query(`SELECT organization_id FROM connections WHERE id = 'c1'`);
    expect(result.rows[0].organization_id).toBe("00000000-0000-0000-0000-000000000000");
    await db.stop();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd server && npx vitest run src/db/schema.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.sql server/src/db/client.ts server/src/db/schema.test.ts server/src/db/testDb.ts server/vitest.config.ts
git commit -m "feat: add organizations/app_users tables, organization_id defaults, invite-acceptance trigger"
```

---

## Task 3: `requireSupabaseUser` middleware

**Files:**
- Create: `server/src/users/requireSupabaseUser.ts`
- Create: `server/src/users/requireSupabaseUser.test.ts`

**Interfaces:**
- Consumes: `verifySupabaseJwt` (Task 1).
- Produces: `AppUser { id: string; organizationId: string; role: "admin" | "member"; name: string }`, `requireSupabaseUser(db: Pool, config: Config): RequestHandler` (attaches `req.user: AppUser`), the `declare global` Express `Request.user` augmentation. Consumed by Task 6 (routes.ts).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { requireSupabaseUser } from "./requireSupabaseUser.js";
import type { Config } from "../config.js";

const config: Config = {
  port: 3000,
  databaseUrl: "unused-in-tests",
  encryptionKey: "7".repeat(64),
  oauthCallbackUrl: "https://unused",
  sfClientId: "unused",
  supabaseUrl: "https://not-a-real-project.supabase.co",
  supabaseServiceRoleKey: "unused-in-tests",
  bootstrapOrgName: "unused-in-tests",
};

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await db.stop();
});

function buildApp() {
  const app = express();
  app.get("/protected", requireSupabaseUser(db.pool, config), (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

describe("requireSupabaseUser", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a malformed Bearer token", async () => {
    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});
```

Note: a positive-path test (a real, validly-signed token resolving to `req.user`) needs a real Supabase project and a matching `app_users` row — that's covered end-to-end by Task 4's `team.ts` tests, which exercise this middleware indirectly through real routes; duplicating that setup here for a third, redundant positive-path test isn't worth it. This file's own tests cover the failure modes this middleware is specifically responsible for (missing/invalid token), which don't need a real project.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/users/requireSupabaseUser.test.ts`
Expected: FAIL — `./requireSupabaseUser.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/requireSupabaseUser.ts`**

```ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { verifySupabaseJwt } from "../supabase.js";

export interface AppUser {
  id: string;
  organizationId: string;
  role: "admin" | "member";
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AppUser;
    }
  }
}

interface AppUserRow {
  id: string;
  organization_id: string;
  role: "admin" | "member";
  name: string;
  disabled_at: string | null;
}

function readBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

/**
 * Resolves the Supabase-issued access token into req.user, or responds 401 if the token is
 * missing, invalid, or belongs to a user with no app_users row (never invited/bootstrapped, or
 * disabled). This is the choke point every route that needs a logged-in user relies on -- see
 * requireAdmin (Task 6) for the additional admin-only check layered on top.
 */
export function requireSupabaseUser(db: Pool, config: Config): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readBearerToken(req);
    if (!token) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    let userId: string;
    try {
      const verified = await verifySupabaseJwt(config, token);
      userId = verified.userId;
    } catch {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const result = await db.query<AppUserRow>(`SELECT * FROM app_users WHERE id = $1`, [userId]);
    const row = result.rows[0];
    if (!row || row.disabled_at !== null) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.user = { id: row.id, organizationId: row.organization_id, role: row.role, name: row.name };
    next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/users/requireSupabaseUser.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/requireSupabaseUser.ts server/src/users/requireSupabaseUser.test.ts
git commit -m "feat: add requireSupabaseUser middleware"
```

---

## Task 4: `team.ts` — invite, list, reset password, remove

**Files:**
- Create: `server/src/users/team.ts`
- Create: `server/src/users/team.test.ts`

**Interfaces:**
- Consumes: `createSupabaseAdminClient` (Task 1), `app_users` table + trigger (Task 2).
- Produces: `TeamMember { id, email, name, role, disabledAt }`, `listTeamMembers(db, admin, organizationId): Promise<TeamMember[]>`, `createInvite(admin, organizationId, email, role): Promise<void>`, `sendPasswordReset(admin, email): Promise<void>`, `removeMember(db, organizationId, userId): Promise<void>`. Consumed by Task 6 (routes.ts).

- [ ] **Step 1: Write the failing test**

This test needs a real Supabase project (`admin.inviteUserByEmail`/`admin.createUser` are real network calls with no meaningful mock, matching this codebase's established "test against the real thing" convention) — skip if `SUPABASE_URL` isn't the real dev project, same pattern as Task 1's `supabase.test.ts`.

```ts
import "dotenv/config";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig } from "../config.js";
import { listTeamMembers, createInvite, sendPasswordReset, removeMember } from "./team.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("team management", () => {
  let db: TestDb;
  const config = loadConfig();
  const admin = createSupabaseAdminClient(config);
  const createdUserIds: string[] = [];
  // organizations now lives only in the shared "public" schema (see Task 2's opening note) --
  // unlike the 5 pre-existing domain tables, it is NOT dropped when this test's own schema is
  // torn down, so every org this file creates must be explicitly deleted here or it leaks into
  // the real sfcowboy-dev project's organizations table forever.
  const createdOrgIds: string[] = [];

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await db.stop();
  });

  async function seedOrgAndMember(db: TestDb, organizationId: string, role: "admin" | "member" = "member") {
    createdOrgIds.push(organizationId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      organizationId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `team-test-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: "a-good-test-password-1",
      email_confirm: true,
      app_metadata: { organization_id: organizationId, role },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    // The trigger fires inside Supabase's own Postgres project (the real db.pool connection IS
    // that project in this test file), so no manual app_users insert is needed here -- but give
    // it a moment: the trigger commits as part of the same transaction Supabase's own createUser
    // call runs, so it's visible immediately once createUser's promise resolves.
    return { id: data.user!.id, email };
  }

  it("lists only the members of the given organization, not another org's", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const memberA = await seedOrgAndMember(db, orgA);
    await seedOrgAndMember(db, orgB);

    const members = await listTeamMembers(db.pool, admin, orgA);
    expect(members).toHaveLength(1);
    expect(members[0].id).toBe(memberA.id);
    expect(members[0].email).toBe(memberA.email);
  });

  it("createInvite creates an auth user with the right organization/role metadata, and the trigger creates the matching app_users row", async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, "Test Org", new Date().toISOString()]);
    const email = `invite-test-${randomUUID()}@example.com`;

    await createInvite(admin, orgId, email, "member");

    const { data: usersPage } = await admin.auth.admin.listUsers();
    const invited = usersPage.users.find((u) => u.email === email);
    expect(invited).toBeDefined();
    createdUserIds.push(invited!.id);

    const appUserRow = await db.pool.query(`SELECT organization_id, role FROM app_users WHERE id = $1`, [invited!.id]);
    expect(appUserRow.rows[0]).toEqual({ organization_id: orgId, role: "member" });
  });

  it("removeMember disables the app_users row without deleting it, and refuses to remove a user outside the given organization", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const memberA = await seedOrgAndMember(db, orgA);

    await removeMember(db.pool, orgA, memberA.id);
    const row = await db.pool.query(`SELECT disabled_at FROM app_users WHERE id = $1`, [memberA.id]);
    expect(row.rows[0].disabled_at).not.toBeNull();

    await expect(removeMember(db.pool, orgB, memberA.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/users/team.test.ts`
Expected: FAIL — `./team.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/team.ts`**

```ts
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabledAt: string | null;
}

interface AppUserRow {
  id: string;
  role: "admin" | "member";
  name: string;
  disabled_at: string | null;
}

/**
 * Joins app_users (this app's org/role data) with auth.users (Supabase's own record, which is
 * where email lives) via the admin API's listUsers -- there's no Postgres view into auth.users in
 * this design (see the spec's Data Model section), so the join happens in application code
 * instead of SQL. Fine at this scale; a team is expected to be a handful of people, not thousands.
 */
export async function listTeamMembers(db: Pool, admin: SupabaseClient, organizationId: string): Promise<TeamMember[]> {
  const appUsers = await db.query<AppUserRow>(`SELECT id, role, name, disabled_at FROM app_users WHERE organization_id = $1`, [organizationId]);
  if (appUsers.rows.length === 0) return [];

  const { data, error } = await admin.auth.admin.listUsers();
  if (error) throw error;
  const emailById = new Map(data.users.map((u) => [u.id, u.email ?? ""]));

  return appUsers.rows.map((row) => ({
    id: row.id,
    email: emailById.get(row.id) ?? "",
    name: row.name,
    role: row.role,
    disabledAt: row.disabled_at,
  }));
}

/**
 * Admin action: invites a new teammate by email. Supabase creates the auth.users row immediately
 * (unconfirmed, no password yet) and sends the actual invite email -- the organization_id/role
 * metadata attached here is what Task 2's trigger reads to create the matching app_users row, so
 * the invitee is already correctly scoped before they ever click the link.
 */
export async function createInvite(admin: SupabaseClient, organizationId: string, email: string, role: "admin" | "member"): Promise<void> {
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { organization_id: organizationId, role },
  });
  if (error) throw error;
}

/**
 * Admin action: triggers Supabase's own password-reset email to the given address -- the same
 * flow a user reaches themselves via "Forgot password?" on the login page, just initiated by an
 * admin on a teammate's behalf. No temporary password is ever generated or transmitted by this
 * app -- Supabase owns the whole reset flow end to end.
 */
export async function sendPasswordReset(admin: SupabaseClient, email: string): Promise<void> {
  const { error } = await admin.auth.resetPasswordForEmail(email);
  if (error) throw error;
}

async function getMemberInOrg(db: Pool, organizationId: string, userId: string): Promise<AppUserRow> {
  const result = await db.query<AppUserRow>(`SELECT id, role, name, disabled_at FROM app_users WHERE id = $1 AND organization_id = $2`, [
    userId,
    organizationId,
  ]);
  const row = result.rows[0];
  if (!row) throw new Error(`No member with id ${userId} in this organization`);
  return row;
}

/** Admin action: soft-deletes the member (app_users.disabled_at) -- this is the load-bearing
 * enforcement point once requireSupabaseUser is applied to a route (Plan 2), since it's checked
 * on every request regardless of whether the member's Supabase JWT is still cryptographically
 * valid. Does not delete or ban the underlying Supabase auth user in this plan -- see the design
 * spec's note that this is a worthwhile but non-critical belt-and-suspenders addition, left for a
 * later pass rather than this plan. */
export async function removeMember(db: Pool, organizationId: string, userId: string): Promise<void> {
  await getMemberInOrg(db, organizationId, userId);
  await db.query(`UPDATE app_users SET disabled_at = $1 WHERE id = $2`, [new Date().toISOString(), userId]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/users/team.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests, against the real `sfcowboy-dev` project).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/team.ts server/src/users/team.test.ts
git commit -m "feat: add team management (invite, list, password-reset, remove)"
```

---

## Task 5: `bootstrap.ts` — first admin user

**Files:**
- Create: `server/src/users/bootstrap.ts`
- Create: `server/src/users/bootstrap.test.ts`

**Interfaces:**
- Consumes: `createSupabaseAdminClient` (Task 1), `app_users` table + trigger (Task 2).
- Produces: `bootstrapIfNeeded(db: Pool, admin: SupabaseClient, config: Config): Promise<void>`. Consumed by Task 7 (`index.ts`).

- [ ] **Step 1: Write the failing test**

Needs a real Supabase project — same skip pattern as Tasks 1 and 4.

```ts
import "dotenv/config";
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig, type Config } from "../config.js";
import { bootstrapIfNeeded } from "./bootstrap.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

// app_users is a shared, project-wide table in the real sfcowboy-dev project (see Task 2's
// opening note) -- this file's "empty" test relies on no OTHER row existing there when it runs.
// Sequential file execution (server/vitest.config.ts's fileParallelism: false, added in Task 2)
// and every other test file's own afterEach cleanup keep this true in the automated suite. It
// will start failing if a real admin is ever manually bootstrapped against sfcowboy-dev (e.g.
// Task 15's manual smoke test, which necessarily runs after this task) -- an accepted, disclosed
// limitation of testing against a real, persistent, shared project rather than a disposable one,
// not something to engineer around here.
describe.skipIf(!hasRealSupabaseProject)("bootstrapIfNeeded", () => {
  let db: TestDb;
  const baseConfig = loadConfig();
  const admin = createSupabaseAdminClient(baseConfig);
  let createdUserId: string | undefined;

  afterEach(async () => {
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      createdUserId = undefined;
    }
    await db.stop();
  });

  it("creates one admin user scoped to the default organization when app_users is empty", async () => {
    db = await openTestDb();
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };

    await bootstrapIfNeeded(db.pool, admin, config);

    const { data } = await admin.auth.admin.listUsers();
    const created = data.users.find((u) => u.email === email);
    expect(created).toBeDefined();
    createdUserId = created!.id;

    const row = await db.pool.query(`SELECT organization_id, role FROM app_users WHERE id = $1`, [created!.id]);
    expect(row.rows[0]).toEqual({ organization_id: "00000000-0000-0000-0000-000000000000", role: "admin" });
  });

  it("is a no-op on a second call once an admin already exists", async () => {
    db = await openTestDb();
    const email = `bootstrap-test-${Date.now()}@example.com`;
    const config: Config = { ...baseConfig, bootstrapAdminEmail: email, bootstrapAdminPassword: "a-good-test-password-1" };
    await bootstrapIfNeeded(db.pool, admin, config);
    const { data: firstPass } = await admin.auth.admin.listUsers();
    createdUserId = firstPass.users.find((u) => u.email === email)!.id;

    await bootstrapIfNeeded(db.pool, admin, config);
    const { data: secondPass } = await admin.auth.admin.listUsers();
    expect(secondPass.users.filter((u) => u.email === email)).toHaveLength(1);
  });

  it("throws a clear error if app_users is empty but the bootstrap credentials aren't set", async () => {
    db = await openTestDb();
    await expect(bootstrapIfNeeded(db.pool, admin, baseConfig)).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/users/bootstrap.test.ts`
Expected: FAIL — `./bootstrap.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/bootstrap.ts`**

```ts
import type { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "../config.js";

const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Runs once per environment, the first time the app boots against a database with no admin user
 * yet: creates one admin Supabase user in the well-known default organization (already guaranteed
 * to exist by schema.sql/runMigrations -- see Task 2 -- so this function only needs to create the
 * user, not the organization). Idempotent -- a no-op on every later boot once app_users is
 * non-empty, called from index.ts right after runMigrations.
 *
 * Passing organization_id/role as app_metadata on createUser means Task 2's trigger creates the
 * matching app_users row automatically -- the same mechanism createInvite (team.ts) uses, so
 * there's exactly one code path in this codebase that ever inserts into app_users.
 */
export async function bootstrapIfNeeded(db: Pool, admin: SupabaseClient, config: Config): Promise<void> {
  const existing = await db.query(`SELECT id FROM app_users LIMIT 1`);
  if (existing.rows.length > 0) return;

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    throw new Error(
      "No admin user exists yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "Set both env vars and restart to create the first admin account."
    );
  }

  const { error } = await admin.auth.admin.createUser({
    email: config.bootstrapAdminEmail,
    password: config.bootstrapAdminPassword,
    email_confirm: true,
    app_metadata: { organization_id: DEFAULT_ORGANIZATION_ID, role: "admin", name: "Admin" },
  });
  if (error) throw error;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/users/bootstrap.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/bootstrap.ts server/src/users/bootstrap.test.ts
git commit -m "feat: add bootstrapIfNeeded for the first admin user"
```

---

## Task 6: Express router — team management HTTP routes

**Files:**
- Create: `server/src/users/routes.ts`
- Create: `server/src/users/routes.test.ts`

**Interfaces:**
- Consumes: `requireSupabaseUser` (Task 3), `listTeamMembers`/`createInvite`/`sendPasswordReset`/`removeMember` (Task 4), `createSupabaseAdminClient` (Task 1).
- Produces: `createUsersRouter(db: Pool, config: Config): Router`. Consumed by Task 7 (`app.ts`).

**Note:** unlike the abandoned PR #1, there is no `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, or `/api/invites/*` here — those are handled entirely client-side by `@supabase/supabase-js` talking directly to Supabase (see Task 9). This router only carries the admin-only, service-role-key-requiring operations.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { loadConfig } from "../config.js";
import { createUsersRouter } from "./routes.js";

const hasRealSupabaseProject = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasRealSupabaseProject)("users router", () => {
  let db: TestDb;
  const config = loadConfig();
  const admin = createSupabaseAdminClient(config);
  const createdUserIds: string[] = [];
  // organizations lives only in the shared "public" schema (see Task 2's opening note), so every
  // org this file creates must be explicitly deleted here or it leaks into the real sfcowboy-dev
  // project forever.
  const createdOrgIds: string[] = [];

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await admin.auth.admin.deleteUser(id).catch(() => {});
    }
    for (const id of createdOrgIds.splice(0)) {
      await db.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]).catch(() => {});
    }
    await db.stop();
  });

  async function seedOrgAndAdmin(organizationId: string) {
    createdOrgIds.push(organizationId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      organizationId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `admin-test-${randomUUID()}@example.com`;
    const password = "a-good-test-password-1";
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { organization_id: organizationId, role: "admin" },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    const { data: sessionData } = await admin.auth.signInWithPassword({ email, password });
    return { token: sessionData.session!.access_token, userId: data.user!.id };
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(createUsersRouter(db.pool, config));
    return app;
  }

  it("GET /api/team requires authentication", async () => {
    const res = await request(buildApp()).get("/api/team");
    expect(res.status).toBe(401);
  });

  it("an admin lists the team, invites a member, and removes them", async () => {
    const orgId = randomUUID();
    const { token } = await seedOrgAndAdmin(orgId);
    const app = buildApp();

    const listRes = await request(app).get("/api/team").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const inviteEmail = `invitee-${randomUUID()}@example.com`;
    const inviteRes = await request(app).post("/api/team/invites").set("Authorization", `Bearer ${token}`).send({ email: inviteEmail, role: "member" });
    expect(inviteRes.status).toBe(200);

    const { data } = await admin.auth.admin.listUsers();
    const invited = data.users.find((u) => u.email === inviteEmail)!;
    createdUserIds.push(invited.id);

    const removeRes = await request(app).delete(`/api/team/${invited.id}`).set("Authorization", `Bearer ${token}`);
    expect(removeRes.status).toBe(204);
  });

  it("returns a generic 404 for a cross-org target instead of leaking the id-embedding error", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const { token } = await seedOrgAndAdmin(orgA);
    const { userId: userInOrgB } = await seedOrgAndAdmin(orgB);
    const app = buildApp();

    const res = await request(app).delete(`/api/team/${userInOrgB}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member not found" });
  });

  it("a non-admin gets 403 from an admin-only route", async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [
      orgId,
      "Test Org",
      new Date().toISOString(),
    ]);
    const email = `member-test-${randomUUID()}@example.com`;
    const password = "a-good-test-password-1";
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { organization_id: orgId, role: "member" },
    });
    if (error) throw error;
    createdUserIds.push(data.user!.id);
    const { data: sessionData } = await admin.auth.signInWithPassword({ email, password });

    const res = await request(buildApp()).get("/api/team").set("Authorization", `Bearer ${sessionData.session!.access_token}`);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/users/routes.test.ts`
Expected: FAIL — `./routes.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/routes.ts`**

```ts
import { Router } from "express";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { createSupabaseAdminClient } from "../supabase.js";
import { requireSupabaseUser } from "./requireSupabaseUser.js";
import { listTeamMembers, createInvite, sendPasswordReset, removeMember } from "./team.js";

function requireAdmin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function createUsersRouter(db: Pool, config: Config): Router {
  const router = Router();
  const admin = createSupabaseAdminClient(config);
  const auth = requireSupabaseUser(db, config);

  router.get("/api/team", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    res.json(members);
  });

  router.post("/api/team/invites", auth, requireAdmin, async (req, res) => {
    const { email, role } = req.body as { email?: unknown; role?: unknown };
    if (typeof email !== "string" || email === "" || (role !== "admin" && role !== "member")) {
      res.status(400).json({ error: "email and role ('admin' or 'member') are required" });
      return;
    }
    await createInvite(admin, req.user!.organizationId, email, role);
    res.status(200).json({ ok: true });
  });

  router.post("/api/team/:userId/reset-password", auth, requireAdmin, async (req, res) => {
    const members = await listTeamMembers(db, admin, req.user!.organizationId);
    const target = members.find((m) => m.id === req.params.userId);
    if (!target) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    await sendPasswordReset(admin, target.email);
    res.status(200).json({ ok: true });
  });

  router.delete("/api/team/:userId", auth, requireAdmin, async (req, res) => {
    try {
      await removeMember(db, req.user!.organizationId, req.params.userId);
    } catch {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    res.status(204).send();
  });

  return router;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/users/routes.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/routes.ts server/src/users/routes.test.ts
git commit -m "feat: add team management HTTP routes"
```

---

## Task 7: Wire into `app.ts` and `index.ts`

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/app.test.ts`

**Interfaces:**
- Consumes: `createUsersRouter` (Task 6), `bootstrapIfNeeded` (Task 5), `createSupabaseAdminClient` (Task 1).

- [ ] **Step 1: Update `server/src/app.ts`**

```ts
import "express-async-errors";
import path from "node:path";
import express from "express";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";
import { createUsersRouter } from "./users/routes.js";

export function createApp(db: Pool, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createUsersRouter(db, config));
  app.use(createAuthRouter(db, config));
  app.use(createConnectionsRouter(db, config));
  app.use(createEngineRouter(db, config, dataDir));
  app.use(createPipelinesRouter(db, config, dataDir));

  if (webDistDir) {
    // Resolved once here (rather than inline in sendFile below) so both express.static and
    // sendFile agree on an absolute path -- a relative WEB_DIST_DIR previously crashed sendFile
    // with "path must be absolute or specify root", a pre-existing bug independently found and
    // fixed during PR #1's own manual verification before that PR was abandoned; carried forward
    // here since this file is being rewritten anyway.
    const resolvedWebDistDir = path.resolve(webDistDir);
    app.use(express.static(resolvedWebDistDir));
    app.get(/^(?!\/api|\/oauth).*/, (_req, res) => {
      res.sendFile(path.join(resolvedWebDistDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error in request handler", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
```

- [ ] **Step 2: Update `server/src/index.ts`**

```ts
import "dotenv/config";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { createSupabaseAdminClient } from "./supabase.js";
import { bootstrapIfNeeded } from "./users/bootstrap.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.databaseUrl);
await runMigrations(db);
await bootstrapIfNeeded(db, createSupabaseAdminClient(config), config);

const app = createApp(db, config, dataDir, process.env.WEB_DIST_DIR);

startScheduler(db, config, dataDir, 30_000);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
```

- [ ] **Step 3: Update `server/src/app.test.ts`**

Read the file first to see its exact current structure and existing `Config` fixture(s) (it likely already needed updating in Task 1's Step 4 for the new required fields — confirm that's already done, don't duplicate). Add a test confirming the new router is mounted, following the file's existing "mounts the X router" test pattern for the other routers:

```ts
  it("mounts the users router", async () => {
    const app = createApp(testDb.pool, config, dataDir);
    const res = await request(app).get("/api/team");
    // 401 (not authenticated), not 404 -- proves the route exists and requireSupabaseUser ran.
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 4: Run the full server test suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: fully clean. Every existing test for `connections`/`pipelines`/`engine` routes should be completely unaffected — this task doesn't touch their authorization behavior (see Global Constraints).

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/app.test.ts
git commit -m "feat: wire users router and bootstrap into app.ts/index.ts"
```

---

## Task 8: Data migration script

**Files:**
- Create: `server/scripts/migrate-to-supabase.ts`
- Create: `server/scripts/migrate-to-supabase.test.ts`

**Interfaces:**
- Produces: `migrateToSupabase(sourcePool: Pool, targetPool: Pool, organizationId: string): Promise<{ table: string; rowCount: number }[]>`, plus a CLI entrypoint. Standalone — nothing else in this plan consumes it; it's run once, by hand, during the production cutover (see the spec's Migration Plan).

- [ ] **Step 1: Write the failing test**

Uses two `openTestDb()` instances (source and target) to prove the copy logic itself, rather than needing the real `sfcowboy-prod` project — the copy is plain Postgres-to-Postgres SQL with no Supabase-specific behavior in it.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { migrateToSupabase } from "./migrate-to-supabase.js";

describe("migrateToSupabase", () => {
  let source: TestDb;
  let target: TestDb;

  afterEach(async () => {
    await source?.stop();
    await target?.stop();
  });

  it("copies every row from source to target, assigning the given organization_id", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await target.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, "Migrated Org", new Date().toISOString()]);

    await source.pool.query(
      `INSERT INTO connections (id, type, nickname, created_at) VALUES ('c1', 'git', 'Source Connection', '2026-01-01T00:00:00.000Z')`
    );
    await source.pool.query(
      `INSERT INTO pipelines (id, name, connection_ids, status) VALUES ('p1', 'Source Pipeline', '["c1"]', 'active')`
    );

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);

    const connectionsCopied = summary.find((s) => s.table === "connections");
    expect(connectionsCopied?.rowCount).toBe(1);

    const targetConnection = await target.pool.query(`SELECT nickname, organization_id FROM connections WHERE id = 'c1'`);
    expect(targetConnection.rows[0]).toEqual({ nickname: "Source Connection", organization_id: orgId });

    const targetPipeline = await target.pool.query(`SELECT name, organization_id FROM pipelines WHERE id = 'p1'`);
    expect(targetPipeline.rows[0].organization_id).toBe(orgId);
  });

  it("is safe to run when a table has zero rows", async () => {
    source = await openTestDb();
    target = await openTestDb();
    const orgId = "11111111-1111-1111-1111-111111111111";
    await target.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, "Migrated Org", new Date().toISOString()]);

    const summary = await migrateToSupabase(source.pool, target.pool, orgId);
    expect(summary.every((s) => s.rowCount === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run scripts/migrate-to-supabase.test.ts`
Expected: FAIL — `./migrate-to-supabase.js` doesn't exist yet.

- [ ] **Step 3: Create `server/scripts/migrate-to-supabase.ts`**

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

// Order matters: deployments/deployment_items reference connections and pipeline_runs via
// foreign keys, and pipeline_runs references pipelines -- copying in dependency order avoids a
// foreign-key violation on the target (which starts empty, unlike the source).
const TABLES_IN_DEPENDENCY_ORDER = ["connections", "pipelines", "pipeline_runs", "deployments", "deployment_items"] as const;

export interface MigrationTableSummary {
  table: string;
  rowCount: number;
}

/**
 * Copies every row from `sourcePool` into `targetPool`, table by table, setting organization_id
 * to the given value on every row as it's inserted (overriding whatever the source table's
 * DEFAULT would have produced, since the source is main's pre-Supabase schema which may not even
 * have this column at all yet). Both pools must already have the target schema applied
 * (organizations row for organizationId must already exist -- run `npm run build && node
 * dist/index.js` once against the target first, or apply schema.sql directly, before running
 * this).
 */
export async function migrateToSupabase(sourcePool: Pool, targetPool: Pool, organizationId: string): Promise<MigrationTableSummary[]> {
  const summary: MigrationTableSummary[] = [];

  for (const table of TABLES_IN_DEPENDENCY_ORDER) {
    const { rows } = await sourcePool.query(`SELECT * FROM ${table}`);
    for (const row of rows) {
      const columns = Object.keys(row).filter((c) => c !== "organization_id");
      const values = columns.map((c) => row[c]);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      await targetPool.query(
        `INSERT INTO ${table} (${columns.join(", ")}, organization_id) VALUES (${placeholders.join(", ")}, $${columns.length + 1})`,
        [...values, organizationId]
      );
    }
    summary.push({ table, rowCount: rows.length });
  }

  return summary;
}

// Only run the CLI entrypoint when this file is executed directly (`tsx scripts/migrate-...`),
// not when migrateToSupabase is imported by the test above. Compared as resolved filesystem
// paths (not raw URL/argv strings) so this works cross-platform: on Windows, process.argv[1] uses
// backslashes while import.meta.url is a `file://` URL with forward slashes, so a direct string
// comparison never matches there and the CLI would silently no-op. (Identical guard to
// scripts/migrate-sqlite-to-postgres.ts's own — copied verbatim, not reinvented.)
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.DATABASE_URL;
  const organizationId = process.env.MIGRATION_ORGANIZATION_ID;
  if (!sourceUrl || !targetUrl || !organizationId) {
    console.error("Usage: SOURCE_DATABASE_URL=... DATABASE_URL=<supabase> MIGRATION_ORGANIZATION_ID=... tsx scripts/migrate-to-supabase.ts");
    process.exit(1);
  }
  const sourcePool = new Pool({ connectionString: sourceUrl });
  const targetPool = new Pool({ connectionString: targetUrl });
  const summary = await migrateToSupabase(sourcePool, targetPool, organizationId);
  console.table(summary);
  await sourcePool.end();
  await targetPool.end();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run scripts/migrate-to-supabase.test.ts && npx tsc --noEmit`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the script to `server/package.json`**

```json
"migrate-to-supabase": "tsx scripts/migrate-to-supabase.ts"
```

- [ ] **Step 6: Commit**

```bash
git add server/scripts/migrate-to-supabase.ts server/scripts/migrate-to-supabase.test.ts server/package.json
git commit -m "feat: add data migration script for the Supabase cutover"
```

---

## Task 9: Frontend — Supabase browser client

**Files:**
- Modify: `web/package.json`
- Modify: `web/.env.example` (create if it doesn't exist — check first)
- Create: `web/src/supabaseClient.ts`

**Interfaces:**
- Produces: `supabase: SupabaseClient` (a singleton). Consumed by Tasks 10–13.

- [ ] **Step 1: Install dependency**

```bash
cd web && npm install @supabase/supabase-js
```

- [ ] **Step 2: Add to `web/.env.example`** (or create it if this file doesn't exist yet — check `web/vite.config.ts` for how env vars are currently loaded, Vite's default `import.meta.env.VITE_*` convention should already apply with no config change needed)

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=
```

The `anon` key is public by design (safe to ship in a browser bundle) — this is different from the server's `service_role` key (Task 1), which must never appear here.

- [ ] **Step 3: Create `web/src/supabaseClient.ts`**

```ts
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — check web/.env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
```

- [ ] **Step 4: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/package.json web/package-lock.json web/.env.example web/src/supabaseClient.ts
git commit -m "feat: add Supabase browser client"
```

---

## Task 10: Frontend — Login page

**Files:**
- Create: `web/src/pages/Login.tsx`
- Create: `web/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 9).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
  },
}));

describe("Login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("submits email and password and redirects to / on success", async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({ data: {} as any, error: null });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "password123" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows the server's error message on failed login", async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({ data: {} as any, error: { message: "Invalid login credentials" } as any });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Invalid login credentials")).toBeInTheDocument();
  });

  it("sends a password reset email and shows a confirmation instead of the form", async () => {
    vi.mocked(supabase.auth.resetPasswordForEmail).mockResolvedValue({ data: {}, error: null } as any);
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /forgot password/i }));

    await waitFor(() => expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledWith("a@example.com", expect.objectContaining({ redirectTo: expect.stringContaining("/reset-password") })));
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/Login.test.tsx`
Expected: FAIL — `./Login.js` doesn't exist yet.

- [ ] **Step 3: Create `web/src/pages/Login.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  async function handleForgotPassword() {
    if (!email) {
      setError("Enter your email above first, then click Forgot password?");
      return;
    }
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setResetSent(true);
  }

  if (resetSent) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <h1>Check your email</h1>
          <p>If an account exists for {email}, a password reset link has been sent.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Log in</h1>
        {error && <div className="error-banner">{error}</div>}
        <label htmlFor="login-email">Email</label>
        <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" disabled={submitting}>
          Log in
        </button>
        <button type="button" onClick={handleForgotPassword}>
          Forgot password?
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/Login.test.tsx`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Login.tsx web/src/pages/Login.test.tsx
git commit -m "feat: add Login page with Supabase email/password and forgot-password"
```

---

## Task 11: Frontend — Reset Password page

**Files:**
- Create: `web/src/pages/ResetPassword.tsx`
- Create: `web/src/pages/ResetPassword.test.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 9).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ResetPassword } from "./ResetPassword.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: { auth: { updateUser: vi.fn() } },
}));

describe("ResetPassword", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("sets the new password and redirects to / on success", async () => {
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: null });
    render(
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "a-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "a-new-password-1" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error on failure without redirecting", async () => {
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: { message: "Password too short" } as any });
    render(
      <MemoryRouter>
        <ResetPassword />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));

    expect(await screen.findByText("Password too short")).toBeInTheDocument();
    expect(window.location.href).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/ResetPassword.test.tsx`
Expected: FAIL — `./ResetPassword.js` doesn't exist yet.

- [ ] **Step 3: Create `web/src/pages/ResetPassword.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";

// Reached two ways, both handled identically by this one page: (1) a password-reset email link
// (Login.tsx's "Forgot password?"), and (2) an admin-triggered reset email (Team.tsx). Either
// way, Supabase's client SDK auto-detects the recovery token in the URL fragment on page load and
// establishes a temporary session scoped to just this action -- updateUser({ password }) is the
// only call this page needs to make; it doesn't need to read the token itself.
export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Set a new password</h1>
        {error && <div className="error-banner">{error}</div>}
        <label htmlFor="reset-password">New password</label>
        <input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
        <button type="submit" disabled={submitting}>
          Set new password
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/ResetPassword.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ResetPassword.tsx web/src/pages/ResetPassword.test.tsx
git commit -m "feat: add Reset Password page"
```

---

## Task 12: Frontend — Accept Invite page

**Files:**
- Create: `web/src/pages/AcceptInvite.tsx`
- Create: `web/src/pages/AcceptInvite.test.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 9).

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AcceptInvite } from "./AcceptInvite.js";
import { supabase } from "../supabaseClient.js";

vi.mock("../supabaseClient.js", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
      updateUser: vi.fn(),
    },
  },
}));

describe("AcceptInvite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the invited email once loaded, then sets a password and redirects", async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: { email: "newbie@example.com" } } as any, error: null });
    vi.mocked(supabase.auth.updateUser).mockResolvedValue({ data: {} as any, error: null });

    render(
      <MemoryRouter>
        <AcceptInvite />
      </MemoryRouter>
    );
    expect(await screen.findByText(/newbie@example.com/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: "a-good-password" }));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error and no form when there's no pending invite session", async () => {
    vi.mocked(supabase.auth.getUser).mockResolvedValue({ data: { user: null }, error: null } as any);
    render(
      <MemoryRouter>
        <AcceptInvite />
      </MemoryRouter>
    );
    expect(await screen.findByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/AcceptInvite.test.tsx`
Expected: FAIL — `./AcceptInvite.js` doesn't exist yet.

- [ ] **Step 3: Create `web/src/pages/AcceptInvite.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";

// Reached from Supabase's own invite email link, which (like ResetPassword.tsx) establishes a
// temporary session client-side before this component even mounts. getUser() reads that session
// to show which address is being set up; updateUser({ password }) finalizes the account -- the
// underlying auth.users row (and its app_users row, via Task 2's trigger) already exists from the
// moment the admin sent the invite (team.ts's createInvite), so nothing here creates anything new.
export function AcceptInvite() {
  const [email, setEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user?.email) {
        setLoadError("This invite link is invalid or has expired");
        return;
      }
      setEmail(data.user.email);
    });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSubmitError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  if (loadError) {
    return (
      <div className="auth-page">
        <div className="error-banner">{loadError}</div>
      </div>
    );
  }

  if (!email) {
    return <div className="auth-page">Loading…</div>;
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Set your password</h1>
        <p>
          Creating an account for <strong>{email}</strong>
        </p>
        {submitError && <div className="error-banner">{submitError}</div>}
        <label htmlFor="invite-password">Password</label>
        <input id="invite-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
        <button type="submit" disabled={submitting}>
          Set password
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/AcceptInvite.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/AcceptInvite.tsx web/src/pages/AcceptInvite.test.tsx
git commit -m "feat: add Accept Invite page"
```

---

## Task 13: Frontend — Team page and UserMenu

**Files:**
- Create: `web/src/pages/Team.tsx`
- Create: `web/src/pages/Team.test.tsx`
- Create: `web/src/UserMenu.tsx`
- Create: `web/src/UserMenu.test.tsx`
- Modify: `web/src/api/client.ts` (add the team-management fetch wrappers only — no other existing export in this file changes, per Global Constraints)

**Interfaces:**
- Consumes: `supabase` (Task 9), `/api/team*` routes (Task 6).
- Produces: `fetchTeam`, `createTeamInvite`, `sendMemberPasswordReset`, `removeMember`, `TeamMember` (client.ts); `Team`, `UserMenu` components. Consumed by Task 14.

- [ ] **Step 1: Add to `web/src/api/client.ts`**

Every call here attaches the current Supabase session's access token — these are the only endpoints in this plan that need it, since existing endpoints aren't gated yet (Global Constraints).

```ts
import { supabase } from "../supabaseClient.js";

// ... existing content unchanged ...

async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(options.headers);
  if (data.session) headers.set("Authorization", `Bearer ${data.session.access_token}`);
  return fetch(url, { ...options, headers });
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabledAt: string | null;
}

export function fetchTeam(): Promise<TeamMember[]> {
  return authedFetch("/api/team").then((r) => json(r));
}

export function createTeamInvite(input: { email: string; role: "admin" | "member" }): Promise<void> {
  return authedFetch("/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(checkOk);
}

export function sendMemberPasswordReset(userId: string): Promise<void> {
  return authedFetch(`/api/team/${userId}/reset-password`, { method: "POST" }).then(checkOk);
}

export function removeMember(userId: string): Promise<void> {
  return authedFetch(`/api/team/${userId}`, { method: "DELETE" }).then(checkOk);
}
```

- [ ] **Step 2: Write `web/src/UserMenu.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UserMenu } from "./UserMenu.js";
import { supabase } from "./supabaseClient.js";

vi.mock("./supabaseClient.js", () => ({
  supabase: { auth: { signOut: vi.fn() } },
}));

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name", () => {
    render(<UserMenu name="Ada" email="a@example.com" />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null });
    render(<UserMenu name="Ada" email="a@example.com" />);

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
```

- [ ] **Step 3: Create `web/src/UserMenu.tsx`**

```tsx
import { supabase } from "./supabaseClient.js";

export function UserMenu({ name, email }: { name: string; email: string }) {
  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="user-menu">
      <span className="user-menu-name" title={email}>
        {name}
      </span>
      <button type="button" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Write `web/src/pages/Team.test.tsx`**

Same shape as the abandoned PR #1's version, adapted for the new invite/reset semantics (no link/temp-password ever shown — Supabase sends the email directly):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Team } from "./Team.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

const MEMBERS: api.TeamMember[] = [
  { id: "u1", email: "admin@example.com", name: "Admin", role: "admin", disabledAt: null },
  { id: "u2", email: "member@example.com", name: "Member", role: "member", disabledAt: null },
];

describe("Team", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchTeam).mockResolvedValue(MEMBERS);
  });

  it("lists every member with their role", async () => {
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });

  it("invites a teammate and shows a confirmation, not a link", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(api.createTeamInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "member" }));
    expect(await screen.findByText(/invite sent to new@example.com/i)).toBeInTheDocument();
  });

  it("sends a password reset email for a member", async () => {
    vi.mocked(api.sendMemberPasswordReset).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    const memberRow = (await screen.findByText("member@example.com")).closest("tr")!;

    fireEvent.click(within(memberRow).getByRole("button", { name: /send password reset/i }));

    await waitFor(() => expect(api.sendMemberPasswordReset).toHaveBeenCalledWith("u2"));
    expect(await screen.findByText(/password reset email sent/i)).toBeInTheDocument();
  });

  it("removes a member and refetches the list", async () => {
    vi.mocked(api.removeMember).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    const memberRow = (await screen.findByText("member@example.com")).closest("tr")!;

    fireEvent.click(within(memberRow).getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("u2"));
    expect(api.fetchTeam).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Team.test.tsx src/UserMenu.test.tsx`
Expected: FAIL — files don't exist yet.

- [ ] **Step 6: Create `web/src/pages/Team.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { fetchTeam, createTeamInvite, sendMemberPasswordReset, removeMember, type TeamMember } from "../api/client.js";

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetchTeam()
      .then(setMembers)
      .catch((err) => setError((err as Error).message));
  }

  useEffect(load, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createTeamInvite({ email: inviteEmail, role: inviteRole });
      setInfo(`Invite sent to ${inviteEmail}.`);
      setInviteEmail("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReset(userId: string, email: string) {
    setError(null);
    try {
      await sendMemberPasswordReset(userId);
      setInfo(`Password reset email sent to ${email}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemove(userId: string) {
    setError(null);
    try {
      await removeMember(userId);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="team-page">
      <h1>Team</h1>
      {error && <div className="error-banner">{error}</div>}
      {info && <div className="info-banner">{info}</div>}

      <form className="invite-form" onSubmit={handleInvite}>
        <label htmlFor="invite-email">Invite email</label>
        <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
        <select aria-label="Role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "member")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Send invite</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}</td>
              <td>{m.name}</td>
              <td>{m.role}</td>
              <td>{m.disabledAt ? "Removed" : "Active"}</td>
              <td>
                <button type="button" onClick={() => handleReset(m.id, m.email)} disabled={!!m.disabledAt}>
                  Send password reset
                </button>
                <button type="button" onClick={() => handleRemove(m.id)} disabled={!!m.disabledAt}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Team.test.tsx src/UserMenu.test.tsx && npx tsc --noEmit`
Expected: PASS (6 tests total).

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/Team.tsx web/src/pages/Team.test.tsx web/src/UserMenu.tsx web/src/UserMenu.test.tsx web/src/api/client.ts
git commit -m "feat: add Team page and UserMenu"
```

---

## Task 14: Frontend — App.tsx auth-gate and routing

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `supabase` (Task 9), `Login`/`ResetPassword`/`AcceptInvite`/`Team` (Tasks 10–13), `UserMenu` (Task 13).

**Note on what this gate actually secures:** per the spec and Global Constraints, this is a UX-level gate only in Plan 1 — it stops an anonymous browser session from reaching the app's UI, but the backend API routes it talks to (other than `/api/team/*`) don't check `req.user` yet. Someone bypassing the frontend entirely and calling the API directly gets exactly the same (currently fully open) access they'd get on `main` today — this plan doesn't newly expose anything; it just doesn't yet close a pre-existing gap either. Plan 2 closes it.

- [ ] **Step 1: Rewrite `web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { Home } from "./pages/Home.js";
import { Connections } from "./pages/Connections.js";
import { ConnectionDetail } from "./pages/ConnectionDetail.js";
import { Pipelines } from "./pages/Pipelines.js";
import { NewPipeline } from "./pages/NewPipeline.js";
import { PipelineDetail } from "./pages/PipelineDetail.js";
import { PipelineRunDetail } from "./pages/PipelineRunDetail.js";
import { Deployments } from "./pages/Deployments.js";
import { NewDeployment } from "./pages/NewDeployment.js";
import { DeploymentDetailPage } from "./pages/DeploymentDetail.js";
import { History } from "./pages/History.js";
import { Login } from "./pages/Login.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { AcceptInvite } from "./pages/AcceptInvite.js";
import { Team } from "./pages/Team.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { UserMenu } from "./UserMenu.js";
import { DisplayNameField } from "./DisplayNameField.js";
import { supabase } from "./supabaseClient.js";
import { HomeIcon, ConnectionsIcon, PipelinesIcon, DeploymentsIcon, HistoryIcon } from "./NavIcons.js";
import { FlowBackground } from "./components/FlowBackground.js";

const WIDE_PATHS = ["/deploy/new"];
const WIDE_PATH_PATTERN = /^\/deployments\/[^/]+$/;

// Routes reachable without a session. Login handles its own "already logged in" case by simply
// redirecting on successful sign-in; it doesn't need this list to also exclude itself.
function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/reset-password" || pathname === "/accept-invite";
}

export function App() {
  const location = useLocation();
  const isWide = WIDE_PATHS.includes(location.pathname) || WIDE_PATH_PATTERN.test(location.pathname);
  const [session, setSession] = useState<Session | null>(null);
  const [checkedAuth, setCheckedAuth] = useState(false);

  useEffect(() => {
    if (isPublicPath(location.pathname)) {
      setCheckedAuth(true);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        window.location.href = "/login";
        return;
      }
      setSession(data.session);
      setCheckedAuth(true);
    });
    // Keeps `session` current if the token refreshes or the user signs out in another tab —
    // Supabase's client handles the refresh itself; this just mirrors the result into state.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!newSession && !isPublicPath(location.pathname)) {
        window.location.href = "/login";
        return;
      }
      setSession(newSession);
    });
    return () => subscription.subscription.unsubscribe();
  }, [location.pathname]);

  if (isPublicPath(location.pathname)) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/accept-invite" element={<AcceptInvite />} />
      </Routes>
    );
  }

  if (!checkedAuth || !session) {
    return <div className="auth-page">Loading…</div>;
  }

  const displayName = (session.user.user_metadata?.name as string | undefined) ?? session.user.email ?? "";

  return (
    <div>
      <FlowBackground />
      <nav className="app-nav">
        <div className="app-nav-links">
          <NavLink to="/">
            <HomeIcon /> Home
          </NavLink>
          <NavLink to="/connections">
            <ConnectionsIcon /> Connections
          </NavLink>
          <NavLink to="/pipelines">
            <PipelinesIcon /> Pipelines
          </NavLink>
          <NavLink to="/deploy">
            <DeploymentsIcon /> Deployments
          </NavLink>
          <NavLink to="/history">
            <HistoryIcon /> History
          </NavLink>
          <NavLink to="/team">Team</NavLink>
        </div>
        <div className="app-nav-right">
          <UserMenu name={displayName} email={session.user.email ?? ""} />
          <DisplayNameField />
          <ThemeToggle />
          <Logo />
        </div>
      </nav>
      <main className={isWide ? "wide" : undefined}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/connections/:id" element={<ConnectionDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/pipelines/new" element={<NewPipeline />} />
          <Route path="/pipelines/:id" element={<PipelineDetail />} />
          <Route path="/pipelines/:pipelineId/runs/:runId" element={<PipelineRunDetail />} />
          <Route path="/deploy" element={<Deployments />} />
          <Route path="/deploy/new" element={<NewDeployment />} />
          <Route path="/deployments/:id" element={<DeploymentDetailPage />} />
          <Route path="/history" element={<History />} />
          <Route path="/team" element={<Team />} />
        </Routes>
        <Outlet />
      </main>
    </div>
  );
}
```

**Note:** `DisplayNameField` is deliberately left in place, unlike the abandoned PR #1 which removed it — that removal depended on the server populating `run_by` from an authenticated session, which is Plan 2's job here too (existing routes are untouched in this plan). Removing the free-text field now, before its server-side replacement exists, would silently regress deployment attribution to blank — exactly the gap the design spec's Non-Goals section warns against introducing. Leave `DisplayNameField`, `displayName.ts`, and every `getDisplayName()`/`runBy` call site in `DeploymentEditor.tsx`/`DeploymentDetail.tsx`/`PipelineRunDetail.tsx` completely untouched; that cleanup belongs to Plan 2, alongside the `run_by` population it depends on.

- [ ] **Step 2: Update `web/src/App.test.tsx`**

Read the file first to see its exact current structure and existing mocks. `App` now calls `supabase.auth.getSession()`/`onAuthStateChange` on mount for any non-public path — mock `../supabaseClient.js` (`vi.mock("./supabaseClient.js")`, matching wherever the test file already sits relative to that module) with `getSession` resolving a fixture session and `onAuthStateChange` returning `{ data: { subscription: { unsubscribe: vi.fn() } } }`, added to the file's existing mock-setup pattern.

- [ ] **Step 3: Run the full web test suite and typecheck**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: fully clean.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx
git commit -m "feat: add auth-gate, routing, and nav for Login/ResetPassword/AcceptInvite/Team"
```

---

## Task 15: Full verification

**Files:** none — pure verification.

- [ ] **Step 1: Full server suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: fully clean, including every test that needs the real `sfcowboy-dev` project (confirm `server/.env` is present and correct — see Prerequisites).

- [ ] **Step 2: Full web suite and typecheck**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: fully clean.

- [ ] **Step 3: Build both packages**

Run: `cd server && npm run build && cd ../web && npm run build`
Expected: both succeed.

- [ ] **Step 4: Manual smoke test**

Boot the built server against `sfcowboy-dev` (`server/.env` already points there) with `WEB_DIST_DIR=<absolute path to web/dist>` and confirm by hand: unauthenticated requests redirect to `/login`; the bootstrap admin (set `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` in `server/.env` for a throwaway admin) can log in; the admin can invite a teammate from `/team` and a real email arrives (check the invited address's inbox — this is the first point in this plan where an actual email needs to be verified as delivered, not just that the API call succeeded); the invite link lands on `/accept-invite`, shows the right email, and accepts a password; the new teammate is logged in immediately after; "Forgot password?" on the login page and "Send password reset" from the Team page both deliver a real email leading to `/reset-password`, which successfully sets a new password; removing a teammate updates their status to "Removed" and a subsequent `GET /api/auth/me`-equivalent (their session) is rejected on next use — verify this the same way the abandoned PR #1's own smoke test did: capture the removed member's access token before removal, call an authenticated endpoint with it after removal, confirm 401. Existing pages (Connections, Pipelines, Deployments, History) still load and function exactly as before, with no session required — this plan's disclosed, intentional state per its Non-Goals.

- [ ] **Step 5: Commit** (only if Steps 1-4 found something to fix; otherwise nothing to commit)

## After this plan ships

Plan 2 ("supabase-org-scoping") threads `organization_id` filtering into every route touching `connections`, `pipelines`, `pipeline_runs`, `deployments`, `deployment_items` (the 6 data-access modules and 3 route files identified in the design spec), applies `requireSupabaseUser` to those routes, removes the `DEFAULT '00000000-0000-0000-0000-000000000000'` from the 5 existing tables' `organization_id` columns once every write path supplies a real value, and finally removes `DisplayNameField`/`displayName.ts`/`getDisplayName()`/the `runBy` field once the server populates `run_by` from the authenticated session instead. Do not invite a second organization into the system, and do not start Plan 2's own writing-plans pass, until this plan is merged and verified. Closing PR #1 (the abandoned custom-auth branch) without merging it is part of this plan's own Migration Plan (see the spec) and needs the human's explicit go-ahead before it happens, separate from approving this plan document.
