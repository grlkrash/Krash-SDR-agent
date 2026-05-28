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

Settings → **Health check** → Path: `/health/live` (deploy liveness only; use `/health` for full Postgres + HubSpot + Claude checks)

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

On **both** `ssa-web` and `ssa-cron` → **Variables** → add `DATABASE_URL`.

**Recommended — single picker reference (do not type by hand):**

1. Delete any existing `DATABASE_URL` row.
2. Add variable → use the **reference picker** (chip icon) → select your Postgres box → `DATABASE_URL`.
3. Railway inserts `${{<exact-canvas-name>.DATABASE_URL}}` for you.

Do **not** paste a hand-built composite like `postgresql://${{Postgres.PGUSER}}:…` — if the service name is wrong by even one character, every ref resolves to `""` and the value becomes `postgresql://:@:/` (17 chars).

**Alternative — five separate picker refs** (if single `DATABASE_URL` keeps going stale):

```text
PGHOST=${{<name>.PGHOST}}
PGPORT=${{<name>.PGPORT}}
PGUSER=${{<name>.PGUSER}}
PGPASSWORD=${{<name>.PGPASSWORD}}
PGDATABASE=${{<name>.PGDATABASE}}
```

Startup builds the connection string from these when `DATABASE_URL` is missing or invalid.

**Emergency** — Postgres service → Variables → reveal `DATABASE_URL` → copy the full string → paste into web/cron `DATABASE_URL`. Re-pick via picker after the next Postgres reconnect.

### `DATABASE_URL` goes empty on every redeploy

Symptom: you re-pick `${{Postgres.DATABASE_URL}}`, deploy works once, next deploy fails with `ECONNREFUSED` or `DATABASE_URL is missing or empty` in logs.

Cause: the reference still points at a **deleted or renamed** Postgres service from an old “reconnect”. Railway resolves it to `""`.

Fix:

1. Note the **exact** Postgres service name on the canvas today.
2. On **ssa-web** and **ssa-cron**, **delete** the `DATABASE_URL` row entirely.
3. Re-add using **Option A** above (composite) or re-pick Option B from the **current** Postgres service.
4. Redeploy **ssa-web** first; check Deploy logs for `[ssa-web] DATABASE_URL present (host=postgres.railway.internal, …)`.
5. Redeploy **ssa-cron**.

Startup runs `validateEnv.js` then `waitForDatabase.js` on both services before Prisma touches the DB.

### Private vs public Postgres URL — pick the private one

Railway's Postgres plugin exposes two connection strings. **Always reference `DATABASE_URL`, never `DATABASE_PUBLIC_URL`** from Railway-hosted services:

| Variable on Postgres | Hostname | Use from Railway | Egress fees |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgres.railway.internal` (IPv6) | ✅ ssa-web, ssa-cron | free |
| `DATABASE_PUBLIC_URL` | `*.proxy.rlwy.net` (TCP proxy) | ❌ never from Railway | yes |

If you see Railway warn _"DATABASE_PUBLIC_URL references a public endpoint…"_, you picked the wrong one from the variable picker — change it to `${{Postgres.DATABASE_URL}}` and redeploy.

`DATABASE_PUBLIC_URL` is only useful from **outside** Railway (your laptop, CI). Local `.env` can use it, or just use `railway connect postgres` / `railway run`.

### Service-to-service references

Three lines in the Railway canvas, all for variable references (not network calls):

| From | To | Variable | Why |
| --- | --- | --- | --- |
| `ssa-web` | `Postgres` | `DATABASE_URL = ${{Postgres.DATABASE_URL}}` | Prisma reads |
| `ssa-cron` | `Postgres` | `DATABASE_URL = ${{Postgres.DATABASE_URL}}` | Prisma reads |
| `ssa-cron` | `ssa-web` | `PUBLIC_URL = https://${{ssa-web.RAILWAY_PUBLIC_DOMAIN}}` | unsubscribe links + daily brief |

`ssa-web` does **not** reference `ssa-cron` — web never reads from cron. The Postgres service has no references out; it only receives.

Project-level **Shared Variables** work too — attach them to `ssa-web` and `ssa-cron` only. **Do not attach shared vars to the Postgres service** — it ignores app secrets.

Other secrets (copy from `.env.example`):

```
DATABASE_URL          ← ${{Postgres.DATABASE_URL}}                    (REQUIRED, private — see above)
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
PUBLIC_URL            ← https://${{ssa-web.RAILWAY_PUBLIC_DOMAIN}}    (set on ssa-cron; ssa-web can hardcode or omit)
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

### Twilio (voicemail drops)

ElevenLabs renders the MP3; **Twilio places the call and plays it**. No ElevenLabs config in Twilio — only env vars on Railway/local.

**Twilio Console checklist:**

1. **Buy a number** — Phone Numbers → Manage → Buy a number. Must include **Voice**. This becomes `TWILIO_FROM_NUMBER` in E.164 (`+1XXXXXXXXXX`).
2. **Copy credentials** — Account → API keys & tokens → `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`.
3. **Enable US outbound** — Voice → Settings → **Geo permissions** → allow **United States** (and Canada if needed).
4. **Do not set a Voice webhook on the number.** Outbound calls pass `url` and `statusCallback` per call in code. Leaving the number's Voice URL blank is correct.
5. **Trial account?** Verify any test destination numbers under Phone Numbers → Verified Caller IDs, or upgrade to paid.
6. **Lookups Line Type Intelligence** — used automatically by `isLandline()` ($0.008/lookup). No separate console toggle; requires a paid account with Lookups enabled.

**Railway env (web + cron services):**

| Variable | Value |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | From Twilio console |
| `TWILIO_AUTH_TOKEN` | From Twilio console |
| `TWILIO_FROM_NUMBER` | Your Twilio number, E.164 |
| `PUBLIC_URL` | `https://${{ssa-web.RAILWAY_PUBLIC_DOMAIN}}` — **required on cron too** so Twilio can fetch `/webhook/twilio/*` and `/audio/:draftId` |
| `ELEVENLABS_API_KEY` | From ElevenLabs |
| `ELEVENLABS_VOICE_ID` | `5cYnUBT6ZigM7aonjr3y` (cloned voice) |
| `SONIA_PHONE` | Your cell E.164 — live bridge target |
| `BRIEF_RECIPIENT` | Email for prep briefs on human pickup |

**Smoke test after deploy:**

```bash
curl https://YOUR_PUBLIC_URL/health
```

Then: approve one voicemail draft in `/queue` → `sendApproved` fires within 10 min → vm-1 dials only in the lead's **local after-hours window** (Mon–Fri before 9 AM or after 6 PM, or anytime weekends). Check `AuditLog` for `sender.voicemail-dropped` or `sender.voicemail-deferred-send-window`.

Human pickup on vm-1 or vm-2 → prep brief email + call bridges to `SONIA_PHONE`.

## 7. Cost cap alerts

`checkCostCaps` runs daily at **5:30 PM Eastern** via the cron tick. It emails `BRIEF_RECIPIENT` when Claude, Serper, Voyage, or Places approach 80%/100% of PRD §16 caps. No extra Railway cost — one more job inside the existing 5-min tick.

## 8. Infra cost vs Render

PRD §16 budgets **~$12/mo** for Railway web + Postgres + cron tick (Hobby + small Postgres). Actual usage varies; watch the Railway usage dashboard. API caps unchanged (~$299/mo total).

## Jobs not wired yet

None — all cron jobs in `src/shared/cronSchedule.ts` are enabled unless you flip `enabled: false` locally.

## Build troubleshooting

| Error | Fix |
| --- | --- |
| `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL` | Pull latest `main` — `prisma.config.ts` no longer requires a real URL at build time. Redeploy. |
| `P1001` / `127.0.0.1:5432` / database `"build"` | **`DATABASE_URL` not set on the web service.** Add `${{Postgres.DATABASE_URL}}` → redeploy. |
| `UndefinedVar: $NIXPACKS_PATH` | Railway/Nixpacks lint warning in generated Dockerfile — usually harmless if the build continues. |
| Build succeeds but `/health` fails | Set runtime `DATABASE_URL`, run `CREATE EXTENSION vector`, check HubSpot/Claude keys. |
| `EBADENGINE` / `Prisma only supports Node.js 20.19+, 22.12+, 24.0+` | Nixpacks picked an old 20.x patch. We pin `nodejs_22` via `nixpacks.toml`. If a build still picks 20.x, set `NIXPACKS_NODE_VERSION=22` in the service Variables tab. |
| `ECONNREFUSED` on `auditLog` / cron | `DATABASE_URL` empty at runtime — use composite URL (§4), redeploy web + cron. |
| `DATABASE_URL is missing or empty` in Deploy logs | Same — stale `${{Postgres.*}}` reference; delete and re-add on **both** services. |
| `DATABASE_URL` empty after redeploy / reconnect Postgres | Delete the variable on **ssa-web** and **ssa-cron**, re-add via picker: `${{Postgres.DATABASE_URL}}`. Stale service references often resolve to `""`. Check **Deploy** logs for `[ssa-web] FATAL: DATABASE_URL is missing or empty`. |
| Healthcheck fails but Deploy logs show `listening on http://0.0.0.0:…` | Ensure health path is `/health/live` (not `/health`). Full `/health` can exceed the probe window when HubSpot/Claude are slow. |

## Manual one-off runs

```bash
CRON_JOB=dailyScrape tsx src/scripts/runCron.ts
CRON_JOB=checkCostCaps tsx src/scripts/runCron.ts
```

Enabled job names: see `CRON_JOBS` in `src/shared/cronSchedule.ts`.
