# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

Connecting a Salesforce org needs no manual Connected App setup — just your
normal Salesforce login. See [Connecting an org](#connecting-an-org) below.

## Running it locally (recommended for everyday use)

Requires Node.js 22+ and `git` on your PATH.

```bash
npm run local
```

That's it. This one command:

- creates `server/.env` with a freshly generated encryption key the first time you run it
- installs dependencies for both packages if needed
- builds the frontend and backend
- starts the server and opens it in your browser at `http://localhost:3000`

Press Ctrl+C to stop it. Your connections and deployment history persist
between runs (`server/sfcowboy.db`, `server/data/` — both git-ignored).

## Connecting an org

On the Connections page, enter a nickname, pick sandbox or production, and
your Salesforce username/password (and security token, if your org requires
one for API logins — check Salesforce Setup → My Personal Information →
Reset My Security Token if you're not sure).

Under the hood, SFCowboy logs in once to auto-provision its own Connected App
in that org, then immediately exchanges your credentials for a normal OAuth
access/refresh token pair — your password is used for those two calls and is
never stored or logged. The first connection to a new org can take up to
about 2 minutes while Salesforce activates the new Connected App; the button
shows "Connecting…" for the duration.

This won't work for orgs with strict MFA/session-security policies that
block direct credential exchange (common on some Enterprise-tier orgs) —
Salesforce blocks that at the platform level regardless of what a client
does. There's currently no fallback flow in the app for that case.

## Developing (editing code, not just running it)

```bash
cd server && npm install
cd ../web && npm install
```

Copy `server/.env.example` to `server/.env` and fill in `ENCRYPTION_KEY`
(`openssl rand -hex 32`), or just run `npm run local` once from the repo
root to have it generated for you, then keep developing against that file.

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

## One-time production setup (Fly.io)

Everything below is only needed if you want this reachable somewhere other
than your own machine. For local use, see above — no Salesforce app
registration or hosting account is required.

1. **Fly.io app** — see `.github/workflows/ci.yml` and `fly.toml` for the
   deploy shape. One-time commands:

   ```bash
   fly auth login
   fly launch --no-deploy --copy-config
   fly volumes create sfcowboy_data --region syd --size 1
   fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
   fly certs add deploy.effluence.com.au
   ```

2. **DNS at Crazy Domains** — add the record `fly certs add` printed for
   `deploy.effluence.com.au`. This does not touch the root `effluence.com.au`
   domain or its existing GitHub Pages site.

3. **GitHub Actions secret** — `fly tokens create deploy`, then add the
   output as the `FLY_API_TOKEN` secret on this repo
   (Settings → Secrets and variables → Actions). Once set, every push to
   `main` that passes tests deploys automatically.

4. **Git-repo connections** (optional, only if you plan to use a git repo as
   a deployment source/target) — generate a fine-grained GitHub personal
   access token with read/write access to the target repo, and enter it when
   adding the git connection in the app's Connections page. It's encrypted
   at rest the same way org refresh tokens are.
