# SFCowboy — Salesforce Click-Deploy Tool

Design spec. Status: approved for implementation planning.

## 1. Purpose

A self-hosted, single-user web app for comparing and deploying Salesforce
metadata between orgs (sandbox/production) and/or a git repository, in the
spirit of Copado Essentials / Click Deploy: connect endpoints, see a diff,
select components, click deploy. No change sets, no manual package.xml
editing.

## 2. Non-goals (explicitly out of scope for this build)

- Multi-user accounts / team permissions — solo user only, Salesforce OAuth
  is the only auth layer.
- Scheduled or CI-triggered deployments, approval gates, Slack/email
  notifications.
- Support for metadata types with no `describeMetadata`/source-format
  representation (e.g. some org-wide settings) — anything
  `@salesforce/source-deploy-retrieve` doesn't support is out of scope.

## 3. Architecture

- **Backend:** Node.js + TypeScript, Express, SQLite (via `better-sqlite3`)
  for all persistent state. No external database.
- **Frontend:** React + TypeScript (Vite), served as static assets by the
  same Express app in production (single deployable unit).
- **Salesforce engine:** `@salesforce/source-deploy-retrieve` (SDR) — the
  library Salesforce's own `sf` CLI is built on. Used for `describeMetadata`,
  component enumeration, retrieve, deploy, and SFDX source-format
  conversion. No `sf` CLI binary dependency — SDR is a library, invoked
  in-process.
- **Background work:** deploy/retrieve operations are long-running; run as
  in-process async jobs tracked in SQLite (`deployments` table status column
  polled by the frontend), not a separate queue/worker system — unnecessary
  for a solo-user tool with one deploy at a time.

### Project structure (monorepo, single repo `SFCowboy`)

```
SFCowboy/
  server/           # Express + TS backend
    src/
      auth/         # OAuth flow, token encryption/storage
      connections/  # org + git connection management
      engine/       # SDR wrapper: diff, retrieve, deploy, rollback
      db/           # SQLite schema + migrations
      routes/
    Dockerfile
  web/              # React + TS frontend (Vite)
    src/
  docs/
  .github/workflows/deploy.yml
  fly.toml
```

## 4. Data model (SQLite)

```
connections
  id, type ('org' | 'git'), nickname, created_at, last_used_at
  -- org fields --
  instance_url, org_type ('sandbox' | 'production'),
  encrypted_refresh_token
  -- git fields --
  remote_url, default_branch, encrypted_auth_token

pipelines
  id, name, connection_ids (ordered JSON array)

deployments
  id, source_connection_id, target_connection_id,
  component_list (JSON: type/name per component),
  test_level ('NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg'),
  status ('pending' | 'validating' | 'deploying' | 'succeeded' | 'failed' | 'rolled_back'),
  validate_only (bool),
  started_at, finished_at,
  error_detail (JSON, nullable),
  snapshot_path (nullable — path to pre-deploy retrieve zip on disk),
  is_rollback_of (nullable FK -> deployments.id)

deployment_items
  id, deployment_id, metadata_type, api_name, action ('add'|'modify'|'delete'),
  status ('pending'|'succeeded'|'failed'), error_message (nullable)
```

Encrypted fields use AES-256-GCM with a key read from an environment
variable (`ENCRYPTION_KEY`), never committed to the repo.

## 5. Connections

### Org connections
OAuth 2.0 Web Server Flow + PKCE against `login.salesforce.com` (production)
or `test.salesforce.com` (sandbox). Requires a Connected App to exist in the
target org:
- Callback URL: `https://deploy.effluence.com.au/oauth/callback`
- OAuth scopes: `api refresh_token offline_access`
- Sandboxes refreshed *after* the Connected App is created in production
  inherit it automatically; unrelated orgs (scratch orgs, other production
  orgs) need their own Connected App created the same way.

Refresh token is encrypted and stored; access tokens are fetched on demand
and never persisted.

### Git connections
Remote URL + branch + auth token (PAT). Backend maintains a local bare/shallow
clone per connection under a data volume, pulled fresh before each diff.
Repo must be in standard SFDX source format (`sfdx-project.json` +
`force-app/...`) — SDR reads/writes this format directly.

## 6. Pipelines

A pipeline is a named, ordered list of existing connections (org or git),
e.g. `Dev → QA → UAT → Production`. Purely organizational — the deploy
screen lets you pick a pipeline and target "the next stage," or bypass
pipelines entirely and pick any two connections ad hoc. No enforcement
beyond UI ordering; same deploy engine underneath either way.

## 7. Diff engine

Given a source and target connection (org or git, in any combination):

1. Resolve each side's full component set: `describeMetadata()` +
   `listMetadata()` per type for orgs; filesystem scan of the SFDX project
   for git.
2. Union the type list, compare component presence and
   `LastModifiedDate`/content checksum to classify each as unchanged /
   added / modified / removed (source-relative-to-target).
3. For components flagged possibly-modified, retrieve both versions (via
   SDR) and produce a text diff, cached for display.
4. Return a tree grouped by metadata type; user checks the components to
   include in the deployment.

## 8. Deploy engine

1. From selected components, build a component set / manifest via SDR.
2. **Snapshot:** retrieve the target org's current versions of every
   selected component (for existing components) and store the zip at
   `snapshot_path`, tied to the new `deployments` row. Components that
   don't yet exist in the target are recorded as "add" with no snapshot
   content — rollback will delete them.
3. **Validate (optional):** run a `checkOnly` deploy first if the user
   requests a dry run; surface component-level errors before a real deploy.
4. **Deploy:** run the real deploy via SDR against the target, with the
   chosen test level. Production targets force a minimum of
   `RunLocalTests` (Salesforce requirement). Poll deploy status and stream
   progress to the frontend; update `deployment_items` per component.
5. Salesforce deployments are atomic — a failed deploy auto-rolls-back on
   the target org itself, so failure just needs clear error surfacing, not
   engine-level recovery.
6. If target is a git connection, "deploy" instead commits the retrieved
   source-format files to the target branch (org→git direction).

### Rollback

A completed deployment shows a "Roll back" action, which:
- Redeploys `snapshot_path` for components that existed before
  (restores prior version), and
- Issues a `destructiveChanges.xml` delete for components that were newly
  added by the original deployment.
- Logged as a new `deployments` row with `is_rollback_of` set to the
  original.

## 9. History

Every validate/deploy/rollback run is a row in `deployments`, viewable in a
history log: timestamp, source/target, component count, test level,
status, and drill-in to per-component results and error detail.

## 10. UI screens

- **Connections** — list/add/remove org and git connections.
- **Pipelines** — optional; build/edit ordered connection lists.
- **New Deployment** — pick source + target (ad hoc, or via pipeline "next
  stage") → diff tree view → select components → choose test level /
  validate-only → deploy.
- **Deployment detail** — live progress, per-component status, error
  detail, Roll back button once complete.
- **History** — searchable log of past deployments/rollbacks.

## 11. Hosting & deployment

- **Runtime:** single Docker image (multi-stage build: Vite build → static
  assets served by Express) deployed to **Fly.io**.
- **Persistent volume:** mounted for the SQLite DB file, git clone cache,
  and deployment snapshots.
- **Domain:** `deploy.effluence.com.au` — a CNAME/A record at Crazy Domains
  pointed per `fly certs add deploy.effluence.com.au` output; Fly issues
  and renews the TLS cert automatically. Root domain `effluence.com.au`
  (GitHub Pages) is untouched.
- **CI/CD:** GitHub Actions workflow (`.github/workflows/deploy.yml`) runs
  on push to `main`: build, then `flyctl deploy` using a `FLY_API_TOKEN`
  repo secret.

### Configuration checklist (manual, one-time)

1. Create a Salesforce Connected App (see §5) in at least one org.
2. Create a Fly.io account, install `flyctl`, run `fly launch` (creates the
   app + volume) from this repo.
3. `fly certs add deploy.effluence.com.au`, then add the DNS record it
   outputs at Crazy Domains.
4. Set Fly app secrets: `ENCRYPTION_KEY` (generated, e.g.
   `openssl rand -hex 32`), Connected App consumer key/secret.
5. Add `FLY_API_TOKEN` as a GitHub Actions secret on the `SFCowboy` repo
   (`fly tokens create deploy`).
6. For git-repo connections on GitHub: a fine-grained PAT with read/write
   on the target repo(s), entered per-connection in the app (encrypted at
   rest, same as org tokens).

## 12. Security notes

- All secrets (refresh tokens, git PATs) encrypted at rest with
  `ENCRYPTION_KEY`; key never committed, supplied via Fly secret.
- OAuth uses PKCE; no client secret required for the Salesforce Connected
  App's user-agent/web-server flow token exchange beyond what Salesforce
  mandates.
- App has no login of its own by design (solo user) — access control is
  "whoever can reach the domain." Acceptable for MVP given single-user
  scope; noted as a gap if this ever becomes multi-user.

## 13. Future work (not in this build)

Multi-user accounts, scheduled/CI-triggered deployments, approval gates,
notifications, richer pipeline enforcement (blocking promotion without
successful validation at a prior stage).
