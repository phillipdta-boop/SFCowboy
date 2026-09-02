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
