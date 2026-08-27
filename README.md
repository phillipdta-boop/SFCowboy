# SFCowboy

A self-hosted, single-user tool for diffing and deploying Salesforce metadata
between orgs and/or a git repository, with rollback support. See
[docs/superpowers/specs/2026-08-24-sfcowboy-design.md](docs/superpowers/specs/2026-08-24-sfcowboy-design.md)
for the full design.

Connecting a Salesforce org needs no manual Connected App setup — just log in
with Salesforce. See [Connecting an org](#connecting-an-org) below.

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
   # edit .env, set ENCRYPTION_KEY to: openssl rand -hex 32
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
