# Organizations, users, and auth — design

**Date:** 2026-09-02
**Status:** Approved by user, ready for implementation planning

## Problem

SFCowboy is single-tenant today: one Node/Express process, one Postgres database (as of Phase 1a), no login — anyone who can reach the app can see and touch everything. The "Your name" field on deployments is a free-text label, not an identity.

To become a sellable, hosted product, the app needs real accounts, team membership within an organization, and hard isolation between organizations' data. This spec is Phase 1b of the user-management roadmap: it builds organizations, users, sessions, and role-based access on top of the Postgres foundation Phase 1a shipped. Licensing/quota enforcement (Phase 2) and self-serve billing (Phase 3) are separate specs that build on this one.

## Goals

- Every request is authenticated via a server-side session; there is no way to reach app data without a valid session.
- One Organization's members share all of that organization's connections, pipelines, and deployments; no user ever sees another organization's data.
- Two roles exist: **Admin** (manage the team, invite/remove members, reset a member's password) and **Member** (everything else — full access to the org's connections/pipelines/deployments, no team management).
- The current single-tenant production data survives the cutover, migrated into one bootstrap Organization with one bootstrap Admin user.
- Session revocation is instant — removing a team member or an admin resetting a password immediately invalidates that user's existing sessions.

## Non-goals

- No licensing or usage-quota enforcement (Phase 2).
- No self-serve billing, checkout, or public signup (Phase 3). New organizations beyond the bootstrap one are created by a platform operator running a manual script, not through a UI.
- No email-sending infrastructure. Invites and password resets produce a link/credential that an admin manually delivers (Slack, email client, in person) — the app itself never sends mail.
- No SSO/OAuth login providers (email + password only).
- No login rate-limiting or brute-force lockout in v1. This app is internet-facing as a hosted SaaS, so this is a known, deliberate gap rather than an oversight — worth a dedicated hardening pass before real customer traffic, but out of scope for standing up the auth model itself.
- No user belonging to more than one organization — the `users` table has exactly one `organization_id` per row, not a many-to-many membership table.
- No changes to Salesforce/git connection behavior, deployment engine logic, or pipeline mechanics beyond adding the org-scoping filter — this phase is access control and multi-tenancy, not a feature phase.

## Data model

Four new tables, plus one new column on every existing table.

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
  last_login_at TEXT
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

`sessions.id` is the cookie value itself — a cryptographically random opaque token (not a JWT, not derived from anything guessable) — looked up directly on every request. There is no separate "session ID vs. token" split; the row's primary key *is* the credential. Logout, an admin removing a member, or a password reset all work the same way: `DELETE FROM sessions WHERE user_id = $1` (or the single matching row for logout), which takes effect on the very next request — this is the entire reason the roadmap chose server-side sessions over JWTs.

`invites.token` is a second, separate opaque random value (not reused from sessions) — it identifies one pending invite and is embedded in the link an admin shares.

Existing tables (`connections`, `pipelines`, `deployments`, `deployment_items`, `pipeline_runs`) each gain:

```sql
ALTER TABLE <table> ADD COLUMN IF NOT EXISTS organization_id TEXT REFERENCES organizations(id);
```

Added nullable first (so the migration can backfill before tightening), then backfilled during the bootstrap step below, then a follow-up `ALTER TABLE ... ALTER COLUMN organization_id SET NOT NULL` once every row has a value — same "detect current state, apply what's missing" idempotent migration idiom Phase 1a already established in `runMigrations()`.

This is Approach A from the design discussion: every table that needs row-level isolation carries `organization_id` directly, even where it's technically reachable via a join (e.g., `deployment_items` → `deployments` → `connections`). The redundancy is deliberate — every authorization check becomes a flat `WHERE organization_id = $1`, with no join to get wrong and no way for a forgotten join to leak one organization's data into another's response.

## Auth flow

- `POST /api/auth/login` — `{ email, password }`. Looks up the user by email, verifies the password against `password_hash` (bcrypt), creates a `sessions` row, sets an httpOnly, secure (in production), `SameSite=Lax` cookie containing the session id. Generic "invalid email or password" error on any failure — never reveal whether the email exists.
- `POST /api/auth/logout` — deletes the current session row, clears the cookie.
- `GET /api/auth/me` — returns `{ id, email, name, role, organizationId }` for the current session, or 401 if none. This is what the frontend uses to know who's logged in and to gate the UI (e.g., show the Team page only to admins).
- A session-resolving middleware runs before every `/api/*` route (except `/api/auth/login`, the invite-acceptance endpoints, and `/api/health`): reads the cookie, looks up the session, checks `expires_at`, loads the user, and attaches `req.user`. Missing, invalid, or expired → `401`. This middleware is the single choke point every other route relies on; there is no route that independently re-checks auth.
- Every existing route handler adds `organization_id = req.user.organizationId` to its queries and to every row it creates. This is the mechanical, touch-nearly-everything part of implementation — comparable in shape and size to Phase 1a's async conversion, except the change is "add one WHERE clause / one INSERT column" everywhere instead of "add await."
- Admin-only routes (role check in addition to the auth middleware): `POST /api/team/invites` (create an invite, returns the shareable link), `GET /api/team` (list the org's members), `POST /api/team/:userId/reset-password` (generates a new random temporary password server-side — the admin does not choose it — invalidates that user's existing sessions, and returns the temporary password once for the admin to relay; it is never retrievable again), `DELETE /api/team/:userId` (remove a member, invalidates their sessions). A non-admin hitting any of these gets `403`.
- `GET /invite/:token` (public, no auth) — the frontend route that renders the "set your password" form; the token identifies which invite. `POST /api/invites/:token/accept` — `{ password }`. Validates the token exists, isn't expired, and isn't already accepted; creates the `users` row with the invite's `organization_id`/`role`/`email`, hashes the password, marks the invite accepted, creates a session, and logs the new user straight in.
- `run_by` on deployments (`setRunBy`, `createDraftDeployment`, etc.) is populated from `req.user.name`/`req.user.id` server-side. The client-supplied `runBy` field in the request body and the whole `extractRunBy` validation helper in `engine/routes.ts` are removed — there is no longer a legitimate way for the client to claim a different identity than the one attached to their session.

## Bootstrapping the existing production data

The current production database has real connections/pipelines/deployments with no organization and no users at all — nothing to log in as. Turning this phase on for the first time needs one deliberate bootstrap step, not something that happens silently on every boot:

- Two new required env vars, read once: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`.
- On boot, if the `organizations` table is empty: create one Organization (name: a new `BOOTSTRAP_ORG_NAME` env var, or a sensible default like "My Organization" if unset), create one Admin user from the two bootstrap env vars, and backfill `organization_id` on every existing row in `connections`/`pipelines`/`deployments`/`deployment_items`/`pipeline_runs` to point at that new organization. This runs inside `runMigrations()` (same idempotent, run-on-every-boot pattern as everything else) — it's a no-op on every subsequent boot once `organizations` is non-empty.
- This mirrors the shape of Phase 1a's `migrate-sqlite-to-postgres.ts` one-time script, but as an idempotent boot-time check rather than a manually-invoked script, since it only needs to run once per environment and there's no separate "rehearse it first" concern the way a cross-engine data migration had — it's a pure Postgres-to-Postgres backfill within the already-migrated database.
- A second, independent organization (a genuinely new customer, beyond the bootstrapped one) is created by a platform operator running a small script that creates an `organizations` row plus its first Admin `users` row — deliberately manual, matching the "admin-provisioned only" decision and the "no self-serve signup" non-goal.

## Frontend changes

- A `/login` page (email + password form). Any route hit without a valid session redirects here.
- A `/invite/:token` page (public): set-password form, then redirects into the app already logged in.
- A `/team` page (admin-only, hidden from members): list of the org's members and their roles, an "Invite teammate" form (email + role, returns a link to copy), a reset-password action per member, a remove action per member.
- The header's current free-text "Your name" input is replaced with the logged-in user's actual name (from `GET /api/auth/me`) and a logout action.
- Every existing page's data-fetching is unaffected in shape (still hits the same endpoints) — the org-scoping happens entirely server-side; the frontend doesn't need to know or send an organization id anywhere.

## Security considerations

- Passwords hashed with bcrypt (cost factor 12) — an existing, well-understood choice; no new dependency beyond a `bcrypt` package, consistent with the project's existing preference for boring, well-trodden libraries over novel ones.
- Session cookies: `httpOnly` (unreachable from JS, mitigates XSS token theft), `secure` in production (HTTPS-only), `SameSite=Lax` (mitigates CSRF on state-changing GETs while still allowing normal top-level navigation).
- Session and invite tokens are generated with a cryptographically secure random source (`crypto.randomBytes`), never anything predictable like a UUID v1 or a counter.
- Sessions expire (`expires_at`) 30 days after creation — a fixed lifetime rather than living forever; a fresh login always creates a fresh 30-day session. No "remember me" toggle and no sliding/rolling expiry in v1 — one fixed lifetime for everyone, simplest thing that works.
- Passwords (both self-chosen at invite acceptance and admin-set at reset) must be at least 8 characters — the only strength rule enforced in v1. No complexity requirements (uppercase/digit/symbol) beyond that minimum.
- Every admin-only action re-checks `req.user.role === "admin"` server-side — the frontend hiding the Team page is a UX convenience, never the actual access control.
- `organization_id` filtering is applied at the query level in every domain module, not as a post-fetch filter — a row belonging to another organization should never be fetched from Postgres in the first place, not fetched-then-discarded.

## Testing approach

- Every new domain module (`auth.ts`/`sessions.ts`/`invites.ts`/`team.ts`, whatever the eventual file split is) gets its own test file using the same `openTestDb()` schema-per-run pattern Phase 1a established — no new test infrastructure needed.
- A dedicated test suite for the org-scoping filter itself: create two organizations, each with their own connections/pipelines/deployments, and assert that a session for org A's user can never retrieve, list, or mutate org B's rows via any existing route — this is the single most safety-critical property this phase introduces and deserves direct, explicit test coverage rather than only being implied by each route's individual tests.
- Session lifecycle tests: login creates a session and sets a cookie; logout deletes it and subsequent requests with the old cookie get 401; an admin removing a member or resetting their password invalidates that member's existing session immediately (not just prevents new logins).
- Invite lifecycle tests: a valid unexpired token can be accepted exactly once; an expired or already-accepted token is rejected; accepting an invite creates a user scoped to the inviting admin's organization with the invited role, not a role the invitee could choose themselves.
- Bootstrap tests: booting against an empty `organizations` table creates exactly one organization/admin and backfills every existing row; booting again afterward is a no-op (idempotent, matching every other migration in this codebase).
