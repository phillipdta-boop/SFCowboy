# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

Connecting a Salesforce org needs no manual Connected App setup — just log in
with Salesforce. See [Connecting an org](#connecting-an-org) below.

## Setting up Supabase (required before running locally or in production)

SFCowboy uses [Supabase](https://supabase.com) Cloud as its identity provider
and its Postgres database — there is no bundled/local database option, and no
custom auth system. Before running the app anywhere (local dev or
production), you need a Supabase project:

1. Create a Supabase project (the free tier is fine for a single-team tool
   like this), or use an existing one.
2. From **Project Settings → API**, note the **Project URL** and the
   **service_role** key (a secret with full admin access to the project's
   Auth and database — never expose it to the browser or commit it) and the
   **anon** key (public by design, safe to ship in a browser bundle).
3. From **Project Settings → Database → Connection string**, use the
   **Session** pooler string (host pattern
   `aws-0-<region>.pooler.supabase.com:5432`) or the project's **Direct**
   connection string — **not** the Transaction pooler (typically port 6543);
   this codebase relies on session-level state that Transaction-mode pooling
   doesn't preserve across queries.
4. Fill in `server/.env` (copy from `server/.env.example`) with
   `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
   `TEST_DATABASE_URL` (used by the test suite instead of `DATABASE_URL` —
   pointing it at the same project is fine for local dev). See that file's
   inline comments for the full explanation of each.
5. Fill in `web/.env` (copy from `web/.env.example`) with `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY` — the same project's URL and anon key. These
   are inlined into the frontend bundle at **build time** by Vite, so the web
   app must be rebuilt after changing them.
6. On first boot against a database with no admin user yet, the server
   requires `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` (also in
   `server/.env`) to create the first admin account — safe to remove from
   `.env` after that first successful boot. Every teammate after that is
   added via the in-app **Team** page (admin-only), which sends a real invite
   email through Supabase.

Supabase Cloud's built-in email service (used for invite and password-reset
emails) has a low per-project rate limit intended for testing, not
production invite volume — configure a custom SMTP provider under
**Project Settings → Auth → SMTP Settings** before relying on this for real
usage.

## Running it locally (recommended for everyday use)

Requires Node.js 22+, `git` on your PATH, and a Supabase project set up per
the section above with `server/.env` and `web/.env` filled in.

```bash
npm run local
```

This one command:

- creates `server/.env` from `server/.env.example` with a freshly generated
  encryption key the first time you run it (it does **not** fill in the
  Supabase values above — do that first, or the server will refuse to start
  with a "Missing required env var" error)
- installs dependencies for both packages if needed
- builds the frontend and backend
- starts the server and opens it in your browser at `http://localhost:3000`

Press Ctrl+C to stop it. Your connections and deployment history live in the
Supabase project's database, so they persist between runs regardless of this
machine.

## Connecting an org

On the Connections page, enter a nickname, pick sandbox or production, and
click **Login with Salesforce**. You're redirected to Salesforce's real login
page, log in there, and approve access — SFCowboy never sees your password.
That's the whole flow, for any org, first connection or not.

Under the hood this is a standard OAuth 2.0 authorization-code flow with PKCE
against a fixed Consumer Key (`sfClientId` in `server/src/config.ts`) — no
client secret involved. A Connected App's Consumer Key is globally resolvable
by Salesforce's OAuth endpoints regardless of which org owns the app
definition, so this one Connected App (owned by an unrelated Salesforce
Developer Edition org) works to authorize *any* org — it doesn't need to
exist inside the org you're connecting, and nothing is ever provisioned into
that org at all. This is the same mechanism every third-party "Login with
Salesforce" integration uses (Slack, Zapier, Postman, etc.).

This approach replaced two earlier ones that didn't pan out:
- Logging in with a raw username/password and auto-creating a Connected App
  on the fly via the Metadata API. Salesforce blocks that outright on many
  orgs ("You can't create a connected app. Contact Salesforce Customer
  Support."), and separately disables plain SOAP login by default.
- Distributing the Connected App as an installable package (`packaging/` in
  this repo), on the assumption that OAuth required the app to exist inside
  each target org first. That assumption was wrong — the plain OAuth flow
  above works without installing anything, which is what this app actually
  does now. `packaging/` is kept only as the source-of-truth SFDX definition
  of the Connected App's OAuth settings, in case they ever need changing;
  nothing in the app depends on it being installed anywhere.

## Developing (editing code, not just running it)

```bash
cd server && npm install
cd ../web && npm install
```

Copy `server/.env.example` to `server/.env` and `web/.env.example` to
`web/.env`, then fill in both per [Setting up
Supabase](#setting-up-supabase-required-before-running-locally-or-in-production)
above (`ENCRYPTION_KEY` can be generated with `openssl rand -hex 32`, or just
run `npm run local` once from the repo root to have it generated for you in
`server/.env`, then keep developing against that file — it still won't fill
in the Supabase values, which have no safe default to generate).

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

Running the server, or the server's tests, requires a reachable **Supabase**
Postgres database — there is no SQLite/in-memory fallback, and no plain
local Postgres works either, since `server/src/db/schema.sql` references
Supabase's `auth.users` table unconditionally. Tests use their own
schema-per-run isolation (see `server/src/db/testDb.ts`) against whatever
`TEST_DATABASE_URL` points at (falls back to a local
`postgres://sfcowboy@localhost:5433/sfcowboy` only if that env var is unset,
which will fail against a real project's schema requirements — set
`TEST_DATABASE_URL` explicitly). Pointing it at the same Supabase project as
`DATABASE_URL` is fine for local dev; CI may use a separate project. Running
the server itself (outside `npm run local`) additionally requires
`DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` to be set —
see `server/.env.example`.

## One-time production setup (Oracle Cloud Always Free VM)

Everything below is only needed if you want this reachable somewhere other
than your own machine. For local use, see above — no Salesforce app
registration or hosting account is required.

This runs the same `Dockerfile` as local dev, behind Caddy for automatic
HTTPS, on an Oracle Cloud "Always Free" compute instance — free indefinitely,
not a trial. `docker-compose.yml` and `Caddyfile` at the repo root define
this; nothing else in the app changes.

1. **Oracle Cloud account + instance** (oracle.com, their console — this part
   can't be scripted, it's your account):
   - Sign up for Oracle Cloud Free Tier. Identity verification requires a
     card on file, but Always Free resources are never billed.
   - Create a compute instance: shape **VM.Standard.A1.Flex** (Ampere ARM,
     Always Free — up to 4 OCPU / 24GB total across all your Always Free
     instances), image **Ubuntu 24.04**, and attach/create a public IP.
   - Add an SSH key pair during creation (or paste your own public key) —
     you'll need it to connect.
   - **Open ports 80 and 443** in the instance's attached **Security
     List/Network Security Group** (VCN → Security Lists) — this is separate
     from the OS firewall and is the most common thing people miss. Oracle's
     free-tier VCN wizard usually only opens port 22 by default.

2. **Provision the VM** (SSH in as `ubuntu@<public-ip>`):
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
   sudo usermod -aG docker $USER && newgrp docker
   git clone https://github.com/phillipdta-boop/SFCowboy.git
   cd SFCowboy
   cp .env.example .env
   # edit .env: set ENCRYPTION_KEY (openssl rand -hex 32), and fill in
   # DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VITE_SUPABASE_URL,
   # and VITE_SUPABASE_ANON_KEY from your Supabase project (see "Setting up
   # Supabase" above) -- docker-compose.yml has no bundled database, so these
   # are all required, not optional. Set BOOTSTRAP_ADMIN_EMAIL/PASSWORD too if
   # this is the very first boot against this database.
   docker compose up -d --build
   ```
   Caddy automatically requests and renews a Let's Encrypt certificate for
   `deploy.effluence.com.au` the first time it's reachable on ports 80/443
   with DNS pointing at it (step 3) — no manual cert setup.

3. **DNS at Crazy Domains** — point the `deploy` A record at the VM's public
   IP (replacing whatever it points to today). This does not touch the root
   `effluence.com.au` domain or its existing GitHub Pages site.

4. **Deploying updates** — there's no CI auto-deploy for this path (that's
   Fly-specific, see below); pull and rebuild on the VM instead:
   ```bash
   cd SFCowboy && git pull && docker compose up -d --build
   ```

5. **Git-repo connections** (optional, only if you plan to use a git repo as
   a deployment source/target) — generate a fine-grained GitHub personal
   access token with read/write access to the target repo, and enter it when
   adding the git connection in the app's Connections page. It's encrypted
   at rest the same way org refresh tokens are.

## Alternative: Fly.io

A paid alternative to the above (Fly no longer offers a card-free free tier),
using the same `Dockerfile`. `.github/workflows/ci.yml` auto-deploys to Fly
on every push to `main` once set up.

1. **Fly.io app** — see `.github/workflows/ci.yml` and `fly.toml` for the
   deploy shape. One-time commands:

   ```bash
   fly auth login
   fly launch --no-deploy --copy-config
   fly volumes create sfcowboy_data --region syd --size 1
   fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
   fly secrets set DATABASE_URL=postgresql://postgres.your-project-ref:your-password@aws-0-your-region.pooler.supabase.com:5432/postgres
   fly secrets set SUPABASE_URL=https://your-project-ref.supabase.co
   fly secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   fly certs add deploy.effluence.com.au
   ```

   `fly.toml` has no bundled database, so `DATABASE_URL`, `SUPABASE_URL`, and
   `SUPABASE_SERVICE_ROLE_KEY` are all required, not optional — same values
   as `server/.env` in the [Setting up Supabase](#setting-up-supabase-required-before-running-locally-or-in-production)
   section above. If this is the very first boot against this database, also
   set `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD` the same way —
   safe to `fly secrets unset` both after the first successful boot.
   `APP_BASE_URL` and `OAUTH_CALLBACK_URL` don't need setting here: their
   defaults (in `server/src/config.ts`) already point at
   `deploy.effluence.com.au`, which is what this app is deployed as below.

2. **DNS at Crazy Domains** — add the record `fly certs add` printed for
   `deploy.effluence.com.au`. This does not touch the root `effluence.com.au`
   domain or its existing GitHub Pages site.

3. **GitHub Actions secrets** — three repo secrets
   (Settings → Secrets and variables → Actions):
   - `FLY_API_TOKEN` — output of `fly tokens create deploy`.
   - `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — the same project's
     URL and anon key used in `web/.env` (see [Setting up
     Supabase](#setting-up-supabase-required-before-running-locally-or-in-production)
     above). These get inlined into the web bundle at Docker build time (see
     `Dockerfile`'s `web-build` stage), and `fly.toml` can't carry them
     itself since it's committed to the repo — the CI workflow passes them
     to `flyctl deploy` as `--build-arg` flags instead. Deploying manually
     from your own machine instead of via CI needs the same two flags, e.g.
     `flyctl deploy --remote-only --build-arg VITE_SUPABASE_URL=... --build-arg VITE_SUPABASE_ANON_KEY=...`.

   Once all three secrets are set, every push to `main` that passes tests
   deploys automatically.

4. **Git-repo connections** (optional, only if you plan to use a git repo as
   a deployment source/target) — generate a fine-grained GitHub personal
   access token with read/write access to the target repo, and enter it when
   adding the git connection in the app's Connections page. It's encrypted
   at rest the same way org refresh tokens are.
