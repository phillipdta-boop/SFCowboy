# Supabase-Backed Auth & Data Migration — Design Spec

## Overview

Replace the custom, self-built auth system (PR #1, branch `org-auth-core` —
unmerged) with Supabase Cloud as the identity provider, and move the app's
entire database (not just auth) onto Supabase's managed Postgres. This
supersedes the earlier "auth-core" + "org-scoping" two-plan split: with
Supabase, both land together as one plan rather than as a deferred
follow-up.

**Why:** Supabase Auth provides password hashing, session/token management,
and — critically — real email delivery (invite emails, password-reset
emails) for free, which the original design explicitly went without because
building/operating email infrastructure wasn't in scope. That constraint no
longer holds.

**Status of the existing custom-auth work:** PR #1 is to be closed unmerged.
Nothing from it ships. Since `main` currently has no `users` table at all,
there is no user data to carry forward — only the app's existing domain data
(connections, pipelines, deployments) needs to migrate.

## Goals

- Multi-tenant organizations with admin-provisioned team membership (same
  access-control intent as the original design: no public self-serve
  signup).
- Real email delivery for invites and password resets, via Supabase.
- Self-service "Forgot password" for any user, in addition to admin-manual
  actions from the Team page.
- Keep all existing domain logic (pipelines, deployments, the metadata
  engine, git integration) untouched — this is an auth/data-hosting swap,
  not a rewrite of the app.
- Keep organization-scoping enforcement in application code
  (`WHERE organization_id = $2`), matching this codebase's existing,
  proven pattern — not Postgres Row Level Security.

## Non-Goals

- No public self-serve signup. Every account is created via an admin
  invite.
- No Row Level Security policies. Supabase's Postgres is used as a plain
  Postgres database from the app's perspective; authorization stays in
  Express route handlers.
- No local Supabase emulator. `supabase start` requires Docker, which does
  not work on this dev machine (the same constraint discovered during the
  SQLite→Postgres migration). Local dev and automated tests hit a real,
  dedicated Supabase Cloud project instead.
- No change to encryption-at-rest for Salesforce refresh tokens / git PATs
  — `ENCRYPTION_KEY`-based app-level encryption is unrelated to which
  Postgres host is used, and carries over unchanged.

## Architecture

Two Supabase Cloud projects:

- **`sfcowboy-dev`** — used by local development and the automated test
  suite. Tests create and tear down real (throwaway) users and schemas
  against it over the network.
- **`sfcowboy-prod`** — the production project.

Each project provides a managed Postgres database *and* the Auth service
(GoTrue). Supabase's Postgres becomes the app's only database:
`organizations`, `connections`, `pipelines`, `deployments`,
`deployment_items`, `pipeline_runs`, and a new `app_users` table all live
there, alongside Supabase's own `auth.*` schema — which SFCowboy code
never touches directly except through Supabase's SDK/admin API.

```
Browser (React)
  │
  ├─ @supabase/supabase-js ──────────────▶ Supabase Auth (sfcowboy-prod)
  │     (login, logout, forgot-password,      issues/refreshes JWTs,
  │      session refresh — token stored        sends invite/reset emails
  │      in browser storage, Supabase default)
  │
  └─ fetch('/api/...', Authorization: Bearer <token>)
        │
        ▼
  Express backend (unchanged domain logic)
        │
        ├─ requireSupabaseUser middleware: verify JWT locally (cached JWKS),
        │  look up app_users for organization_id/role/disabled_at
        │
        └─ pg.Pool ──────────────────────▶ Supabase Postgres (sfcowboy-prod)
              (organizations, connections, pipelines, deployments,
               deployment_items, pipeline_runs, app_users — all app data)
```

The backend keeps a service-role Supabase client (server-side only, never
exposed to the browser) for admin operations: inviting users, disabling
them, generating password-reset links on an admin's behalf if ever needed.

## Data Model

**New table — `app_users`:**

```sql
CREATE TABLE app_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name TEXT NOT NULL,
  disabled_at TIMESTAMPTZ
);
```

This replaces what the old custom `users` table did, minus everything
Supabase now owns (`password_hash`, session data, email — email lives in
`auth.users`, joined via `id` when needed).

**Existing tables** (`connections`, `pipelines`, `deployments`,
`deployment_items`, `pipeline_runs`) gain a `organization_id TEXT NOT NULL
REFERENCES organizations(id)` column — `NOT NULL` from the start this time,
since (unlike the original design) there's no pre-Supabase deployment with
existing unscoped rows to backfill around; the one-time data migration (see
below) assigns every existing row to a single organization as part of the
migration itself.

**Removed entirely:** the `sessions` table, the `invites` table, `bcrypt`
as a dependency, and all custom session-cookie code (`readSessionCookie`,
`requireSession`, `SESSION_COOKIE_NAME`, the `cookie-parser` middleware
usage that existed only to support them).

## Auth Flows

**Invite a teammate (admin-initiated, the only way to create an account):**
Express calls `supabase.auth.admin.inviteUserByEmail(email, { data: {
organization_id, role } })` using the service-role client. Supabase sends
the actual invite email with a link.

**Invite acceptance:** handled entirely by Supabase's own hosted flow (the
invitee clicks the link, lands on a page — see Open Questions — and sets a
password). A **Postgres trigger on `auth.users` insert** reads the
`organization_id`/`role` that traveled as invite metadata
(`raw_app_meta_data` or `raw_user_meta_data`, whichever Supabase populates
from the `data` field passed to `inviteUserByEmail`) and inserts the
matching `app_users` row automatically. This keeps the org/role assignment
atomic with account creation, entirely in SQL, with no extra Express
endpoint or race window.

**Login / logout / session refresh:** handled client-side by
`@supabase/supabase-js` talking directly to Supabase — no Express
involvement at all. The custom `POST /api/auth/login` /
`POST /api/auth/logout` / `GET /api/auth/me` routes from the original
design are removed; the frontend gets the current user directly from the
Supabase client's session.

**Forgot password (self-service, new):** a "Forgot password?" link on the
login page triggers Supabase's built-in reset-password-by-email flow
(`supabase.auth.resetPasswordForEmail`), client-side, no backend
involvement.

**Admin resets a teammate's password:** stays available from the Team page
as a fallback. Implemented via
`supabase.auth.admin.generateLink({ type: 'recovery', email })` or
`supabase.auth.admin.updateUserById(userId, { password: tempPassword })` —
the exact choice is an implementation detail for the plan, not a design
fork (both are service-role admin calls with no user-facing difference
worth deciding now).

**Remove a teammate:** soft-delete via `app_users.disabled_at` (same
pattern as the original design) is the actual, load-bearing enforcement
point — every request's `requireSupabaseUser` middleware looks up
`app_users` and rejects a disabled user regardless of whether their JWT is
still cryptographically valid, exactly the way the original design's
session-based disable check worked. Additionally revoking the user's
Supabase session (so they can't mint a *new* token either) is a
worthwhile belt-and-suspenders addition, not a security-critical one.

## Session / Request Verification

`requireSupabaseUser` (replaces `requireSession`): reads the `Authorization:
Bearer <token>` header, verifies the JWT's signature locally against
Supabase's JWKS endpoint (cached, not fetched per request), then looks up
`app_users` by the JWT's `sub` claim for `organization_id`/`role`/
`disabled_at`, attaching the result to `req.user`. No network call to
Supabase happens on the request's hot path.

## Organization-Scoping Enforcement

Unchanged in spirit from the original design: every domain query that
should be scoped to an organization filters in SQL
(`WHERE id = $1 AND organization_id = $2`), not fetch-then-check in
application code. This plan makes `organization_id` `NOT NULL` on every
domain table from the start (see Data Model), so there is no "not yet
enforced" transitional window this time.

## Migration Plan

1. Create the two Supabase Cloud projects (`sfcowboy-dev`, `sfcowboy-prod`).
2. Apply the schema (existing domain tables + `organization_id NOT NULL` +
   the new `app_users` table + the invite-acceptance trigger) to both.
3. One-time data migration: copy existing rows from the current native
   Postgres (`connections`, `pipelines`, `deployments`, `deployment_items`,
   `pipeline_runs`) into `sfcowboy-prod`'s Postgres, assigning every row to
   a single organization created for this purpose. Likely a straightforward
   `pg_dump`/`pg_restore` or a small copy script — simpler than the
   original SQLite→Postgres migration since both sides are already
   Postgres.
4. Bootstrap the first organization + first admin user in `sfcowboy-prod`
   via `supabase.auth.admin.createUser` (or `inviteUserByEmail`) plus an
   `app_users` insert, replacing the original design's env-var-driven
   `bootstrapIfNeeded`.
5. Close PR #1 without merging.
6. Cut the production deployment over: update `DATABASE_URL` and the new
   Supabase project keys/URL in the production environment, deploy the new
   Express/React build, verify, then decommission the old native Postgres
   instance once confirmed stable.

## Testing Strategy

Backend tests continue to hit a real Postgres (no mocks, this codebase's
established convention) — now `sfcowboy-dev`'s Supabase Postgres instead
of a local instance. The existing schema-per-test-run isolation pattern
(`openTestDb()`-equivalent) should still work, since Supabase's
project-owner role has `CREATE SCHEMA` privileges. Tests now require
network access and will run slower than the current local-Postgres suite;
this is an accepted, disclosed trade-off, not something this plan tries to
optimize away.

Auth-flow tests (invite, login, password reset) exercise the real Supabase
Auth API against `sfcowboy-dev`, creating and deleting real (throwaway)
users per test run via the admin API — the same cleanup discipline
`testDb.ts` already applies to schemas today.

## Security Considerations

- **Token storage:** Supabase's default browser client stores the session
  token in browser storage (not an `httpOnly` cookie). This is a
  deliberate, disclosed trade-off against the original design, which used
  `httpOnly` cookies specifically to prevent token theft via XSS. Accepted
  for simplicity and to match Supabase's standard, well-supported
  integration pattern rather than building custom cookie-proxy plumbing
  Supabase doesn't provide out of the box for a plain Express+Vite stack.
- **Password policy:** minimum length and complexity rules move to
  Supabase's project-level Auth settings rather than being enforced in
  application code.
- **Disabled-user enforcement:** relies on `app_users.disabled_at` being
  checked on every request (see Remove a teammate, above) rather than
  solely on revoking the Supabase-side session — this is intentional and
  matches how the original design's session-disable check worked.
- **Service-role key handling:** the Supabase service-role key (used for
  `inviteUserByEmail`, admin password resets, disabling users) must only
  ever be held server-side (Express environment variable), never sent to
  the browser — same handling discipline as `ENCRYPTION_KEY` today.

## Open Questions (for the implementation plan to resolve, not blocking this spec)

- Exact shape of the invite-acceptance landing page: does the invitee land
  on Supabase's own hosted page, or a custom SFCowboy page that calls
  Supabase's client SDK to complete the password-set step? (The original
  design's `AcceptInvite.tsx` page suggests the latter is preferable for a
  consistent look — to be confirmed during planning.)
- Exact admin-reset-password mechanism (`generateLink` vs
  `updateUserById` with a temporary password) — noted above as a
  non-forking implementation detail.
- Whether `app_users.name` is set at invite time (passed as metadata,
  defaulting to the invited email like the original design) or asked for
  separately.
