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

A `testcontainers`-backed helper replaces `openDb(":memory:")`:

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function openTestDb(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await runMigrations(pool);
  return { pool, stop: async () => { await pool.end(); await container.stop(); } };
}
```

Each of the 13 DB-touching test files swaps its setup call
(`openDb(":memory:"); runMigrations(db);` → `await openTestDb()`, with a
matching `stop()` in an `afterAll`/`afterEach`) but keeps its actual
assertions — mechanical rewrite, not a test-logic rewrite. Whether a
container is started once per test file or shared/reused across a run is
an implementation-time call based on measured test suite runtime; either
way each test's data must stay isolated (e.g. via a fresh schema per test
if containers are shared).

One real exception: `db/client.test.ts` has tests asserting SQLite-specific
behavior directly (`db.pragma("foreign_key_check")` for example). These are
rewritten against Postgres's actual equivalent behavior (a real foreign-key
violation raised on insert, or an `information_schema`/`pg_constraint`
query), not just re-pointed at a different connection.

Docker is already part of this project's toolchain (it's how production is
deployed today), so requiring Docker to run `npm test` is not a new
dependency for this team — but it is a change from today's instant,
zero-setup test runs, and CI configuration needs Docker-in-Docker (or an
equivalent) available to the test job.

## Production cutover

1. Add a `postgres` service to `docker-compose.yml` with its own named
   volume, alongside the existing `app` and `caddy` services.
2. Ship a one-time script, `scripts/migrate-sqlite-to-postgres.ts`: opens
   the existing SQLite file **read-only**, reads every table in dependency
   order (`connections` → `pipelines` → `deployments` → `deployment_items`
   → `pipeline_runs`), and inserts each row into the corresponding Postgres
   table via the same `pg.Pool` the app will use.
3. Maintenance window:
   - Stop the `app` container (nothing writes to the SQLite file mid-copy).
   - Run the migration script against the live SQLite volume.
   - Verify row counts match per table between the two databases before
     proceeding.
   - Update `app`'s configuration to point at the new Postgres
     `DATABASE_URL`.
   - Restart `app`, smoke-test the running instance (load the deployments
     list, view a connection, confirm data matches what was there before).
4. Keep the SQLite volume around, untouched, for a rollback window (e.g. a
   few days) — reverting is just pointing the config back at
   `better-sqlite3`/the old file and restarting, provided the code for that
   path hasn't been deleted yet (see "Rollback" below).

## Rollback

Because this phase touches every DB-facing module at once, a partial
rollback mid-implementation isn't practical — this ships as one deployable
unit, tested end-to-end against a real Postgres instance before the
production cutover happens. The rollback path that matters is the
**production cutover step**, not the code change: if the cutover reveals a
problem, revert the config to point at the still-intact SQLite file and
restart the previous container image (which still has the
`better-sqlite3` code path). The SQLite volume is never deleted or written
to as part of this migration, only read from.

## Testing approach

- Every existing test in the 13 affected files continues to pass, rewritten
  against the `testcontainers` Postgres helper instead of in-memory SQLite
  — same assertions, same coverage, proving behavior is unchanged.
- The migration script (`migrate-sqlite-to-postgres.ts`) gets its own test:
  seed a throwaway SQLite file with representative rows across all 5
  tables, run the script against it and a `testcontainers` Postgres
  instance, assert the Postgres tables end up with matching row counts and
  matching field-by-field content.
- A manual smoke test against a staging/local Docker Compose stack
  (`docker compose up` with the new `postgres` service) before the
  production cutover, exercising the main flows end-to-end (create a
  connection, run a diff, create and run a deployment, view history).
