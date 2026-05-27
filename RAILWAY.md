# Railway deployment (SSA SDR agent)

Pre-deploy checklist — you have **not** deployed yet. Follow these steps when ready.

## Architecture (2 services + Postgres)

| Service | Purpose | Start command | Schedule |
| --- | --- | --- | --- |
| **ssa-web** | Express API + `/queue` | `npm run start:web` | always on |
| **ssa-cron** | All PRD §9.1 jobs via tick dispatcher | `npm run start:cron` | `*/5 * * * *` (UTC) |
| **Postgres** | pgvector DB | — | Railway plugin |

One cron service is cheaper than 14 separate Railway services. `src/scripts/cronTick.ts` runs every 5 minutes and fires jobs whose Eastern-time schedule matches the current tick.

**Reply detection:** `checkReplies` runs on **every** 5-minute tick (~5 min latency). No second cron service needed. Gmail lookback is `newer_than:15m` for overlap if a tick is skipped.

**Daily pipeline order (ET):** `dailyScrape` 5:00 → `enrichAll` 5:30 → **`syncToHubspot` 5:45** → `scorePipeline` 6:00 → **`syncDirectoryExclusions` 6:15** → `draftColdBatch` 6:30 → … (see `src/shared/cronSchedule.ts`). Directory scrape flags listed facilities before cold drafts. HubSpot sync is **not** manual-only anymore.

## 1. Create Railway project

1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → select `Krash-SDR-agent`.
2. **Add PostgreSQL** (New → Database → PostgreSQL).
3. On the Postgres service, copy `DATABASE_URL` (or reference it from other services).

## 2. Web service (`ssa-web`)

Settings → **Build** (or use `railway.toml` — Nixpacks runs `npm ci` first, then):

```bash
npx prisma generate && npm run build && npx playwright install --with-deps chromium
```

`DATABASE_URL` is **not** required at build time (`prisma.config.ts` uses a placeholder for `generate`). It **is** required at runtime on both web and cron services: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.

Settings → **Deploy** → Start command:

```bash
npm run start:web
```

Settings → **Networking** → Generate domain (for `PUBLIC_URL`).

Settings → **Health check** → Path: `/health`

Or use the committed `railway.toml` (Railway picks it up automatically for the first service).

## 3. Cron service (`ssa-cron`)

Duplicate the repo service (same GitHub repo, same build command).

### Critical: use `railway.cron.toml`, not `railway.toml`

The root `railway.toml` sets `startCommand = "npm run start:web"`. Config-as-code **overrides** the Railway UI, so you cannot fix cron by editing Start Command in the dashboard while both services share `railway.toml`.

On **ssa-cron** only:

1. **Settings** → **Config-as-code** (or “Railway config file”)  
2. Set path to: **`/railway.cron.toml`**  
3. Save and **Redeploy**

That file sets:

```toml
startCommand = "npm run start:cron"
cronSchedule = "*/5 * * * *"
```

Railway requires cron services to **exit when done** — `cronTick.ts` does this.

**ssa-web** keeps the default `/railway.toml` (start:web + `/health`).

## 4. Shared environment variables (required for startup)

**If you skip `DATABASE_URL`, the container will crash with:**

```text
P1001: Can't reach database server at `127.0.0.1:5432`
```

That means Prisma fell back to the **build-only placeholder** — the web service never received a real Postgres URL.

On **both** `ssa-web` and `ssa-cron` → **Variables** → add:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |

Use the variable picker: select your **Postgres** service → `DATABASE_URL`. If the database service has a different name (e.g. `ssa-db`), use `${{ssa-db.DATABASE_URL}}` instead.

Project-level **Shared Variables** work too — attach them to both services.

Other secrets (copy from `.env.example`):

```
DATABASE_URL          ← ${{Postgres.DATABASE_URL}}  (REQUIRED)
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
GOOGLE_MAPS_API_KEY=
SERPER_API_KEY=
HUBSPOT_ACCESS_TOKEN=
HUBSPOT_OWNER_ID=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=
GMAIL_FROM=
CALENDLY_LINK=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
QUEUE_PASSWORD=
PUBLIC_URL            ← https://your-web-service.up.railway.app
UNSUBSCRIBE_SECRET=
BRIEF_RECIPIENT=      ← your email for daily brief + cost cap alerts
SONIA_PHONE=
```

## 5. Post-deploy (once)

Connect to Postgres and enable pgvector:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Railway: Postgres service → **Data** tab → Query, or `railway connect postgres`.

Run KB index locally (one-time, or add as a manual deploy hook):

```bash
npm run kb:reindex
```

Run HubSpot property setup locally:

```bash
tsx src/scripts/setupHubspotCustomProperties.ts
```

## 6. Verify

```bash
curl https://YOUR_PUBLIC_URL/health
```

Expect `"ok": true` once Postgres, HubSpot, and Claude are configured.

Trigger a single job manually (local or Railway shell):

```bash
CRON_JOB=checkCostCaps tsx src/scripts/runCron.ts
```

Check `AuditLog` for `cron.success` / `costCap.alert-sent` rows.

## 7. Cost cap alerts

`checkCostCaps` runs daily at **5:30 PM Eastern** via the cron tick. It emails `BRIEF_RECIPIENT` when Claude, Serper, Voyage, or Places approach 80%/100% of PRD §16 caps. No extra Railway cost — one more job inside the existing 5-min tick.

## 8. Infra cost vs Render

PRD §16 budgets **~$12/mo** for Railway web + Postgres + cron tick (Hobby + small Postgres). Actual usage varies; watch the Railway usage dashboard. API caps unchanged (~$299/mo total).

## Jobs not wired yet

These stay `enabled: false` in `src/shared/cronSchedule.ts` until their scripts land:

- ~~`draftFollowups`~~ (enabled — 7:00 AM ET nudge batch)
- `dropVoicemails`

`refreshGoogleSignals` runs Mondays 4:00 AM ET via `refreshIntentSignals`.

## Build troubleshooting

| Error | Fix |
| --- | --- |
| `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | Pull latest `main` — `prisma.config.ts` no longer requires a real URL at build time. Redeploy. |
| `P1001` / `127.0.0.1:5432` / database `"build"` | **`DATABASE_URL` not set on the web service.** Add `${{Postgres.DATABASE_URL}}` → redeploy. |
| `UndefinedVar: $NIXPACKS_PATH` | Railway/Nixpacks lint warning in generated Dockerfile — usually harmless if the build continues. |
| Build succeeds but `/health` fails | Set runtime `DATABASE_URL`, run `CREATE EXTENSION vector`, check HubSpot/Claude keys. |

## Manual one-off runs

```bash
CRON_JOB=dailyScrape tsx src/scripts/runCron.ts
CRON_JOB=checkCostCaps tsx src/scripts/runCron.ts
```

Enabled job names: see `CRON_JOBS` in `src/shared/cronSchedule.ts`.
