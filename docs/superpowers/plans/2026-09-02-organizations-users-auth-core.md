# Organizations, Users, and Auth — Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up organizations, users, sessions, invites, and team management as a fully working, independently testable capability — you can bootstrap the first org/admin, log in, invite a teammate, have them accept and log in, and have an admin manage the team.

**Architecture:** Four new Postgres tables (`organizations`, `users`, `sessions`, `invites`) plus a new `server/src/users/` domain module (mirroring the existing `connections/`, `pipelines/`, `engine/` module shape). A single session-resolving Express middleware attaches `req.user` on protected routes. Login/session/invite/team logic lives entirely in the new module — **no existing route, domain module, or table gains org-scoping in this plan.**

**Tech Stack:** `bcrypt` for password hashing, `cookie-parser` for reading/writing the session cookie, the project's existing raw `pg` + hand-written SQL style (no ORM), the existing `openTestDb()` schema-per-run test pattern.

**Spec:** `docs/superpowers/specs/2026-09-02-organizations-users-auth-design.md`

## Scope boundary — read this before touching any task

This plan deliberately does **not** make the app's existing data private. After every task here is done, `/api/connections`, `/api/deployments`, `/api/pipelines`, etc. are still completely unauthenticated and unscoped — exactly as they are today. That is intentional: applying `requireSession` to a route without also scoping its queries to an organization would mean "you must log in, but then you see every organization's data anyway" — a confusing half-state with no real value. Enforcing both together, on every existing route at once, is a second plan ("Phase 1b — org-scoping"), written and executed after this one ships and is verified. Do not add `requireSession` to `app.ts`'s existing four routers as part of this plan — only to the new routes this plan adds.

## Global Constraints

- No behavior change to any existing table, route, or domain module — this plan only adds new tables/files, plus two small, disclosed schema additions beyond the spec's literal DDL (see Task 1).
- `organization_id` columns added to the 5 existing tables in this plan stay **nullable** — tightening them to `NOT NULL` is Phase 2's job, once every write path actually populates them.
- Password hashing: bcrypt, cost factor 12. No other hashing library.
- Session cookie name: `sfcowboy_session`. Session lifetime: exactly 30 days, fixed (no sliding/rolling expiry). Minimum password length: 8 characters, no other complexity rules.
- Every new domain function that touches the database is `async` and takes `db: Pool` as its first parameter, matching every existing module in this codebase.
- Every new test file uses `openTestDb()` (from `server/src/db/testDb.js`) for schema-per-run isolation — the same pattern every existing test file already uses. A real Postgres server must be reachable via `TEST_DATABASE_URL` (defaults to `postgres://sfcowboy@localhost:5433/sfcowboy` per `server/src/db/testDb.ts`).
- Run `cd server && npx vitest run <this task's test file(s)>` and `npx tsc --noEmit` after every task — scoped to this task's own files; do not run the full suite until the final task.

---

## Task 1: Schema — organizations, users, sessions, invites

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/client.ts`
- Modify: `server/src/db/client.test.ts`
- Modify: `server/src/db/testDb.test.ts`

**Interfaces:**
- Produces: 4 new tables, plus a new nullable `organization_id TEXT` column on `connections`, `pipelines`, `deployments`, `deployment_items`, `pipeline_runs` — consumed by Task 6 (bootstrap backfill) in this plan, and by every task in the follow-up org-scoping plan.

This codebase's established convention (see `client.ts`'s existing `runMigrations`) is: `schema.sql`'s `CREATE TABLE` blocks represent the **final** shape a fresh database gets in one shot, while `client.ts` separately carries idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements to bring an **existing** database up to that same shape. Both halves are needed — `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so a fresh-shape-only edit to `schema.sql` would leave existing deployments (like this project's own production database) without the new column forever.

- [ ] **Step 1: Add the 4 new tables to `server/src/db/schema.sql`**

Append to the end of the file:

```sql

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  -- Soft-delete for "remove a member": set, never row-deleted. A hard delete would violate
  -- invites.created_by's FK the moment a removed admin's past invites are looked at, and would
  -- discard a real audit trail for no benefit. NULL = active member.
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT
);
```

`disabled_at` on `users` is one disclosed addition beyond the spec's literal DDL — needed for Task 5's "remove a member" to soft-delete rather than hard-delete (see the comment above).

- [ ] **Step 2: Add `organization_id` to each of the 5 existing tables' `CREATE TABLE` blocks in `server/src/db/schema.sql`**

In each of the 5 existing `CREATE TABLE IF NOT EXISTS` blocks, add a new line `organization_id TEXT REFERENCES organizations(id),` immediately after the `id TEXT PRIMARY KEY,` line. Concretely:

- `connections`: after `id TEXT PRIMARY KEY,` (line 2 of that block), insert `organization_id TEXT REFERENCES organizations(id),`.
- `pipelines`: same — after its `id TEXT PRIMARY KEY,` line.
- `pipeline_runs`: same.
- `deployments`: same.
- `deployment_items`: same.

Every other line in these 5 blocks stays exactly as it already is — this is purely inserting one new column declaration into each, not rewriting the blocks.

- [ ] **Step 3: Add the idempotent upgrade path to `server/src/db/client.ts`**

In `runMigrations`, immediately after the existing `await db.query(schema);` line (and before the first `ALTER TABLE connections ADD COLUMN IF NOT EXISTS encrypted_client_id TEXT` line already there), insert:

```ts
  for (const table of ["connections", "pipelines", "deployments", "deployment_items", "pipeline_runs"]) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id)`);
  }
```

This must run after `await db.query(schema);` (which creates the `organizations` table on a fresh database) so the `REFERENCES organizations(id)` in each `ALTER TABLE` always has a table to reference, even on the very first boot against an empty database.

- [ ] **Step 4: Add a migration test to `server/src/db/client.test.ts`**

Add a new test alongside the existing "upgrades an existing database..." tests in the `describe("runMigrations", ...)` block:

```ts
  it("upgrades an existing database whose tables predate organization_id", async () => {
    db = await openTestDb();
    for (const table of ["connections", "pipelines", "deployments", "deployment_items", "pipeline_runs"]) {
      await db.pool.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS organization_id`);
    }
    await runMigrations(db.pool);
    const orgId = "test-org-for-column-check";
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'X', $2)`, [orgId, new Date().toISOString()]);
    await expect(
      db.pool.query(`INSERT INTO connections (id, type, nickname, created_at, organization_id) VALUES ('c1', 'org', 'N', $1, $2)`, [
        new Date().toISOString(),
        orgId,
      ])
    ).resolves.not.toThrow();
  }, 60_000);
```

- [ ] **Step 5: Extend `testDb.test.ts`'s table-existence assertion**

In `server/src/db/testDb.test.ts`, find the test that asserts `information_schema.tables` contains the expected table names (`expect(tables.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining([...]))`) and add the 4 new table names to that array: `"organizations"`, `"users"`, `"sessions"`, `"invites"`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/db/testDb.test.ts src/db/client.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/schema.sql server/src/db/client.ts server/src/db/client.test.ts server/src/db/testDb.test.ts
git commit -m "feat: add organizations/users/sessions/invites tables and org_id columns"
```

---

## Task 2: Users domain module — password hashing, user CRUD, login verification

**Files:**
- Modify: `server/package.json` (add `bcrypt`, `@types/bcrypt`)
- Create: `server/src/users/users.ts`
- Create: `server/src/users/users.test.ts`

**Interfaces:**
- Produces: `AuthenticatedUser` interface (`{ id, organizationId, email, name, role }`), `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, hash: string): Promise<boolean>`, `createUser(db, input): Promise<AuthenticatedUser>`, `getUserByEmail(db, email): Promise<UserRow | undefined>`, `getUserById(db, id): Promise<UserRow | undefined>`, `verifyLogin(db, email, password): Promise<AuthenticatedUser | undefined>`, `updateUserPassword(db, userId, newPasswordHash): Promise<void>`, `setUserDisabled(db, userId, disabled: boolean): Promise<void>` — consumed by Task 3 (sessions/middleware reads `getUserById`), Task 4 (invites calls `createUser`), Task 5 (team calls `getUserById`/`updateUserPassword`/`setUserDisabled`), Task 7 (routes call `verifyLogin`).

- [ ] **Step 1: Add `bcrypt` to `server/package.json`**

In `"dependencies"`, add: `"bcrypt": "^5.1.1"`. In `"devDependencies"`, add: `"@types/bcrypt": "^5.0.2"`.

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing tests**

Create `server/src/users/users.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import {
  hashPassword,
  verifyPassword,
  createUser,
  getUserByEmail,
  getUserById,
  verifyLogin,
  updateUserPassword,
  setUserDisabled,
} from "./users.js";

async function seedOrg(db: TestDb["pool"]): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [id, new Date().toISOString()]);
  return id;
}

describe("password hashing", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("correct-horse-battery-staple");
    expect(hash).not.toBe("correct-horse-battery-staple");
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("users", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a user and fetches it by email and by id", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "Admin@Example.com",
      passwordHash: await hashPassword("password123"),
      role: "admin",
      name: "Ada Admin",
    });
    expect(created).toMatchObject({ organizationId: orgId, email: "admin@example.com", name: "Ada Admin", role: "admin" });

    const byEmail = await getUserByEmail(db.pool, "ADMIN@example.com");
    expect(byEmail?.id).toBe(created.id);

    const byId = await getUserById(db.pool, created.id);
    expect(byId?.email).toBe("admin@example.com");
  });

  it("lowercases email on creation and lookup, so case never creates duplicate accounts", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    await createUser(db.pool, {
      organizationId: orgId,
      email: "Person@Example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Percy",
    });
    await expect(
      createUser(db.pool, {
        organizationId: orgId,
        email: "person@example.com",
        passwordHash: await hashPassword("password123"),
        role: "member",
        name: "Duplicate",
      })
    ).rejects.toThrow();
  });

  it("verifyLogin succeeds with correct credentials and fails with wrong password or unknown email", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "member@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Mel Member",
    });

    const ok = await verifyLogin(db.pool, "member@example.com", "s3cret!!");
    expect(ok).toMatchObject({ id: created.id, organizationId: orgId, role: "member", name: "Mel Member" });

    expect(await verifyLogin(db.pool, "member@example.com", "wrong")).toBeUndefined();
    expect(await verifyLogin(db.pool, "nobody@example.com", "s3cret!!")).toBeUndefined();
  });

  it("verifyLogin refuses a disabled user even with the correct password", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "gone@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Gone",
    });
    await setUserDisabled(db.pool, created.id, true);
    expect(await verifyLogin(db.pool, "gone@example.com", "s3cret!!")).toBeUndefined();
  });

  it("verifyLogin updates last_login_at on success", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "time@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Time",
    });
    expect((await getUserById(db.pool, created.id))?.last_login_at).toBeNull();
    await verifyLogin(db.pool, "time@example.com", "s3cret!!");
    expect((await getUserById(db.pool, created.id))?.last_login_at).not.toBeNull();
  });

  it("updateUserPassword replaces the hash so the old password no longer verifies", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "reset@example.com",
      passwordHash: await hashPassword("old-password"),
      role: "member",
      name: "Reset Me",
    });
    await updateUserPassword(db.pool, created.id, await hashPassword("new-password"));
    expect(await verifyLogin(db.pool, "reset@example.com", "old-password")).toBeUndefined();
    expect(await verifyLogin(db.pool, "reset@example.com", "new-password")).toMatchObject({ id: created.id });
  });

  it("setUserDisabled(false) re-enables a previously disabled user", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const created = await createUser(db.pool, {
      organizationId: orgId,
      email: "back@example.com",
      passwordHash: await hashPassword("s3cret!!"),
      role: "member",
      name: "Back",
    });
    await setUserDisabled(db.pool, created.id, true);
    await setUserDisabled(db.pool, created.id, false);
    expect(await verifyLogin(db.pool, "back@example.com", "s3cret!!")).toMatchObject({ id: created.id });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/users.test.ts`
Expected: FAIL — `./users.js` doesn't exist yet.

- [ ] **Step 4: Create `server/src/users/users.ts`**

```ts
import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import type { Pool } from "pg";

const BCRYPT_COST_FACTOR = 12;

export interface AuthenticatedUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export interface UserRow {
  id: string;
  organization_id: string;
  email: string;
  password_hash: string;
  role: "admin" | "member";
  name: string;
  created_at: string;
  last_login_at: string | null;
  disabled_at: string | null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  return { id: row.id, organizationId: row.organization_id, email: row.email, name: row.name, role: row.role };
}

/**
 * Emails are lowercased at every entry point (here and in every lookup below) so "Admin@x.com"
 * and "admin@x.com" can never become two different accounts — email is the login identifier and
 * globally unique across the whole platform (not just within one organization).
 */
export async function createUser(
  db: Pool,
  input: { organizationId: string; email: string; passwordHash: string; role: "admin" | "member"; name: string }
): Promise<AuthenticatedUser> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const email = input.email.toLowerCase();
  await db.query(
    `INSERT INTO users (id, organization_id, email, password_hash, role, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.organizationId, email, input.passwordHash, input.role, input.name, createdAt]
  );
  return { id, organizationId: input.organizationId, email, name: input.name, role: input.role };
}

export async function getUserByEmail(db: Pool, email: string): Promise<UserRow | undefined> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()]);
  return result.rows[0];
}

export async function getUserById(db: Pool, id: string): Promise<UserRow | undefined> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return result.rows[0];
}

/**
 * Verifies credentials and, on success, records the login and returns the user's public shape.
 * Returns undefined (never throws) for a wrong password, unknown email, or disabled user — the
 * caller (the login route) gives the same generic "invalid email or password" response in every
 * case, so a failed attempt can never reveal which part was wrong.
 */
export async function verifyLogin(db: Pool, email: string, password: string): Promise<AuthenticatedUser | undefined> {
  const row = await getUserByEmail(db, email);
  if (!row || row.disabled_at !== null) return undefined;
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return undefined;
  await db.query(`UPDATE users SET last_login_at = $1 WHERE id = $2`, [new Date().toISOString(), row.id]);
  return toAuthenticatedUser(row);
}

export async function updateUserPassword(db: Pool, userId: string, newPasswordHash: string): Promise<void> {
  await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newPasswordHash, userId]);
}

export async function setUserDisabled(db: Pool, userId: string, disabled: boolean): Promise<void> {
  await db.query(`UPDATE users SET disabled_at = $1 WHERE id = $2`, [disabled ? new Date().toISOString() : null, userId]);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/users.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/users/users.ts server/src/users/users.test.ts
git commit -m "feat: add users domain module (password hashing, CRUD, login verification)"
```

---

## Task 3: Sessions domain module + auth middleware

**Files:**
- Create: `server/src/users/sessions.ts`
- Create: `server/src/users/sessions.test.ts`

**Interfaces:**
- Consumes: `getUserById(db, id): Promise<UserRow | undefined>` (Task 2).
- Produces: `SESSION_COOKIE_NAME` (`"sfcowboy_session"`), `createSession(db, userId): Promise<{ id: string; expiresAt: string }>`, `deleteSession(db, sessionId): Promise<void>`, `deleteSessionsForUser(db, userId): Promise<void>`, `requireSession(db): RequestHandler` (Express middleware attaching `req.user: AuthenticatedUser`) — consumed by Task 7 (routes) and by the follow-up org-scoping plan.

- [ ] **Step 1: Write the failing tests**

Create `server/src/users/sessions.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser } from "./users.js";
import { SESSION_COOKIE_NAME, createSession, deleteSession, deleteSessionsForUser, requireSession } from "./sessions.js";

async function seedOrgAndUser(db: TestDb["pool"]): Promise<{ orgId: string; userId: string }> {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [orgId, new Date().toISOString()]);
  const user = await createUser(db, {
    organizationId: orgId,
    email: "user@example.com",
    passwordHash: await hashPassword("password123"),
    role: "member",
    name: "User",
  });
  return { orgId, userId: user.id };
}

describe("sessions", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a session row with a 30-day expiry", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const before = Date.now();
    const session = await createSession(db.pool, userId);
    const row = (await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows[0];
    expect(row.user_id).toBe(userId);
    const expiresAt = new Date(row.expires_at).getTime();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(before + thirtyDaysMs - 5000);
    expect(expiresAt).toBeLessThan(before + thirtyDaysMs + 5000);
  });

  it("deleteSession removes exactly that session", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const session = await createSession(db.pool, userId);
    await deleteSession(db.pool, session.id);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
  });

  it("deleteSessionsForUser removes every session for that user, not other users'", async () => {
    db = await openTestDb();
    const { userId } = await seedOrgAndUser(db.pool);
    const orgId2 = randomUUID();
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Other', $2)`, [orgId2, new Date().toISOString()]);
    const otherUser = await createUser(db.pool, {
      organizationId: orgId2,
      email: "other@example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Other",
    });

    await createSession(db.pool, userId);
    await createSession(db.pool, userId);
    const otherSession = await createSession(db.pool, otherUser.id);

    await deleteSessionsForUser(db.pool, userId);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE user_id = $1`, [userId])).rows).toHaveLength(0);
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [otherSession.id])).rows).toHaveLength(1);
  });

  describe("requireSession middleware", () => {
    function buildApp(db: TestDb["pool"]) {
      const app = express();
      app.use(requireSession(db));
      app.get("/protected", (req, res) => {
        res.json({ user: req.user });
      });
      return app;
    }

    it("rejects a request with no cookie", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
    });

    it("rejects a request with an unknown session id", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=not-a-real-session`]);
      expect(res.status).toBe(401);
    });

    it("attaches req.user and succeeds for a valid session", async () => {
      db = await openTestDb();
      const { userId, orgId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ id: userId, organizationId: orgId, role: "member", name: "User" });
    });

    it("rejects an expired session", async () => {
      db = await openTestDb();
      const { userId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      await db.pool.query(`UPDATE sessions SET expires_at = $1 WHERE id = $2`, ["2000-01-01T00:00:00.000Z", session.id]);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(401);
    });

    it("rejects a session whose user was disabled after the session was created", async () => {
      db = await openTestDb();
      const { userId } = await seedOrgAndUser(db.pool);
      const app = buildApp(db.pool);
      const session = await createSession(db.pool, userId);
      await db.pool.query(`UPDATE users SET disabled_at = $1 WHERE id = $2`, [new Date().toISOString(), userId]);
      const res = await request(app).get("/protected").set("Cookie", [`${SESSION_COOKIE_NAME}=${session.id}`]);
      expect(res.status).toBe(401);
    });
  });
});
```

Note: this test file needs `cookie-parser`'s cookie-reading behavior to work inside `requireSession` itself — the middleware parses `req.headers.cookie` directly (see Step 2 below) rather than depending on a separately-mounted `cookie-parser` instance, so this test builds a minimal Express app with only `requireSession` mounted and still works. `supertest` is already a devDependency (used throughout the existing route test files).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/sessions.test.ts`
Expected: FAIL — `./sessions.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/sessions.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getUserById } from "./users.js";
import type { AuthenticatedUser } from "./users.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export const SESSION_COOKIE_NAME = "sfcowboy_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(db: Pool, userId: string): Promise<{ id: string; expiresAt: string }> {
  const id = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS).toISOString();
  await db.query(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [
    id,
    userId,
    createdAt.toISOString(),
    expiresAt,
  ]);
  return { id, expiresAt };
}

export async function deleteSession(db: Pool, sessionId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
}

/** Used when an admin removes a member or resets their password — every existing session for
 * that user stops working on its very next request, which is the whole reason this project chose
 * server-side sessions over JWTs (see the design spec). */
export async function deleteSessionsForUser(db: Pool, userId: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}

/**
 * Reads the session cookie directly off the raw `Cookie` request header rather than depending on
 * `cookie-parser` having already run — this keeps the middleware fully self-contained and testable
 * in isolation (see sessions.test.ts, which mounts only this middleware with no other setup).
 * `cookie-parser` is still used elsewhere (app.ts) for setting/clearing the cookie with the right
 * flags, which needs its `res.cookie()`/`res.clearCookie()` helpers.
 */
function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

/**
 * Express middleware: resolves the session cookie into `req.user`, or responds 401 if there is no
 * valid, unexpired session for a non-disabled user. This is the single choke point every protected
 * route in this app relies on — no route independently re-checks auth (see the design spec).
 */
export function requireSession(db: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sessionId = readSessionCookie(req);
    if (!sessionId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const sessionRow = (await db.query(`SELECT * FROM sessions WHERE id = $1`, [sessionId])).rows[0];
    if (!sessionRow || new Date(sessionRow.expires_at).getTime() < Date.now()) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const userRow = await getUserById(db, sessionRow.user_id);
    if (!userRow || userRow.disabled_at !== null) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.user = { id: userRow.id, organizationId: userRow.organization_id, email: userRow.email, name: userRow.name, role: userRow.role };
    next();
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/sessions.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/sessions.ts server/src/users/sessions.test.ts
git commit -m "feat: add sessions domain module and requireSession auth middleware"
```

---

## Task 4: Invites domain module

**Files:**
- Create: `server/src/users/invites.ts`
- Create: `server/src/users/invites.test.ts`

**Interfaces:**
- Consumes: `createUser`, `hashPassword` (Task 2); `createSession` (Task 3); `withTransaction` (`server/src/db/client.js`, already exists).
- Produces: `createInvite(db, input): Promise<{ id: string; token: string; expiresAt: string }>`, `getInviteByToken(db, token): Promise<InviteRow | undefined>`, `acceptInvite(db, token, password): Promise<{ user: AuthenticatedUser; sessionId: string }>` — consumed by Task 7 (routes).

- [ ] **Step 1: Write the failing tests**

Create `server/src/users/invites.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser, verifyLogin } from "./users.js";
import { createInvite, getInviteByToken, acceptInvite } from "./invites.js";

async function seedOrgAndAdmin(db: TestDb["pool"]): Promise<{ orgId: string; adminId: string }> {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [orgId, new Date().toISOString()]);
  const admin = await createUser(db, {
    organizationId: orgId,
    email: "admin@example.com",
    passwordHash: await hashPassword("password123"),
    role: "admin",
    name: "Admin",
  });
  return { orgId, adminId: admin.id };
}

describe("invites", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates an invite with a future expiry and a unique token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "new@example.com", role: "member", createdByUserId: adminId });
    expect(invite.token).toBeTruthy();
    expect(new Date(invite.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await getInviteByToken(db.pool, invite.token);
    expect(row).toMatchObject({ organization_id: orgId, email: "new@example.com", role: "member", created_by: adminId, accepted_at: null });
  });

  it("getInviteByToken returns undefined for an unknown token", async () => {
    db = await openTestDb();
    expect(await getInviteByToken(db.pool, "not-a-real-token")).toBeUndefined();
  });

  it("acceptInvite creates a user scoped to the invite's organization and role, and logs them in", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "newmember@example.com", role: "member", createdByUserId: adminId });

    const { user, sessionId } = await acceptInvite(db.pool, invite.token, "a-good-password");
    expect(user).toMatchObject({ organizationId: orgId, email: "newmember@example.com", role: "member" });
    expect(sessionId).toBeTruthy();

    const sessionRow = (await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [sessionId])).rows[0];
    expect(sessionRow.user_id).toBe(user.id);

    expect(await verifyLogin(db.pool, "newmember@example.com", "a-good-password")).toMatchObject({ id: user.id });

    const acceptedInvite = await getInviteByToken(db.pool, invite.token);
    expect(acceptedInvite?.accepted_at).not.toBeNull();
  });

  it("acceptInvite rejects an already-accepted token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "once@example.com", role: "member", createdByUserId: adminId });
    await acceptInvite(db.pool, invite.token, "password-one");
    await expect(acceptInvite(db.pool, invite.token, "password-two")).rejects.toThrow(/already been accepted/i);
  });

  it("acceptInvite rejects an expired token", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "expired@example.com", role: "member", createdByUserId: adminId });
    await db.pool.query(`UPDATE invites SET expires_at = $1 WHERE token = $2`, ["2000-01-01T00:00:00.000Z", invite.token]);
    await expect(acceptInvite(db.pool, invite.token, "password")).rejects.toThrow(/expired/i);
  });

  it("acceptInvite rejects an unknown token", async () => {
    db = await openTestDb();
    await expect(acceptInvite(db.pool, "not-a-real-token", "password")).rejects.toThrow(/no invite/i);
  });

  it("acceptInvite rejects a password shorter than 8 characters", async () => {
    db = await openTestDb();
    const { orgId, adminId } = await seedOrgAndAdmin(db.pool);
    const invite = await createInvite(db.pool, { organizationId: orgId, email: "short@example.com", role: "member", createdByUserId: adminId });
    await expect(acceptInvite(db.pool, invite.token, "short")).rejects.toThrow(/at least 8 characters/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/invites.test.ts`
Expected: FAIL — `./invites.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/invites.ts`**

```ts
import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/client.js";
import { hashPassword, type AuthenticatedUser } from "./users.js";
import { createSession } from "./sessions.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: "admin" | "member";
  token: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createInvite(
  db: Pool,
  input: { organizationId: string; email: string; role: "admin" | "member"; createdByUserId: string }
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = randomUUID();
  const token = generateToken();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + INVITE_TTL_MS).toISOString();
  await db.query(
    `INSERT INTO invites (id, organization_id, email, role, token, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, input.organizationId, input.email.toLowerCase(), input.role, token, input.createdByUserId, createdAt.toISOString(), expiresAt]
  );
  return { id, token, expiresAt };
}

export async function getInviteByToken(db: Pool, token: string): Promise<InviteRow | undefined> {
  const result = await db.query<InviteRow>(`SELECT * FROM invites WHERE token = $1`, [token]);
  return result.rows[0];
}

/**
 * Validates the token (exists, unexpired, unaccepted), creates the user scoped to the invite's own
 * organization/role/email (never anything the invitee supplies — see the design spec's security
 * rationale), marks the invite accepted, and logs the new user straight in. User creation and
 * marking the invite accepted are transaction-wrapped so a failure partway through can never leave
 * an invite marked accepted with no corresponding user, or vice versa.
 */
export async function acceptInvite(db: Pool, token: string, password: string): Promise<{ user: AuthenticatedUser; sessionId: string }> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const invite = await getInviteByToken(db, token);
  if (!invite) throw new Error("No invite found for this link");
  if (invite.accepted_at !== null) throw new Error("This invite has already been accepted");
  if (new Date(invite.expires_at).getTime() < Date.now()) throw new Error("This invite has expired");

  const passwordHash = await hashPassword(password);
  const userId = randomUUID();
  const createdAt = new Date().toISOString();
  const email = invite.email.toLowerCase();
  const user = await withTransaction(db, async (client) => {
    // Inlined rather than calling createUser(db, ...) (which is typed to accept a Pool, not this
    // transaction's PoolClient) — same query createUser itself runs. Matches the precedent set by
    // deploy.ts's attachComponentsAndQueue for calling into a shared transaction.
    await client.query(
      `INSERT INTO users (id, organization_id, email, password_hash, role, name, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, invite.organization_id, email, passwordHash, invite.role, email, createdAt]
    );
    await client.query(`UPDATE invites SET accepted_at = $1 WHERE id = $2`, [new Date().toISOString(), invite.id]);
    return { id: userId, organizationId: invite.organization_id, email, name: email, role: invite.role };
  });

  const session = await createSession(db, user.id);
  return { user, sessionId: session.id };
}
```

`name: email` is a placeholder display name (the invitee has no name yet at this point) — Task 5 or a later profile-editing feature can let a user set their real display name; this plan does not add that, since the spec doesn't call for it and it isn't needed for login/team-management to work.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/invites.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/invites.ts server/src/users/invites.test.ts
git commit -m "feat: add invites domain module"
```

---

## Task 5: Team management domain module

**Files:**
- Create: `server/src/users/team.ts`
- Create: `server/src/users/team.test.ts`

**Interfaces:**
- Consumes: `getUserById`, `updateUserPassword`, `setUserDisabled`, `hashPassword` (Task 2); `deleteSessionsForUser` (Task 3).
- Produces: `TeamMember` interface, `listTeamMembers(db, organizationId): Promise<TeamMember[]>`, `resetMemberPassword(db, organizationId, userId): Promise<{ temporaryPassword: string }>`, `removeMember(db, organizationId, userId): Promise<void>` — consumed by Task 7 (routes).

- [ ] **Step 1: Write the failing tests**

Create `server/src/users/team.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser, verifyLogin, getUserById } from "./users.js";
import { createSession } from "./sessions.js";
import { listTeamMembers, resetMemberPassword, removeMember } from "./team.js";

async function seedOrg(db: TestDb["pool"], name = "Acme"): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [id, name, new Date().toISOString()]);
  return id;
}

describe("team management", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("lists only the members of the given organization, not another org's", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    await createUser(db.pool, { organizationId: orgA, email: "a1@example.com", passwordHash: "x", role: "admin", name: "A1" });
    await createUser(db.pool, { organizationId: orgA, email: "a2@example.com", passwordHash: "x", role: "member", name: "A2" });
    await createUser(db.pool, { organizationId: orgB, email: "b1@example.com", passwordHash: "x", role: "admin", name: "B1" });

    const members = await listTeamMembers(db.pool, orgA);
    expect(members).toHaveLength(2);
    expect(members.map((m) => m.email).sort()).toEqual(["a1@example.com", "a2@example.com"]);
  });

  it("resetMemberPassword sets a new working password and invalidates existing sessions", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const user = await createUser(db.pool, {
      organizationId: orgId,
      email: "reset@example.com",
      passwordHash: await hashPassword("old-password"),
      role: "member",
      name: "Reset Me",
    });
    const session = await createSession(db.pool, user.id);

    const { temporaryPassword } = await resetMemberPassword(db.pool, orgId, user.id);
    expect(temporaryPassword.length).toBeGreaterThanOrEqual(8);

    expect(await verifyLogin(db.pool, "reset@example.com", "old-password")).toBeUndefined();
    expect(await verifyLogin(db.pool, "reset@example.com", temporaryPassword)).toMatchObject({ id: user.id });

    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
  });

  it("resetMemberPassword refuses to reset a user outside the given organization", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    const outsider = await createUser(db.pool, { organizationId: orgB, email: "outsider@example.com", passwordHash: "x", role: "member", name: "Outsider" });
    await expect(resetMemberPassword(db.pool, orgA, outsider.id)).rejects.toThrow(/no member/i);
  });

  it("removeMember disables the user and invalidates their sessions, without deleting the row", async () => {
    db = await openTestDb();
    const orgId = await seedOrg(db.pool);
    const user = await createUser(db.pool, {
      organizationId: orgId,
      email: "bye@example.com",
      passwordHash: await hashPassword("password123"),
      role: "member",
      name: "Bye",
    });
    const session = await createSession(db.pool, user.id);

    await removeMember(db.pool, orgId, user.id);

    expect(await verifyLogin(db.pool, "bye@example.com", "password123")).toBeUndefined();
    expect((await db.pool.query(`SELECT * FROM sessions WHERE id = $1`, [session.id])).rows).toHaveLength(0);
    expect(await getUserById(db.pool, user.id)).toBeDefined();
  });

  it("removeMember refuses to remove a user outside the given organization", async () => {
    db = await openTestDb();
    const orgA = await seedOrg(db.pool, "Org A");
    const orgB = await seedOrg(db.pool, "Org B");
    const outsider = await createUser(db.pool, { organizationId: orgB, email: "outsider2@example.com", passwordHash: "x", role: "member", name: "Outsider" });
    await expect(removeMember(db.pool, orgA, outsider.id)).rejects.toThrow(/no member/i);
    expect(await verifyLogin(db.pool, "outsider2@example.com", "x")).toBeUndefined(); // unaffected either way (wrong password), but the row must still exist:
    expect(await getUserById(db.pool, outsider.id)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/team.test.ts`
Expected: FAIL — `./team.js` doesn't exist yet.

- [ ] **Step 3: Create `server/src/users/team.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, updateUserPassword, setUserDisabled, type UserRow } from "./users.js";
import { deleteSessionsForUser } from "./sessions.js";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

function toTeamMember(row: UserRow): TeamMember {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabledAt: row.disabled_at,
  };
}

export async function listTeamMembers(db: Pool, organizationId: string): Promise<TeamMember[]> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE organization_id = $1 ORDER BY created_at ASC`, [organizationId]);
  return result.rows.map(toTeamMember);
}

async function getMemberInOrg(db: Pool, organizationId: string, userId: string): Promise<UserRow> {
  const result = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1 AND organization_id = $2`, [userId, organizationId]);
  const row = result.rows[0];
  if (!row) throw new Error(`No member with id ${userId} in this organization`);
  return row;
}

function generateTemporaryPassword(): string {
  // 12 URL-safe characters — comfortably above the 8-character minimum, and never contains a
  // character an admin could misread when relaying it to the teammate by hand.
  return randomBytes(9).toString("base64url");
}

/**
 * Admin action: sets a new, randomly-generated password (the admin never chooses it — see the
 * design spec) and invalidates every existing session for that user, so a compromised or
 * forgotten password stops working on the member's very next request, not just their next login.
 */
export async function resetMemberPassword(db: Pool, organizationId: string, userId: string): Promise<{ temporaryPassword: string }> {
  await getMemberInOrg(db, organizationId, userId);
  const temporaryPassword = generateTemporaryPassword();
  await updateUserPassword(db, userId, await hashPassword(temporaryPassword));
  await deleteSessionsForUser(db, userId);
  return { temporaryPassword };
}

/** Admin action: soft-deletes the member (see users.ts's disabled_at) and invalidates their sessions. */
export async function removeMember(db: Pool, organizationId: string, userId: string): Promise<void> {
  await getMemberInOrg(db, organizationId, userId);
  await setUserDisabled(db, userId, true);
  await deleteSessionsForUser(db, userId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/team.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/users/team.ts server/src/users/team.test.ts
git commit -m "feat: add team management domain module"
```

---

## Task 6: Bootstrap — first organization and admin from the existing production data

**Files:**
- Modify: `server/src/config.ts`
- Create: `server/src/users/bootstrap.ts`
- Create: `server/src/users/bootstrap.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `createUser` (Task 2).
- Produces: `Config.bootstrapAdminEmail?: string`, `Config.bootstrapAdminPassword?: string`, `Config.bootstrapOrgName: string`; `bootstrapIfNeeded(db: Pool, config: Config): Promise<void>` — consumed by `index.ts` (Task 8).

- [ ] **Step 1: Add bootstrap config fields to `server/src/config.ts`**

Replace the file's content with:

```ts
export interface Config {
  port: number;
  databaseUrl: string;
  encryptionKey: string;
  oauthCallbackUrl: string;
  sfClientId: string;
  // Used only once, the very first time the app boots against a database with no organizations
  // yet — see users/bootstrap.ts. Deliberately NOT in the required-env-vars list below: an
  // already-bootstrapped deployment must keep working forever without these ever being set again.
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
  bootstrapOrgName: string;
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
    bootstrapAdminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL,
    bootstrapAdminPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    bootstrapOrgName: process.env.BOOTSTRAP_ORG_NAME ?? "My Organization",
  };
}
```

- [ ] **Step 2: Write the failing tests**

Create `server/src/users/bootstrap.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { verifyLogin } from "./users.js";
import { bootstrapIfNeeded } from "./bootstrap.js";
import type { Config } from "../config.js";

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    databaseUrl: "unused",
    encryptionKey: "unused",
    oauthCallbackUrl: "unused",
    sfClientId: "unused",
    bootstrapAdminEmail: "admin@example.com",
    bootstrapAdminPassword: "bootstrap-password",
    bootstrapOrgName: "Bootstrapped Org",
    ...overrides,
  };
}

describe("bootstrapIfNeeded", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates one organization and one admin user when organizations is empty", async () => {
    db = await openTestDb();
    await bootstrapIfNeeded(db.pool, fakeConfig());

    const orgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;
    expect(orgs).toHaveLength(1);
    expect(orgs[0].name).toBe("Bootstrapped Org");

    const user = await verifyLogin(db.pool, "admin@example.com", "bootstrap-password");
    expect(user).toMatchObject({ organizationId: orgs[0].id, role: "admin" });
  });

  it("backfills organization_id on every existing row across all 5 tables", async () => {
    db = await openTestDb();
    const connId = randomUUID();
    const pipelineId = randomUUID();
    const deploymentId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    await db.pool.query(`INSERT INTO connections (id, type, nickname, created_at) VALUES ($1, 'org', 'Existing', $2)`, [connId, new Date().toISOString()]);
    await db.pool.query(`INSERT INTO pipelines (id, name, connection_ids) VALUES ($1, 'Existing Pipeline', '[]')`, [pipelineId]);
    await db.pool.query(
      `INSERT INTO deployments (id, target_connection_id, component_list, test_level, status, started_at) VALUES ($1, $2, '[]', 'NoTestRun', 'pending', $3)`,
      [deploymentId, connId, new Date().toISOString()]
    );
    await db.pool.query(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ($1, $2, 'ApexClass', 'A', 'add', 'pending')`,
      [itemId, deploymentId]
    );
    await db.pool.query(`INSERT INTO pipeline_runs (id, pipeline_id, component_list, created_at) VALUES ($1, $2, '[]', $3)`, [
      runId,
      pipelineId,
      new Date().toISOString(),
    ]);

    await bootstrapIfNeeded(db.pool, fakeConfig());
    const orgId = (await db.pool.query(`SELECT id FROM organizations`)).rows[0].id;

    for (const [table, id] of [
      ["connections", connId],
      ["pipelines", pipelineId],
      ["deployments", deploymentId],
      ["deployment_items", itemId],
      ["pipeline_runs", runId],
    ] as const) {
      const row = (await db.pool.query(`SELECT organization_id FROM ${table} WHERE id = $1`, [id])).rows[0];
      expect(row.organization_id).toBe(orgId);
    }
  });

  it("is a no-op on a second call once an organization already exists", async () => {
    db = await openTestDb();
    await bootstrapIfNeeded(db.pool, fakeConfig());
    const firstOrgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;

    await bootstrapIfNeeded(db.pool, fakeConfig({ bootstrapOrgName: "Should Not Be Created" }));
    const secondOrgs = (await db.pool.query(`SELECT * FROM organizations`)).rows;

    expect(secondOrgs).toEqual(firstOrgs);
  });

  it("throws a clear error if organizations is empty but the bootstrap credentials aren't set", async () => {
    db = await openTestDb();
    await expect(bootstrapIfNeeded(db.pool, fakeConfig({ bootstrapAdminEmail: undefined, bootstrapAdminPassword: undefined }))).rejects.toThrow(
      /BOOTSTRAP_ADMIN_EMAIL/
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/bootstrap.test.ts`
Expected: FAIL — `./bootstrap.js` doesn't exist yet.

- [ ] **Step 4: Create `server/src/users/bootstrap.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { hashPassword, createUser } from "./users.js";

const BACKFILL_TABLES = ["connections", "pipelines", "deployments", "deployment_items", "pipeline_runs"] as const;

/**
 * Runs once per environment, the first time the app boots against a database with no
 * organizations yet: creates one Organization for the existing (pre-multi-tenancy) data, creates
 * one Admin user from the two bootstrap env vars, and backfills organization_id on every existing
 * row so the app's data isn't orphaned once org-scoping is enforced (see the follow-up plan).
 * Idempotent — a no-op on every later boot once `organizations` is non-empty, called from
 * index.ts right after runMigrations the same way every other one-time schema concern in this
 * codebase is handled.
 */
export async function bootstrapIfNeeded(db: Pool, config: Config): Promise<void> {
  const existing = await db.query(`SELECT id FROM organizations LIMIT 1`);
  if (existing.rows.length > 0) return;

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    throw new Error(
      "No organization exists yet and BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD are not set. " +
        "Set both env vars and restart to create the first organization and admin account."
    );
  }

  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [orgId, config.bootstrapOrgName, new Date().toISOString()]);

  await createUser(db, {
    organizationId: orgId,
    email: config.bootstrapAdminEmail,
    passwordHash: await hashPassword(config.bootstrapAdminPassword),
    role: "admin",
    name: "Admin",
  });

  for (const table of BACKFILL_TABLES) {
    await db.query(`UPDATE ${table} SET organization_id = $1 WHERE organization_id IS NULL`, [orgId]);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/bootstrap.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/config.ts server/src/users/bootstrap.ts server/src/users/bootstrap.test.ts
git commit -m "feat: add bootstrap for the first organization and admin user"
```

---

## Task 6b: CLI script — create an additional organization

> This covers a spec requirement distinct from Task 6's bootstrap: "A second, independent
> organization (a genuinely new customer, beyond the bootstrapped one) is created by a platform
> operator running a small script." Task 6's `bootstrapIfNeeded` runs automatically at boot and
> only ever creates the *first* organization; this script is manually invoked, repeatable, and
> creates one new organization + its first admin each time it's run — matching the spec's
> "admin-provisioned only" / "no self-serve signup" decisions.

**Files:**
- Create: `server/scripts/create-organization.ts`
- Create: `server/scripts/create-organization.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `createUser` (Task 2).
- Produces: `createOrganizationWithAdmin(db, input): Promise<{ organizationId: string; userId: string }>` plus a CLI entrypoint.

- [ ] **Step 1: Write the failing test**

Create `server/scripts/create-organization.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { openTestDb, type TestDb } from "../src/db/testDb.js";
import { verifyLogin } from "../src/users/users.js";
import { createOrganizationWithAdmin } from "./create-organization.js";

describe("createOrganizationWithAdmin", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  it("creates a new organization and its first admin, independent of any existing organization", async () => {
    db = await openTestDb();
    await db.pool.query(`INSERT INTO organizations (id, name, created_at) VALUES ('existing-org', 'Existing', $1)`, [new Date().toISOString()]);

    const result = await createOrganizationWithAdmin(db.pool, {
      organizationName: "New Customer Inc",
      adminEmail: "owner@newcustomer.com",
      adminPassword: "a-real-password",
    });

    const org = (await db.pool.query(`SELECT * FROM organizations WHERE id = $1`, [result.organizationId])).rows[0];
    expect(org.name).toBe("New Customer Inc");
    expect(org.id).not.toBe("existing-org");

    const user = await verifyLogin(db.pool, "owner@newcustomer.com", "a-real-password");
    expect(user).toMatchObject({ organizationId: result.organizationId, role: "admin" });

    const totalOrgs = (await db.pool.query(`SELECT COUNT(*)::int AS count FROM organizations`)).rows[0].count;
    expect(totalOrgs).toBe(2);
  });

  it("can be run more than once to create multiple additional organizations", async () => {
    db = await openTestDb();
    const first = await createOrganizationWithAdmin(db.pool, { organizationName: "First", adminEmail: "a@example.com", adminPassword: "password123" });
    const second = await createOrganizationWithAdmin(db.pool, { organizationName: "Second", adminEmail: "b@example.com", adminPassword: "password123" });
    expect(first.organizationId).not.toBe(second.organizationId);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run scripts/create-organization.test.ts`
Expected: FAIL — `./create-organization.js` doesn't exist yet.

- [ ] **Step 3: Create `server/scripts/create-organization.ts`**

```ts
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Pool } from "pg";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { hashPassword, createUser } from "../src/users/users.js";

/**
 * Creates one brand-new organization plus its first admin user — the manual, repeatable tool a
 * platform operator runs to onboard a new customer beyond the bootstrapped organization (see
 * users/bootstrap.ts, which only ever creates the FIRST one, automatically, at boot). No self-serve
 * signup exists in this product yet — this script is the entire "provision a new org" mechanism.
 */
export async function createOrganizationWithAdmin(
  db: Pool,
  input: { organizationName: string; adminEmail: string; adminPassword: string }
): Promise<{ organizationId: string; userId: string }> {
  const organizationId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)`, [organizationId, input.organizationName, new Date().toISOString()]);

  const user = await createUser(db, {
    organizationId,
    email: input.adminEmail,
    passwordHash: await hashPassword(input.adminPassword),
    role: "admin",
    name: "Admin",
  });

  return { organizationId, userId: user.id };
}

async function main() {
  const [organizationName, adminEmail, adminPassword] = process.argv.slice(2);
  if (!organizationName || !adminEmail || !adminPassword) {
    console.error("Usage: tsx scripts/create-organization.ts <organization-name> <admin-email> <admin-password>");
    process.exit(1);
  }

  const config = loadConfig();
  const pool = openDb(config.databaseUrl);

  const result = await createOrganizationWithAdmin(pool, { organizationName, adminEmail, adminPassword });
  console.log(`Created organization "${organizationName}" (${result.organizationId}) with admin ${adminEmail} (${result.userId})`);

  await pool.end();
}

// Cross-platform-safe direct-execution guard (see migrate-sqlite-to-postgres.ts's amendment note
// for why a naive `import.meta.url === file://${process.argv[1]}` comparison breaks on Windows).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Failed to create organization:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run scripts/create-organization.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Add an npm script for the CLI**

In `server/package.json`'s `"scripts"` block, add:

```json
"create-organization": "tsx scripts/create-organization.ts"
```

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/scripts/create-organization.ts server/scripts/create-organization.test.ts
git commit -m "feat: add CLI script to provision an additional organization"
```

---

## Task 7: Express router — login, logout, me, invites, team

**Files:**
- Modify: `server/package.json` (add `cookie-parser`, `@types/cookie-parser`)
- Create: `server/src/users/routes.ts`
- Create: `server/src/users/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–5 (`verifyLogin`, `createSession`, `deleteSession`, `requireSession`, `SESSION_COOKIE_NAME`, `createInvite`, `getInviteByToken`, `acceptInvite`, `listTeamMembers`, `resetMemberPassword`, `removeMember`).
- Produces: `createUsersRouter(db: Pool): Router` — mounted in `app.ts` (Task 8).

- [ ] **Step 1: Add `cookie-parser` to `server/package.json`**

In `"dependencies"`, add: `"cookie-parser": "^1.4.6"`. In `"devDependencies"`, add: `"@types/cookie-parser": "^1.4.7"`.

Run: `cd server && npm install`

- [ ] **Step 2: Write the failing tests**

Create `server/src/users/routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { openTestDb, type TestDb } from "../db/testDb.js";
import { hashPassword, createUser } from "./users.js";
import { createSession, SESSION_COOKIE_NAME } from "./sessions.js";
import { createUsersRouter } from "./routes.js";

async function seedOrgAndAdmin(db: TestDb["pool"]): Promise<{ orgId: string; adminId: string }> {
  const orgId = randomUUID();
  await db.query(`INSERT INTO organizations (id, name, created_at) VALUES ($1, 'Acme', $2)`, [orgId, new Date().toISOString()]);
  const admin = await createUser(db, {
    organizationId: orgId,
    email: "admin@example.com",
    passwordHash: await hashPassword("password123"),
    role: "admin",
    name: "Admin",
  });
  return { orgId, adminId: admin.id };
}

function buildApp(db: TestDb["pool"]) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(createUsersRouter(db));
  return app;
}

function sessionCookie(res: request.Response): string {
  const setCookie = res.headers["set-cookie"] as unknown as string[];
  const match = setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) throw new Error("no session cookie set");
  return match.split(";")[0];
}

describe("users routes", () => {
  let db: TestDb;

  afterEach(async () => {
    if (db) await db.stop();
  });

  describe("POST /api/auth/login", () => {
    it("logs in with correct credentials and sets a session cookie", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);

      const res = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      expect(res.status).toBe(200);
      expect(sessionCookie(res)).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    });

    it("returns a generic error for a wrong password without revealing the email is valid", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "wrong" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid email or password/i);
    });

    it("returns the same generic error for an unknown email", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: "whatever1" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid email or password/i);
    });
  });

  describe("GET /api/auth/me and POST /api/auth/logout", () => {
    it("returns the current user when logged in, 401 when not", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);

      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const cookie = sessionCookie(loginRes);

      const meRes = await request(app).get("/api/auth/me").set("Cookie", [cookie]);
      expect(meRes.status).toBe(200);
      expect(meRes.body).toMatchObject({ email: "admin@example.com", role: "admin", organizationId: orgId });

      const anonRes = await request(app).get("/api/auth/me");
      expect(anonRes.status).toBe(401);
    });

    it("logout invalidates the session so /me then returns 401", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const cookie = sessionCookie(loginRes);

      await request(app).post("/api/auth/logout").set("Cookie", [cookie]);
      const meRes = await request(app).get("/api/auth/me").set("Cookie", [cookie]);
      expect(meRes.status).toBe(401);
    });

    it("logout with no session at all still succeeds (idempotent no-op)", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).post("/api/auth/logout");
      expect(res.status).toBe(200);
    });
  });

  describe("invite endpoints", () => {
    it("an admin creates an invite, a public GET reveals just enough to render, and accepting logs the invitee in", async () => {
      db = await openTestDb();
      await seedOrgAndAdmin(db.pool);
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const adminCookie = sessionCookie(loginRes);

      const createRes = await request(app)
        .post("/api/team/invites")
        .set("Cookie", [adminCookie])
        .send({ email: "newbie@example.com", role: "member" });
      expect(createRes.status).toBe(201);
      const token: string = createRes.body.token;
      expect(token).toBeTruthy();

      const infoRes = await request(app).get(`/api/invites/${token}`);
      expect(infoRes.status).toBe(200);
      expect(infoRes.body).toMatchObject({ email: "newbie@example.com" });

      const acceptRes = await request(app).post(`/api/invites/${token}/accept`).send({ password: "a-real-password" });
      expect(acceptRes.status).toBe(200);
      expect(sessionCookie(acceptRes)).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=`));
    });

    it("a non-admin cannot create an invite", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      await createUser(db.pool, { organizationId: orgId, email: "member@example.com", passwordHash: await hashPassword("password123"), role: "member", name: "Member" });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "member@example.com", password: "password123" });
      const memberCookie = sessionCookie(loginRes);

      const res = await request(app).post("/api/team/invites").set("Cookie", [memberCookie]).send({ email: "x@example.com", role: "member" });
      expect(res.status).toBe(403);
    });

    it("GET /api/invites/:token returns 404 for an unknown token", async () => {
      db = await openTestDb();
      const app = buildApp(db.pool);
      const res = await request(app).get("/api/invites/not-a-real-token");
      expect(res.status).toBe(404);
    });
  });

  describe("team endpoints", () => {
    it("an admin lists the team, resets a member's password, and removes a member", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      const member = await createUser(db.pool, {
        organizationId: orgId,
        email: "member2@example.com",
        passwordHash: await hashPassword("password123"),
        role: "member",
        name: "Member Two",
      });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "admin@example.com", password: "password123" });
      const adminCookie = sessionCookie(loginRes);

      const listRes = await request(app).get("/api/team").set("Cookie", [adminCookie]);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(2);

      const resetRes = await request(app).post(`/api/team/${member.id}/reset-password`).set("Cookie", [adminCookie]);
      expect(resetRes.status).toBe(200);
      expect(resetRes.body.temporaryPassword).toBeTruthy();

      const removeRes = await request(app).delete(`/api/team/${member.id}`).set("Cookie", [adminCookie]);
      expect(removeRes.status).toBe(204);

      const listAfter = await request(app).get("/api/team").set("Cookie", [adminCookie]);
      expect(listAfter.body.find((m: { id: string }) => m.id === member.id).disabledAt).not.toBeNull();
    });

    it("a non-admin gets 403 from every team endpoint", async () => {
      db = await openTestDb();
      const { orgId } = await seedOrgAndAdmin(db.pool);
      await createUser(db.pool, { organizationId: orgId, email: "plain@example.com", passwordHash: await hashPassword("password123"), role: "member", name: "Plain" });
      const app = buildApp(db.pool);
      const loginRes = await request(app).post("/api/auth/login").send({ email: "plain@example.com", password: "password123" });
      const memberCookie = sessionCookie(loginRes);

      expect((await request(app).get("/api/team").set("Cookie", [memberCookie])).status).toBe(403);
      expect((await request(app).post("/api/team/some-id/reset-password").set("Cookie", [memberCookie])).status).toBe(403);
      expect((await request(app).delete("/api/team/some-id").set("Cookie", [memberCookie])).status).toBe(403);
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/users/routes.test.ts`
Expected: FAIL — `./routes.js` doesn't exist yet.

- [ ] **Step 4: Create `server/src/users/routes.ts`**

```ts
import { Router } from "express";
import type { Pool } from "pg";
import { verifyLogin } from "./users.js";
import { createSession, deleteSession, requireSession, SESSION_COOKIE_NAME } from "./sessions.js";
import { createInvite, getInviteByToken, acceptInvite } from "./invites.js";
import { listTeamMembers, resetMemberPassword, removeMember } from "./team.js";

const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function setSessionCookie(res: import("express").Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  });
}

function requireAdmin(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export function createUsersRouter(db: Pool): Router {
  const router = Router();
  const auth = requireSession(db);

  router.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body as { email?: unknown; password?: unknown };
    if (typeof email !== "string" || typeof password !== "string" || email === "" || password === "") {
      res.status(400).json({ error: "email and password are required" });
      return;
    }
    const user = await verifyLogin(db, email, password);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const session = await createSession(db, user.id);
    setSessionCookie(res, session.id);
    res.status(200).json(user);
  });

  // Deliberately not gated by `auth` — logging out with no session, or an already-expired one,
  // should just succeed as a no-op rather than 401ing on the way out.
  router.post("/api/auth/logout", async (req, res) => {
    const header = req.headers.cookie;
    const sessionId = header
      ?.split(";")
      .map((p) => p.trim().split("="))
      .find(([name]) => name === SESSION_COOKIE_NAME)?.[1];
    if (sessionId) await deleteSession(db, decodeURIComponent(sessionId));
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(200).json({ ok: true });
  });

  router.get("/api/auth/me", auth, (req, res) => {
    res.json(req.user);
  });

  router.get("/api/invites/:token", async (req, res) => {
    const invite = await getInviteByToken(db, req.params.token);
    if (!invite || invite.accepted_at !== null || new Date(invite.expires_at).getTime() < Date.now()) {
      res.status(404).json({ error: "This invite link is invalid or has expired" });
      return;
    }
    res.json({ email: invite.email });
  });

  router.post("/api/invites/:token/accept", async (req, res) => {
    const { password } = req.body as { password?: unknown };
    if (typeof password !== "string") {
      res.status(400).json({ error: "password is required" });
      return;
    }
    try {
      const { user, sessionId } = await acceptInvite(db, req.params.token, password);
      setSessionCookie(res, sessionId);
      res.status(200).json(user);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/api/team/invites", auth, requireAdmin, async (req, res) => {
    const { email, role } = req.body as { email?: unknown; role?: unknown };
    if (typeof email !== "string" || email === "") {
      res.status(400).json({ error: "email is required and must be a non-empty string" });
      return;
    }
    if (role !== "admin" && role !== "member") {
      res.status(400).json({ error: "role must be 'admin' or 'member'" });
      return;
    }
    const invite = await createInvite(db, { organizationId: req.user!.organizationId, email, role, createdByUserId: req.user!.id });
    res.status(201).json(invite);
  });

  router.get("/api/team", auth, requireAdmin, async (req, res) => {
    res.json(await listTeamMembers(db, req.user!.organizationId));
  });

  router.post("/api/team/:userId/reset-password", auth, requireAdmin, async (req, res) => {
    try {
      const result = await resetMemberPassword(db, req.user!.organizationId, req.params.userId);
      res.status(200).json(result);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/team/:userId", auth, requireAdmin, async (req, res) => {
    try {
      await removeMember(db, req.user!.organizationId, req.params.userId);
      res.status(204).send();
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  return router;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/users/routes.test.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/users/routes.ts server/src/users/routes.test.ts
git commit -m "feat: add auth/invite/team HTTP routes"
```

---

## Task 8: Wire into `app.ts` and `index.ts`

**Files:**
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `createUsersRouter` (Task 7), `bootstrapIfNeeded` (Task 6).

- [ ] **Step 1: Update `server/src/app.ts`**

```ts
// Must be imported before any router is created — it patches Express's router prototype so a
// rejected promise from an async handler reaches error-handling middleware via next(err), the
// same way a synchronous throw always has. Without this, an async route handler's rejected
// promise is an unhandled rejection that crashes the process instead of producing a response —
// see this task's amendment note for why this became necessary during the Postgres migration.
import "express-async-errors";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { createAuthRouter } from "./auth/routes.js";
import { createConnectionsRouter } from "./connections/routes.js";
import { createEngineRouter } from "./engine/routes.js";
import { createPipelinesRouter } from "./pipelines/routes.js";
import { createUsersRouter } from "./users/routes.js";

export function createApp(db: Pool, config: Config, dataDir: string, webDistDir?: string): express.Express {
  const app = express();
  // Raised from Express's 100kb default so an imported deployment's zip (sent as base64 JSON —
  // see /api/deployments/import) doesn't get rejected before it ever reaches validation.
  app.use(express.json({ limit: "50mb" }));
  // Needed for res.cookie()/res.clearCookie() in users/routes.ts to set the session cookie with
  // the right flags — requireSession itself reads the raw Cookie header directly (see sessions.ts)
  // so it works with or without this middleware, but the login/logout/invite-accept routes need it.
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createUsersRouter(db));
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

  // Terminal error handler — restores the pre-migration behavior where an uncaught error (then:
  // a synchronous throw from the old SQLite driver; now: a rejected promise from an async handler,
  // forwarded here by express-async-errors above) becomes a 500 instead of crashing the process
  // or hanging the request. Must be registered last, and must have all 4 parameters (Express
  // only treats a 4-arg function as error-handling middleware).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Unhandled error in request handler", err);
    if (res.headersSent) return;
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
```

Note: `createUsersRouter` and `createAuthRouter` are two different routers with no path overlap — `createUsersRouter`'s routes are `/api/auth/*`, `/api/team/*`, `/api/invites/*`; `createAuthRouter`'s (pre-existing, Salesforce OAuth) routes are `/api/connections/org/authorize` and `/oauth/callback`. Both names containing "auth" is a naming coincidence between an old module and a new one, not a collision — deliberately not renamed here to keep this task's diff minimal; a future cleanup could rename one for clarity.

- [ ] **Step 2: Update `server/src/index.ts`**

```ts
import "dotenv/config";
import fs from "node:fs";
import { loadConfig } from "./config.js";
import { openDb, runMigrations } from "./db/client.js";
import { bootstrapIfNeeded } from "./users/bootstrap.js";
import { createApp } from "./app.js";
import { startScheduler } from "./scheduler.js";

const config = loadConfig();
const dataDir = process.env.DATA_DIR ?? "./data";
fs.mkdirSync(dataDir, { recursive: true });

const db = openDb(config.databaseUrl);
await runMigrations(db);
await bootstrapIfNeeded(db, config);

const app = createApp(db, config, dataDir, process.env.WEB_DIST_DIR);

// Catches up on anything scheduled while the server wasn't running, then polls for newly-due
// scheduled deployments every 30s — see scheduler.ts.
startScheduler(db, config, dataDir, 30_000);

app.listen(config.port, () => {
  console.log(`SFCowboy server listening on :${config.port}`);
});
```

- [ ] **Step 3: Update `server/src/app.test.ts` and `server/src/config.ts` test fixtures**

`server/src/app.test.ts` builds fixture `Config` objects (see e.g. its `databaseUrl: "unused-in-tests"` sentinel pattern) — since `Config` gained 3 new optional/defaulted fields (`bootstrapAdminEmail`, `bootstrapAdminPassword`, `bootstrapOrgName`), find every place in that file constructing a `Config` object literal and add `bootstrapOrgName: "unused-in-tests"` (the other two are optional and can be omitted). Do the same in any other test file that builds a full `Config` literal — search first: `grep -rn "databaseUrl:" server/src --include=*.test.ts` to find every fixture Config literal in the codebase, and add the new required field to each.

- [ ] **Step 4: Run the full server test suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: fully clean — this task doesn't change any existing route's behavior (bootstrap is a no-op once it has already run once, per Task 6's idempotency, and every existing test's `openTestDb()` starts from an empty `organizations` table each time... wait — this means every existing test run will trigger `bootstrapIfNeeded` to THROW, since no test file's setup sets `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` and no existing test calls `bootstrapIfNeeded` at all. Re-check: does anything other than `index.ts` call `bootstrapIfNeeded`? No — only `index.ts` does, and no test file exercises `index.ts` directly (it's the process entrypoint, run via `node dist/index.js`, never imported by a test). So no existing test's `openTestDb()` call path triggers bootstrap at all — confirmed safe, no existing test needs any change beyond the `Config` fixture literal fix in Step 3 above.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/src/index.ts server/src/app.test.ts
git commit -m "feat: wire users router and bootstrap into app.ts/index.ts"
```

---

## Task 9: Frontend API client — auth/invite/team functions

**Files:**
- Modify: `web/src/api/client.ts`

**Interfaces:**
- Produces: `CurrentUser` interface, `login(email, password): Promise<CurrentUser>`, `logout(): Promise<void>`, `fetchCurrentUser(): Promise<CurrentUser>`, `fetchInviteInfo(token): Promise<{ email: string }>`, `acceptInvite(token, password): Promise<CurrentUser>`, `TeamMember` interface, `fetchTeam(): Promise<TeamMember[]>`, `createTeamInvite(input): Promise<{ id, token, expiresAt }>`, `resetMemberPassword(userId): Promise<{ temporaryPassword }>`, `removeMember(userId): Promise<void>` — consumed by Tasks 10–13.

- [ ] **Step 1: Add a global 401 handler and the new auth/invite/team functions**

At the top of `web/src/api/client.ts`, change the `json`/`checkOk` helpers to redirect to `/login` on a 401 (any page's data fetch failing with "not authenticated" should bounce to the login page, not show a raw error), and add the new API functions. Insert this right after the existing `checkOk` function:

```ts
// A 401 from ANY endpoint means the session is gone (expired, logged out elsewhere, or removed
// by an admin) — bounce to the login page immediately rather than showing a raw "Not
// authenticated" error inline on whatever page happened to be open. Two exceptions, handled
// differently: fetchCurrentUser passes skipAuthRedirect=true explicitly, since App.tsx's own "am I
// logged in" check needs to see the 401 itself to decide whether to redirect (see Task 13). login()
// passes neither flag, but a failed login 401 never triggers a redirect anyway, because it can only
// ever happen while already sitting on /login — the pathname check below covers it without a
// second flag; Login.tsx's own catch block shows the error inline instead.
function handleUnauthorized(res: Response, skipAuthRedirect?: boolean): void {
  if (res.status === 401 && !skipAuthRedirect && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

export interface CurrentUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export function login(email: string, password: string): Promise<CurrentUser> {
  return fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  }).then((r) => json<CurrentUser>(r));
}

export function logout(): Promise<void> {
  return fetch("/api/auth/logout", { method: "POST" }).then(checkOk);
}

export function fetchCurrentUser(): Promise<CurrentUser> {
  return fetch("/api/auth/me").then((r) => {
    handleUnauthorized(r, true);
    return json<CurrentUser>(r);
  });
}

export function fetchInviteInfo(token: string): Promise<{ email: string }> {
  return fetch(`/api/invites/${token}`).then((r) => json(r));
}

export function acceptInvite(token: string, password: string): Promise<CurrentUser> {
  return fetch(`/api/invites/${token}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }).then((r) => json<CurrentUser>(r));
}

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

export function fetchTeam(): Promise<TeamMember[]> {
  return fetch("/api/team").then((r) => json(r));
}

export function createTeamInvite(input: { email: string; role: "admin" | "member" }): Promise<{ id: string; token: string; expiresAt: string }> {
  return fetch("/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function resetMemberPassword(userId: string): Promise<{ temporaryPassword: string }> {
  return fetch(`/api/team/${userId}/reset-password`, { method: "POST" }).then((r) => json(r));
}

export function removeMember(userId: string): Promise<void> {
  return fetch(`/api/team/${userId}`, { method: "DELETE" }).then(checkOk);
}
```

- [ ] **Step 2: Wire the 401 handler into the existing `json`/`checkOk` helpers**

Replace the existing `json`/`checkOk` functions with versions that call `handleUnauthorized`:

```ts
async function json<T>(res: Response): Promise<T> {
  handleUnauthorized(res);
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return res.json();
}

// For endpoints that return 204 No Content on success (DELETE routes) — `json<T>` can't be used
// for these since it always calls res.json() on the success path, which throws on an empty body.
async function checkOk(res: Response): Promise<void> {
  handleUnauthorized(res);
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
}
```

(`handleUnauthorized` itself must be defined above these two functions, or hoisted — place the whole new block from Step 1 immediately before `json`/`checkOk`'s existing location in the file, then apply this Step 2 edit to those two functions in place.)

- [ ] **Step 3: Run the existing client tests to verify nothing broke**

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: PASS — this task is purely additive to `client.ts` (new exports, and two existing helper functions gaining one line each); no existing exported function's behavior changed for a non-401 response.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/client.ts
git commit -m "feat: add auth/invite/team API client functions and global 401 redirect"
```

---

## Task 10: Frontend — Login page

**Files:**
- Create: `web/src/pages/Login.tsx`
- Create: `web/src/pages/Login.test.tsx`

**Interfaces:**
- Consumes: `login` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/Login.test.tsx` (follow the existing test conventions in this directory — `@testing-library/react` + `vitest`, matching e.g. `Connections.test.tsx`'s setup style: a `MemoryRouter` wrapper, `vi.mock` of the api client module):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Login } from "./Login.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

describe("Login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // jsdom doesn't implement navigation; Login redirects on success via window.location.href.
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("submits email and password and redirects to / on success", async () => {
    vi.mocked(api.login).mockResolvedValue({ id: "u1", organizationId: "o1", email: "a@example.com", name: "A", role: "admin" });
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => expect(api.login).toHaveBeenCalledWith("a@example.com", "password123"));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows the server's error message on failed login", async () => {
    vi.mocked(api.login).mockRejectedValue(new Error("Invalid email or password"));
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/Login.test.tsx`
Expected: FAIL — `./Login.js` doesn't exist yet.

- [ ] **Step 3: Create `web/src/pages/Login.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { login } from "../api/client.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      window.location.href = "/";
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
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
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/Login.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Login.tsx web/src/pages/Login.test.tsx
git commit -m "feat: add Login page"
```

---

## Task 11: Frontend — Accept Invite page

**Files:**
- Create: `web/src/pages/AcceptInvite.tsx`
- Create: `web/src/pages/AcceptInvite.test.tsx`

**Interfaces:**
- Consumes: `fetchInviteInfo`, `acceptInvite` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/AcceptInvite.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AcceptInvite } from "./AcceptInvite.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

function renderAt(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <Routes>
        <Route path="/invite/:token" element={<AcceptInvite />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AcceptInvite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the invited email once loaded, then accepts and redirects on submit", async () => {
    vi.mocked(api.fetchInviteInfo).mockResolvedValue({ email: "newbie@example.com" });
    vi.mocked(api.acceptInvite).mockResolvedValue({ id: "u1", organizationId: "o1", email: "newbie@example.com", name: "newbie@example.com", role: "member" });

    renderAt("tok123");
    expect(await screen.findByText(/newbie@example.com/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "a-good-password" } });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => expect(api.acceptInvite).toHaveBeenCalledWith("tok123", "a-good-password"));
    await waitFor(() => expect(window.location.href).toBe("/"));
  });

  it("shows an error and no form when the invite link is invalid", async () => {
    vi.mocked(api.fetchInviteInfo).mockRejectedValue(new Error("This invite link is invalid or has expired"));
    renderAt("bad-token");
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
import { useParams } from "react-router-dom";
import { fetchInviteInfo, acceptInvite } from "../api/client.js";

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const [email, setEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchInviteInfo(token)
      .then((info) => setEmail(info.email))
      .catch((err) => setLoadError((err as Error).message));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await acceptInvite(token, password);
      window.location.href = "/";
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
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
        <input
          id="invite-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          autoFocus
        />
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
git commit -m "feat: add invite-acceptance page"
```

---

## Task 12: Frontend — Team page

**Files:**
- Create: `web/src/pages/Team.tsx`
- Create: `web/src/pages/Team.test.tsx`

**Interfaces:**
- Consumes: `fetchTeam`, `createTeamInvite`, `resetMemberPassword`, `removeMember` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/Team.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Team } from "./Team.js";
import * as api from "../api/client.js";

vi.mock("../api/client.js");

const MEMBERS: api.TeamMember[] = [
  { id: "u1", email: "admin@example.com", name: "Admin", role: "admin", createdAt: "2026-01-01T00:00:00.000Z", lastLoginAt: null, disabledAt: null },
  { id: "u2", email: "member@example.com", name: "Member", role: "member", createdAt: "2026-01-02T00:00:00.000Z", lastLoginAt: null, disabledAt: null },
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

  it("invites a teammate and shows the returned link/token", async () => {
    vi.mocked(api.createTeamInvite).mockResolvedValue({ id: "i1", token: "tok-abc", expiresAt: "2026-02-01T00:00:00.000Z" });
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("admin@example.com");

    fireEvent.change(screen.getByLabelText(/invite email/i), { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send invite|invite/i }));

    await waitFor(() => expect(api.createTeamInvite).toHaveBeenCalledWith({ email: "new@example.com", role: "member" }));
    expect(await screen.findByText(/tok-abc/)).toBeInTheDocument();
  });

  it("resets a member's password and shows the temporary password", async () => {
    vi.mocked(api.resetMemberPassword).mockResolvedValue({ temporaryPassword: "temp-pw-123" });
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("member@example.com");

    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));

    await waitFor(() => expect(api.resetMemberPassword).toHaveBeenCalledWith("u2"));
    expect(await screen.findByText(/temp-pw-123/)).toBeInTheDocument();
  });

  it("removes a member and refetches the list", async () => {
    vi.mocked(api.removeMember).mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <Team />
      </MemoryRouter>
    );
    await screen.findByText("member@example.com");

    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => expect(api.removeMember).toHaveBeenCalledWith("u2"));
    expect(api.fetchTeam).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/Team.test.tsx`
Expected: FAIL — `./Team.js` doesn't exist yet.

- [ ] **Step 3: Create `web/src/pages/Team.tsx`**

```tsx
import { useEffect, useState, type FormEvent } from "react";
import { fetchTeam, createTeamInvite, resetMemberPassword, removeMember, type TeamMember } from "../api/client.js";

export function Team() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState<string | null>(null);
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
      const invite = await createTeamInvite({ email: inviteEmail, role: inviteRole });
      setInviteLink(`${window.location.origin}/invite/${invite.token}`);
      setInviteEmail("");
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleReset(userId: string) {
    setError(null);
    try {
      const result = await resetMemberPassword(userId);
      setTemporaryPassword(result.temporaryPassword);
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
      {inviteLink && (
        <div className="info-banner">
          Share this link with the invitee: <code>{inviteLink}</code>
        </div>
      )}
      {temporaryPassword && (
        <div className="info-banner">
          Temporary password (shown once — relay it to the teammate now): <code>{temporaryPassword}</code>
        </div>
      )}

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
                <button type="button" onClick={() => handleReset(m.id)} disabled={!!m.disabledAt}>
                  Reset password
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/Team.test.tsx`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Team.tsx web/src/pages/Team.test.tsx
git commit -m "feat: add Team management page"
```

---

## Task 13: Frontend — auth-gate `App.tsx`, replace the display-name field, remove `runBy`

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/UserMenu.tsx`
- Create: `web/src/UserMenu.test.tsx`
- Delete: `web/src/DisplayNameField.tsx`, `web/src/DisplayNameField.test.tsx`, `web/src/displayName.ts`, `web/src/displayName.test.ts`
- Modify: `web/src/components/DeploymentEditor.tsx`
- Modify: `web/src/pages/DeploymentDetail.tsx`
- Modify: `web/src/pages/PipelineRunDetail.tsx`
- Modify: `web/src/api/client.ts` (remove the `runBy` field from `DeployRunOptions`)

**Interfaces:**
- Consumes: `fetchCurrentUser`, `logout`, `CurrentUser` (Task 9); `Login` (Task 10); `AcceptInvite` (Task 11); `Team` (Task 12).

- [ ] **Step 1: Remove `runBy` from `DeployRunOptions` in `web/src/api/client.ts`**

Find the `DeployRunOptions` interface and delete its `runBy?: string` field and the comment line directly above it. Every caller that currently passes `runBy: getDisplayName() || undefined` inside a `DeployRunOptions`-shaped object literal will now have an excess property — those call sites are fixed in Step 4 below, in the same order, so this step alone will show 3 TypeScript errors until Step 4 lands; that is expected in the middle of this task, not a sign of a problem.

- [ ] **Step 2: Delete the free-text display-name files**

```bash
git rm web/src/DisplayNameField.tsx web/src/DisplayNameField.test.tsx web/src/displayName.ts web/src/displayName.test.ts
```

- [ ] **Step 3: Create `web/src/UserMenu.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UserMenu } from "./UserMenu.js";
import * as api from "./api/client.js";

vi.mock("./api/client.js");

describe("UserMenu", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(window, "location", { value: { href: "" }, writable: true });
  });

  it("shows the current user's name and role", () => {
    render(<UserMenu user={{ id: "u1", organizationId: "o1", email: "a@example.com", name: "Ada", role: "admin" }} />);
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("logs out and redirects to /login when clicked", async () => {
    vi.mocked(api.logout).mockResolvedValue(undefined);
    render(<UserMenu user={{ id: "u1", organizationId: "o1", email: "a@example.com", name: "Ada", role: "member" }} />);

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    await waitFor(() => expect(window.location.href).toBe("/login"));
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd web && npx vitest run src/UserMenu.test.tsx`
Expected: FAIL — `./UserMenu.js` doesn't exist yet.

- [ ] **Step 5: Create `web/src/UserMenu.tsx`**

```tsx
import { logout, type CurrentUser } from "./api/client.js";

/** Replaces the old free-text "Your name" field now that real accounts exist — shows who's
 * actually logged in and lets them log out. See displayName.ts's removal in this same task. */
export function UserMenu({ user }: { user: CurrentUser }) {
  async function handleLogout() {
    await logout();
    window.location.href = "/login";
  }

  return (
    <div className="user-menu">
      <span className="user-menu-name" title={user.email}>
        {user.name}
      </span>
      <button type="button" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd web && npx vitest run src/UserMenu.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 7: Remove `getDisplayName`/`runBy` from the three call sites**

In `web/src/components/DeploymentEditor.tsx`: delete the `import { getDisplayName } from "../displayName.js";` line, and delete the `runBy: getDisplayName() || undefined,` line from whatever `DeployRunOptions`-shaped object it constructs (around the run/rerun call).

In `web/src/pages/DeploymentDetail.tsx`: delete the `import { getDisplayName } from "../displayName.js";` line, and change `await scheduleDeployment(id, { scheduledAt: new Date(scheduleInput).toISOString(), runBy: getDisplayName() || undefined });` to `await scheduleDeployment(id, { scheduledAt: new Date(scheduleInput).toISOString() });`.

In `web/src/pages/PipelineRunDetail.tsx`: delete the `import { getDisplayName } from "../displayName.js";` line, and change `await deployPipelineStep(runId, stepIndex, { validateOnly, runBy: getDisplayName() || undefined });` to `await deployPipelineStep(runId, stepIndex, { validateOnly });`.

`pages/History.tsx` needs NO change — it only reads `d.run_by` for display (now populated server-side from the authenticated user instead of the free-text field), never calls `getDisplayName`.

- [ ] **Step 8: Rewrite `web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import { NavLink, Outlet, Route, Routes, useLocation } from "react-router-dom";
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
import { AcceptInvite } from "./pages/AcceptInvite.js";
import { Team } from "./pages/Team.js";
import { Logo } from "./Logo.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { UserMenu } from "./UserMenu.js";
import { fetchCurrentUser, type CurrentUser } from "./api/client.js";
import { HomeIcon, ConnectionsIcon, PipelinesIcon, DeploymentsIcon, HistoryIcon } from "./NavIcons.js";
import { FlowBackground } from "./components/FlowBackground.js";

// The New Deployment page's component table needs real room for its columns; every other page
// is a form/list that reads better narrow, so only these routes get the wider layout. A
// deployment detail page can also render that same component table (reopening a pending draft),
// so it's matched by pattern rather than listed as a single fixed path.
const WIDE_PATHS = ["/deploy/new"];
const WIDE_PATH_PATTERN = /^\/deployments\/[^/]+$/;

// Routes reachable without a session — everything else redirects to /login if fetchCurrentUser
// fails. /invite/:token is matched by prefix since it carries a variable token segment.
function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/invite/");
}

export function App() {
  const location = useLocation();
  const isWide = WIDE_PATHS.includes(location.pathname) || WIDE_PATH_PATTERN.test(location.pathname);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checkedAuth, setCheckedAuth] = useState(false);

  useEffect(() => {
    if (isPublicPath(location.pathname)) {
      setCheckedAuth(true);
      return;
    }
    fetchCurrentUser()
      .then(setUser)
      .catch(() => {
        window.location.href = "/login";
      })
      .finally(() => setCheckedAuth(true));
    // Re-checks on every navigation — cheap (one GET), and catches a session that expired or was
    // revoked by an admin while this tab sat open on a page that hadn't made any other API call yet.
  }, [location.pathname]);

  if (isPublicPath(location.pathname)) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/invite/:token" element={<AcceptInvite />} />
      </Routes>
    );
  }

  if (!checkedAuth || !user) {
    return <div className="auth-page">Loading…</div>;
  }

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
          {user.role === "admin" && <NavLink to="/team">Team</NavLink>}
        </div>
        <div className="app-nav-right">
          <UserMenu user={user} />
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

`/team` is registered as a route for every logged-in user regardless of role — a `member` who navigates there directly (not via the hidden nav link) hits the real page, whose own `GET /api/team` call gets a 403 from the server and shows that as an inline error, exactly like every other admin-only action in this plan. This matches the design spec's security principle: hiding the nav link is a UX convenience, the server-side `requireAdmin` check is the actual access control — the frontend route doesn't need its own redundant role gate.

- [ ] **Step 9: Update `web/src/App.test.tsx`**

`App.test.tsx` almost certainly renders `<App />` directly and asserts on the nav/routes without mocking `fetchCurrentUser` — since `App` now fetches the current user on mount for any non-public path, existing tests need `vi.mock("./api/client.js")` (if not already present) with `fetchCurrentUser` mocked to resolve a fixture `CurrentUser`, added to each test's setup (or a shared `beforeEach`). Read the file first to see its exact current structure and existing mocks (it may already mock `./api/client.js` for other functions like `fetchDeployments`/`fetchConnections` used by `Home`), then add the `fetchCurrentUser` mock to whatever the file's existing mock-setup pattern is, following its established conventions rather than introducing a new one.

- [ ] **Step 10: Run the full web test suite and typecheck**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: fully clean.

- [ ] **Step 11: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/UserMenu.tsx web/src/UserMenu.test.tsx web/src/api/client.ts web/src/components/DeploymentEditor.tsx web/src/pages/DeploymentDetail.tsx web/src/pages/PipelineRunDetail.tsx
git commit -m "feat: auth-gate the app, replace the free-text name field with the logged-in user"
```

---

## Task 14: Full verification

**Files:** none — pure verification.

- [ ] **Step 1: Full server suite and typecheck**

Run: `cd server && npx tsc --noEmit && npx vitest run`
Expected: fully clean. This is the first point where every backend test in this plan runs together.

- [ ] **Step 2: Full web suite and typecheck**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: fully clean.

- [ ] **Step 3: Build both packages**

Run: `cd server && npm run build && cd ../web && npm run build`
Expected: both succeed.

- [ ] **Step 4: Manual smoke test**

Set `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`/`BOOTSTRAP_ORG_NAME` in `server/.env` against a throwaway/local Postgres database, boot the built server (`WEB_DIST_DIR=../web/dist node dist/index.js`), and confirm by hand: the app redirects to `/login` when not authenticated; the bootstrap admin can log in; `/team` lets that admin invite a teammate and shows the invite link; opening that link in a new session (e.g. an incognito window) shows the invited email and accepts a password; the new teammate is logged in immediately after accepting; the admin can reset the teammate's password (shown once) and remove them (their session stops working on the next request); logging out redirects to `/login`. Existing pages (Connections, Pipelines, Deployments, History) still load and function exactly as before — this plan doesn't scope them to an organization yet, so a logged-in user of any role still sees all existing data, which is the known, disclosed state per this plan's Scope Boundary section.

- [ ] **Step 5: Commit** (only if Steps 1-4 found something to fix; otherwise nothing to commit)

## After this plan ships

The follow-up plan ("Phase 1b — org-scoping") threads `organization_id` through every existing domain module and route (`connections`, `pipelines`, `pipelineRuns`, `deploy`, `rollback`, `sfConnection`, and all 4 existing route files), applies `requireSession` to those routes, tightens the 5 `organization_id` columns from nullable to `NOT NULL`, and removes the free-text-attribution comments this plan's `run_by`/`setRunBy` code still carries from the pre-auth era. Do not start it until this plan is merged and verified.
