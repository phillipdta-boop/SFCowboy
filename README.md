# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

## Local development

Requires Node.js 22+ and `git` on your PATH.

```bash
cd server && npm install
cd ../web && npm install
```

Create `server/.env` (not committed) with:

```
ENCRYPTION_KEY=<32-byte hex string, e.g. output of `openssl rand -hex 32`>
SF_CLIENT_ID=<Salesforce Connected App consumer key>
SF_CLIENT_SECRET=<Salesforce Connected App consumer secret>
OAUTH_CALLBACK_URL=http://localhost:3000/oauth/callback
DB_PATH=./sfcowboy.db
DATA_DIR=./data
PORT=3000
```

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

## One-time production setup

1. **Salesforce Connected App** — in Setup of at least one org (production,
   if you want sandboxes refreshed afterward to inherit it):
   - Setup → App Manager → New Connected App
   - Enable OAuth Settings
   - Callback URL: `https://deploy.effluence.com.au/oauth/callback`
   - Selected OAuth Scopes: `Manage user data via APIs (api)`,
     `Perform requests at any time (refresh_token, offline_access)`
   - Save, then note the Consumer Key and Consumer Secret (Manage Consumer
     Details) — these become `SF_CLIENT_ID` / `SF_CLIENT_SECRET`.

2. **Fly.io app** — see `.github/workflows/ci.yml` and `fly.toml` for the
   deploy shape. One-time commands:

   ```bash
   fly auth login
   fly launch --no-deploy --copy-config
   fly volumes create sfcowboy_data --region syd --size 1
   fly secrets set ENCRYPTION_KEY=$(openssl rand -hex 32)
   fly secrets set SF_CLIENT_ID=<consumer key>
   fly secrets set SF_CLIENT_SECRET=<consumer secret>
   fly certs add deploy.effluence.com.au
   ```

3. **DNS at Crazy Domains** — add the record `fly certs add` printed for
   `deploy.effluence.com.au`. This does not touch the root `effluence.com.au`
   domain or its existing GitHub Pages site.

4. **GitHub Actions secret** — `fly tokens create deploy`, then add the
   output as the `FLY_API_TOKEN` secret on this repo
   (Settings → Secrets and variables → Actions). Once set, every push to
   `main` that passes tests deploys automatically.

5. **Git-repo connections** (optional, only if you plan to use a git repo as
   a deployment source/target) — generate a fine-grained GitHub personal
   access token with read/write access to the target repo, and enter it when
   adding the git connection in the app's Connections page. It's encrypted
   at rest the same way org refresh tokens are.
