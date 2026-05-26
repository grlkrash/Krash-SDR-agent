# Railway deployment (SSA SDR agent)

Pre-deploy checklist — you have **not** deployed yet. Follow these steps when ready.

## Architecture (2 services + Postgres)

| Service | Purpose | Start command | Schedule |
| --- | --- | --- | --- |
| **ssa-web** | Express API + `/queue` | `npm run start:web` | always on |
| **ssa-cron** | All PRD §9.1 jobs via tick dispatcher | `npm run start:cron` | `*/5 * * * *` (UTC) |
| **Postgres** | pgvector DB | — | Railway plugin |

One cron service is cheaper than 14 separate Railway services. `src/scripts/cronTick.ts` runs every 5 minutes and fires jobs whose Eastern-time schedule matches the current tick.

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

Duplicate the repo service (same GitHub repo, same build command):

Settings → **Deploy** → Start command:

```bash
npm run start:cron
```

Settings → **Cron Schedule** (UTC):

```
*/5 * * * *
```

Railway requires cron services to **exit when done** — `cronTick.ts` does this.

## 4. Shared environment variables

Set on **both** `ssa-web` and `ssa-cron` (Railway shared variables or copy-paste):

```
DATABASE_URL          ← from Postgres service
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

- `draftFollowups`
- `dropVoicemails`

`refreshGoogleSignals` runs Mondays 4:00 AM ET via `refreshIntentSignals`.

## Build troubleshooting

| Error | Fix |
| --- | --- |
| `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | Pull latest `main` — `prisma.config.ts` no longer requires a real URL at build time. Redeploy. |
| `UndefinedVar: $NIXPACKS_PATH` | Railway/Nixpacks lint warning in generated Dockerfile — usually harmless if the build continues. |
| Build succeeds but `/health` fails | Set runtime `DATABASE_URL`, run `CREATE EXTENSION vector`, check HubSpot/Claude keys. |

## Manual one-off runs

```bash
CRON_JOB=dailyScrape tsx src/scripts/runCron.ts
CRON_JOB=checkCostCaps tsx src/scripts/runCron.ts
```

Enabled job names: see `CRON_JOBS` in `src/shared/cronSchedule.ts`.
