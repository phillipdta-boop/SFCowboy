# Postgres migration design

**Date:** 2026-09-02
**Status:** Approved by user, ready for implementation planning

## Problem

SFCowboy is a single-tenant tool today: one Node/Express process, one
`better-sqlite3` file, no login. It already runs in production (Docker +
Caddy, `deploy.effluence.com.au`) with real data in a SQLite-backed volume.

To become a multi-tenant, sellable product, the next phases add
organizations, user accounts, and per-org licensing/usage limits (see the
overall roadmap discussed alongside this spec). Those phases all need
concurrent writes from multiple organizations against one shared database.
SQLite allows only one writer at a time — fine for a single person on their
own machine, but a shared hosted instance with several organizations
deploying concurrently will start queuing on writes.

This spec is the prerequisite: swap the persistence layer from SQLite to
Postgres, with **no behavior change and no new features**. Multi-tenancy,
auth, and everything else are separate specs that build on top of this one.
Doing the engine swap first — before org-scoping columns and auth tables
exist — means it only has to happen once, verified against the exact
behavior that exists today.

## Goals

- Every table, query, and migration currently expressed against
  `better-sqlite3` works identically against Postgres — same data shapes,
  same app-level behavior, same API responses.
- The existing idempotent, run-on-every-boot migration style is preserved,
  translated to Postgres idioms.
- Tests keep the property that they run against a real, isolated database
  per run with no shared state between tests.
- Production data (currently one SQLite file, one organization's worth of
  real usage) survives the cutover with a straightforward rollback path if
  something goes wrong.

## Non-goals

- No new tables, columns, or endpoints. This is not the multi-tenancy spec.
- No upgrading column types to more idiomatic Postgres equivalents — booleans
  stay `INTEGER` (0/1), JSON-shaped columns stay `TEXT` with
  `JSON.stringify`/`JSON.parse` in app code, timestamps stay `TEXT` ISO
  strings. Each of these is a legitimate future cleanup, but bundling any of
  them into this phase would violate "no behavior change" and roughly double
  the surface area to verify by hand.
- No migration framework (e.g. `node-pg-migrate`) — the existing
  hand-rolled, idempotent `runMigrations()` pattern continues.
- No connection pooling tuning, read replicas, or other scaling work beyond
  what a single `pg.Pool` gives for free.
- No zero-downtime cutover. A brief planned maintenance window is
  acceptable at current scale (effectively one organization's usage).

## Access layer

Raw `pg` (node-postgres) driver, hand-written parameterized SQL — no query
builder, no ORM. This matches the codebase's existing style everywhere else
(the SQL text is the source of truth, not a schema-as-code abstraction) and
keeps the diff mechanical: `db.prepare(sql).get(...args)` becomes
`(await pool.query(sql, args)).rows[0]`, `?` placeholders become
`$1, $2, ...`.

`server/src/config.ts`'s `dbPath`/`DB_PATH` (the SQLite file path) becomes
`databaseUrl`/`DATABASE_URL` (a standard Postgres connection string,
matching common PaaS/Docker convention) — the one required-config-shape
change this phase makes, consumed by `index.ts` to construct the `pg.Pool`
in place of today's `openDb(config.dbPath)`.

`db` is still threaded through the app the same way it is today —
constructor/factory injection into `createApp`, then into each route
module and domain module (`deploy.ts`, `orgConnections.ts`, etc.) — just as
a `pg.Pool` instead of a `better-sqlite3.Database`. No global singleton, no
new wiring pattern.

## Data model: type mapping

Every column keeps its current app-level representation; only the engine
changes.

| SQLite (today) | Postgres (this phase) | Notes |
|---|---|---|
| `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | IDs stay app-generated `randomUUID()` — already Postgres-friendly, no change. |
| `INTEGER` (booleans: `validate_only`, `ignore_warnings`, `allow_missing_files`, `auto_update_package`, `track_components_independently`) | `INTEGER` | App code doing `!!row.validate_only` / `flag ? 1 : 0` is untouched. Native `BOOLEAN` is a future cleanup. |
| `TEXT` (JSON-shaped: `component_list`, `run_tests`, `coverage_details`, `static_analysis_findings`, `error_detail`, `connection_ids`) | `TEXT` | App-level `JSON.stringify`/`JSON.parse` unchanged. `JSONB` is a future cleanup. |
| `TEXT` (timestamps: `created_at`, `started_at`, `finished_at`, etc.) | `TEXT` | ISO strings, app-formatted, unchanged. `TIMESTAMPTZ` is a future cleanup. |
| `CHECK (...)` enum-style constraints | `CHECK (...)` | Postgres supports these natively — same constraint text, no idiom change. |

## Migration mechanics

`runMigrations()` keeps its current signature and calling convention
(called once at boot, idempotent, no migration-version tracking table) —
only the SQL inside changes:

- The 18 existing additive `ALTER TABLE ADD COLUMN` statements (4 on
  `connections`, 2 on `pipelines`, 12 on `deployments`) become
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`. The `PRAGMA table_info`
  introspection that currently gates each one is dropped entirely — `IF NOT
  EXISTS` makes it redundant.
- The one full table-rebuild block (the `deployments` copy/drop/rename
  dance, needed in SQLite because it can't alter a CHECK constraint or drop
  a `NOT NULL` in place) collapses to three plain statements:
  ```sql
  ALTER TABLE deployments DROP CONSTRAINT deployments_status_check;
  ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
    CHECK (status IN ('pending','validating','deploying','succeeded','failed','rolled_back','cancelled'));
  ALTER TABLE deployments ALTER COLUMN source_connection_id DROP NOT NULL;
  ```
  Guarded by checking Postgres's own constraint metadata
  (`information_schema.check_constraints` or `pg_constraint`) for whether
  `'cancelled'` is already present, and `information_schema.columns` for
  whether `source_connection_id` is already nullable — same "detect current
  state, apply what's missing" idiom as today, just against Postgres's
  system catalogs instead of `sqlite_master`/`PRAGMA table_info`.
- `db.exec(schema)` (the initial `CREATE TABLE IF NOT EXISTS` block) becomes
  the equivalent Postgres DDL, run once via `pool.query(schema)`.
- `server/src/db/schema.sql` stays exactly where it is, and the existing
  `copy-assets` build step (`src/db/schema.sql` → `dist/db/schema.sql`)
  is unchanged — only the file's *contents* become Postgres DDL. No new
  file layout or build step is needed for this.

## Async conversion

Mechanical, module by module. Every exported function in the 7
DB-touching modules (`deploy.ts`, `orgConnections.ts`, `pipelineRuns.ts`,
`pipelines.ts`, `rollback.ts`, `gitConnections.ts`, `client.ts`) becomes
`async`; every `.prepare(sql).get()/.all()/.run()` becomes
`await pool.query(sql, params)` with `.rows[0]` / `.rows` / (nothing, for a
write) read off the result. `?` placeholders become positional `$1, $2, ...`.

`pipelines.ts` is the one module with no existing `async` functions today —
its callers in `pipelines/routes.ts` need `await` added at each call site,
same as everywhere else that already awaits Salesforce/git operations.

The single `db.transaction(() => {...})()` call (inside the migration
rebuild block) becomes an explicit helper:

```ts
async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
```

Any other place that currently relies on `better-sqlite3`'s implicit
single-connection consistency for a multi-statement write should be
reviewed during implementation and wrapped the same way if it needs
atomicity — the audit in this spec found exactly one such case
(the migration rebuild), but this is worth re-checking against the actual
code at implementation time rather than assumed complete here.

## Test infrastructure

**Amended 2026-09-02, during implementation:** the original design below
called for `testcontainers` to spin up a fresh Postgres container per test
run. The primary development machine for this project has no working
Docker install (Docker Desktop's WSL2 backend fails to start on it), so
this was changed to connect to one long-lived, real Postgres server —
installed natively (no admin rights, no Windows service; unzipped EDB
binaries, `initdb`, `pg_ctl start` on port 5433) — and isolate each test
run inside its own freshly created schema instead of its own container.
This preserves every property the spec cared about (a real Postgres
engine, no shared state between test runs, same `openTestDb()`/`TestDb`
interface every other task consumes) except "fresh container per run,"
which becomes "fresh schema per run" instead:

```ts
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { runMigrations } from "./client.js";

const ADMIN_CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? "postgres://sfcowboy@localhost:5433/sfcowboy";

export async function openTestDb(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
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

A machine with working Docker can still use `testcontainers` instead by
swapping this one file — nothing else in this spec depends on which
approach `openTestDb()` uses internally, only on its `{ pool, stop }`
shape. CI should run a real Postgres service container (most CI providers
support this natively, e.g. GitHub Actions' `services:` block) reachable
via `TEST_DATABASE_URL`, rather than requiring Docker-in-Docker for
`testcontainers` specifically.

Each of the 13 DB-touching test files swaps its setup call
(`openDb(":memory:"); runMigrations(db);` → `await openTestDb()`, with a
matching `stop()` in an `afterAll`/`afterEach`) but keeps its actual
assertions — mechanical rewrite, not a test-logic rewrite. Each test run's
data is isolated by construction (its own schema, dropped on `stop()`), so
test files can run concurrently without interfering.

One real exception: `db/client.test.ts` has tests asserting SQLite-specific
behavior directly (`db.pragma("foreign_key_check")` for example). These are
rewritten against Postgres's actual equivalent behavior (a real foreign-key
violation raised on insert, or an `information_schema`/`pg_constraint`
query), not just re-pointed at a different connection.

A real Postgres server (not necessarily Docker) is now this project's test
toolchain requirement — a change from today's instant, zero-setup test
runs. Document the `TEST_DATABASE_URL` requirement (or the local
`pgportable` install this implementation set up) wherever the team's local
setup instructions live, and ensure CI has an equivalent reachable
Postgres service.

## Production cutover

The key property that makes rollback safe: **the app never accepts live
traffic against Postgres until cutover is fully verified.** Rollback before
that point is free (nothing has written to Postgres yet, so there's nothing
to lose by going back). Once traffic resumes, Postgres is the system of
record and "rollback" changes meaning — see "Rollback," below.

1. **Rehearse first, off production.** Before touching the live volume, run
   this entire procedure (steps 2-4 below, plus a deliberate rollback) once
   against a **copy** of the production SQLite file in a non-production
   environment. The goal is that nobody is improvising the rollback steps
   for the first time during the real window.
2. Add a `postgres` service to `docker-compose.yml` with its own named
   volume, alongside the existing `app` and `caddy` services.
3. Ship a one-time script, `scripts/migrate-sqlite-to-postgres.ts`: opens
   the existing SQLite file **read-only**, reads every table in dependency
   order (`connections` → `pipelines` → `deployments` → `deployment_items`
   → `pipeline_runs`), and inserts each row into the corresponding Postgres
   table via the same `pg.Pool` the app will use.
4. Maintenance window:
   - Stop the `app` container — this is what actually stops writes; from
     this instant, the SQLite file is guaranteed static.
   - **Copy the SQLite file to a separate, timestamped backup path**
     (outside the Docker volume, e.g. to durable storage/off-box) before
     running anything else against it. This is a second, independent
     safety net beyond "the migration script only reads" — it means
     rollback doesn't depend on the volume surviving untouched, and
     protects against a bug in the migration script itself.
   - Run the migration script against the live SQLite volume (still
     read-only — the backup copy is the belt, this is the suspenders).
   - **Verify before going further, and do not proceed past this point on
     doubt:** row counts must match per table between the two databases,
     and a full manual smoke test must pass against the new Postgres
     instance while `app` is still pointed at SQLite (i.e. test the
     Postgres-backed app on a side port/staging config before it's the one
     serving real traffic).
   - Only once verification passes: update `app`'s configuration to point
     at the new Postgres `DATABASE_URL` and restart it as the one serving
     real traffic.
   - Immediately after restart, take a `pg_dump` backup of the
     now-live Postgres database — this becomes the rollback point for
     anything discovered *after* traffic resumed (see "Rollback").
5. Keep the SQLite backup copy (from step 4) indefinitely, or at minimum
   until the Postgres-backed app has been running in production without
   issue for a meaningful period (e.g. a couple of weeks) — it costs
   nothing to retain and is otherwise unrecoverable once discarded.

## Rollback

Two distinct rollback scenarios, because they have very different costs:

**Before traffic resumes on Postgres (during the maintenance window).**
Free rollback: nothing has written to Postgres yet in production, so if
row-count verification or the smoke test fails, simply don't flip
`app`'s config over — restart the previous container image against the
original, untouched SQLite file (plus its step-4 backup copy as a second
copy of the exact same data). No data loss is possible here by
construction, because the cutover procedure above never lets real traffic
touch Postgres until this check has already passed.

**After traffic has resumed on Postgres.** At this point Postgres is the
system of record — real writes (new deployments, connections, etc.) may
already exist there that don't exist in the SQLite file. Reverting to
SQLite here would silently discard them, so that is explicitly **not**
the rollback path once live. Instead:
- Restore the `pg_dump` backup taken immediately after cutover (or the
  most recent later backup, once regular backups are in place) to recover
  from a bad state.
- For a code-level problem (a bug in the ported queries, not a data
  problem), the fix is a normal forward deploy of a corrected image
  against the same Postgres database — not a database rollback at all.
- This is why the cutover procedure above insists on verifying
  thoroughly *before* the traffic switch: that step is the actual safety
  boundary, not anything that happens afterward.

Because this phase touches every DB-facing module at once, a partial
code-level rollback mid-implementation isn't practical either — this ships
as one deployable unit, tested end-to-end against a real Postgres instance
(including a rehearsed cutover-and-rollback, per step 1 above) before the
production cutover happens at all.

## Testing approach

- Every existing test in the 13 affected files continues to pass, rewritten
  against the `openTestDb()` Postgres helper (schema-per-run against a real
  server, per the amended "Test infrastructure" section above) instead of
  in-memory SQLite — same assertions, same coverage, proving behavior is
  unchanged.
- The migration script (`migrate-sqlite-to-postgres.ts`) gets its own test:
  seed a throwaway SQLite file with representative rows across all 5
  tables, run the script against it and an `openTestDb()` Postgres schema,
  assert the Postgres tables end up with matching row counts and matching
  field-by-field content.
- The rehearsal in "Production cutover" step 1 doubles as the final manual
  smoke test: a full `docker compose up` with the new `postgres` service,
  run against a copy of the real production SQLite file, exercising the
  main flows end-to-end (create a connection, run a diff, create and run a
  deployment, view history) — plus a deliberate rollback, so that path is
  proven to work before it's ever actually needed.
