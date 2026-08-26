# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

Connecting a Salesforce org needs no manual Connected App setup — install a
small package once per org, then log in with Salesforce. See
[Connecting an org](#connecting-an-org) below.

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

On the Connections page:

1. **Install the SFCowboy package** — click the install link (once per org;
   works for both sandboxes and production). This adds a small, pre-built
   Connected App to that org — the same one used for every SFCowboy install,
   anywhere. Approve the access it requests when Salesforce's installer asks.
2. **Login with Salesforce** — enter a nickname, pick sandbox or production,
   and click the button. You're redirected to Salesforce's real login page,
   log in there, and approve access. SFCowboy never sees your password.

Under the hood this is a standard OAuth 2.0 authorization-code flow with
PKCE against the packaged Connected App's fixed Consumer Key (`sfPackageClientId`
in `server/src/config.ts`) — no client secret involved, and nothing is ever
auto-provisioned into your org via the Metadata API (many orgs, especially
Production, block that outright).

This approach replaced an earlier one that tried to log in with a raw
username/password and auto-create a Connected App on the fly. That doesn't
work against hardened orgs: Salesforce disables plain SOAP login by default
on many orgs, and separately blocks ad-hoc Connected App creation via the
Metadata API for untrusted callers ("You can't create a connected app.
Contact Salesforce Customer Support."). The packaged install sidesteps both
restrictions the same way any AppExchange app does.

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
