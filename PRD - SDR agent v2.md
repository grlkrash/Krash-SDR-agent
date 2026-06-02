# PRD — Sobriety Select SDR Agent (SSA)

**Version:** 1.8
**Owner:** Sonia Gibbs (Independent Contractor, Sobriety Select)
**Engagement Start:** May 27, 2026
**Last Updated:** June 1, 2026

**Changes from v1.7 (June 1, 2026):**

- **Voicemail paused (operational state, §9.9).** `dropVoicemails` and `runSecondCalls` are **disabled** in `cronSchedule.ts` until counsel re-approves `VM_AI_AUTO_SEND`. Code is preserved; re-enable by setting `enabled: true` on both jobs. While paused, sent **reactivations** route to a **manual call lane** (§9.10) instead of AI vm drops.
- **Cold-call cadence (§9.6).** After a cold email sends to a lead with `phoneE164`, SSA opens a **3-touch human call sequence** on business days **2, 5, and 9** (`flagColdForCall` → `coldCallFollowups` 8:10 AM ET). Operator queue at **`/cold-call`** with one-click disposition (Connected / No answer / Done); each touch logs a HubSpot call engagement. Sequence retires on reply, meeting booked, or BD-9 window expiry.
- **Reactivation call lane (§9.10).** Single HubSpot call task **1 business day** after a sent reactivation email; **14-day window**; surfaces in daily brief **"Reactivations to call"** (no dedicated web queue — HubSpot task is system of record).
- **Meeting attribution + book rate (§9.5, §9.6).** Daily `attributeMeetings` (4:45 PM ET) credits HubSpot meetings to the most recent outbound draft (`AuditLog 'meeting.booked'`). Engagement dashboard adds **avg book rate**, per-bucket **Book** column, and **Booked — meeting on calendar** temperature badge. Reply rate alone under-counts conversion — many prospects book via calendar link without replying.
- **Call disposition sync (§9.5).** Daily `syncCallDispositions` (4:50 PM ET) pulls outbound HubSpot call engagements into `AuditLog 'hubspot.call-synced'`. Dashboard shows **cold connect rate** (app-logged `/cold-call` dispositions) and **HubSpot connect rate** (account-wide superset, includes calls logged directly in HubSpot).
- **Engagement time filters (§9.5).** Dashboard, temperature badges, and JSON API honor `?period=7d|30d|60d|90d|all` (default `all`). Smoke-test leads (`SMOKE_TEST_LEAD_ID`, `SMOKE ` name prefix, `sourceMeta.smokeLane`) are **excluded** from engagement stats and production call queues.
- **Directory exclusions (§9.2).** Daily `syncDirectoryExclusions` (6:15 AM ET) flags verified partner listings (`subscriptionType` = `subscribe` or `ads`) as `directory-listed` — cold excluded, not `doNotContact`. Manual CSV import via `data/exclusions/` for directory + paying-client lists.
- **Cold email quality gates (§9.4).** Deterministic post-generation checks in `coldEmailQuality.ts`: body 120+ words, SS-identity markers, **free-listing guardrails** (no outcome guarantees, no catastrophized invisibility claims), subject ≤6 words / ≤50 chars with prospect token, banned spam patterns. Failed checks trigger one personalization retry; still failing → skip + `AuditLog`.
- **Free-listing cold angle (§9.4, §9.11).** Cold emails lead with offering to claim Sobriety Select's **free basic directory profile** (tier-gated copy in `coldEmail.ts`). Prep brief adds **"Free listing → premium pivot"** section when `freeListingOffered=true`.
- **Meeting follow-ups (§9.8).** Passed booked meetings surface in daily brief for operator-decided recap (held) or reschedule (no-show); `src/prompts/reschedule.ts` drafts the nudge.
- **HTML email rendering.** Outbound sends and brief emails render markdown bodies as HTML (`markdownHtml.ts` + `emailHtml.ts`) — no raw `**bold**` in Gmail.

**Changes from v1.6 (May 29, 2026):**

- **Engagement dashboard on `/queue` (§9.5).** Aggregate **open rate** and **reply rate** (all-time) displayed at the top of the approval queue, with an expandable breakdown by email type (cold, follow-up 1–4, nudge, reactivation, renewal, etc.). Per-lead **temperature badges** (Hot / Warm / Cool / Cold) on draft cards and awaiting-reply rows link to a lead-level engagement detail page with send history and a suggested approach hint. JSON API at `GET /queue/engagement-stats` for programmatic access. Reply rate from `AuditLog 'reply.draft-created'`; **open rate from first-party tracking pixels** (`AuditLog 'email.opened'`, v1.7.1). Stats cached 5 minutes in-process.

**Changes from v1.5 (May 29, 2026):**

- **Renewal vs reactivation post-sale split (§9.9, §9.10).** **Renewals** (`kind='renewal'`) are **live-call only** — no AI voicemail. When a renewal email sends, SSA flags the lead for Sonia: HubSpot tasks (touch 1 due **3 business days** after send), up to **5 call touches on BD 3–7**, `/renewals-call` operator queue, compact section on `/queue`, and a **5 PM brief** section. **`renewalCallFollowups`** (8:00 AM ET) creates due touch tasks and expires sequences after BD 7. **Reactivations** (`kind='reactivation'`) remain email + optional **consent-gated machine-only AI vm** (see below). Cold-prospect vm is off.
- **Consent-gated reactivation VM (§9.9).** `dropVoicemails` triggers only after a **sent reactivation** email and `Lead.priorWrittenConsent=true` (PEWC click-through on `/consent-phone` appended to renewal/reactivation emails). Twilio AMD: **machine → play MP3** with deterministic artificial-voice disclosures; **human → honest Twilio `<Say>` disclosure then live bridge to Sonia** (prep brief email + whisper; no conversational AI agent). Auto-send requires `VM_AI_AUTO_SEND=true` on web + cron; reactivation vm drafts auto-approve when that flag is set. Operator smoke test: `SMOKE_TEST_LEAD_ID` bypasses landline at draft + send time; `seedSmokeTestPostSaleQueue.ts` seeds queue fixtures.
- **Approval queue triage (§9.5).** `/queue` gains a top **triage strip** (counts + deep links), **lane filters** on pending (All / Post-sale / Sequence / Replies / Voicemail), **phone line** on post-sale cards, and a **Renewals to call** preview linking to `/renewals-call`. `/manual-vm-queue` unchanged for state-law restricted leads.
- **Inbound compliance (§12).** STOP/unsubscribe replies auto-suppress; inbound Twilio calls forward to `SONIA_PHONE`.

**Changes from v1.4 (May 28, 2026):**

- **Vm-1 after-hours send window (§9.9).** Approved vm-1 drafts dial only outside local Mon–Fri 9 AM–6 PM or anytime weekends (`isVm1SendWindowOpen`). `sendApproved` retries every 10 min until the window opens.
- **Vm-1 human pickup bridges to Sonia (§9.9).** Same live-bridge path as vm-2: prep brief email + whisper; Sonia handles gatekeepers manually. No conversational AI agent.

**Changes from v1.3 (May 28, 2026):**

- **Voicemail drops clarified (§9.9).** Outbound calls use Twilio AMD (`DetectMessageEnd`) — the phone **rings** like a normal call; pre-rendered ElevenLabs MP3 plays only when a machine is detected. This is **not** ringless voicemail (carrier-side silent injection). Documented vm-1 vs vm-2 behavior, gatekeeper/receptionist handling, and explicit non-goal for automated gatekeeper navigation.
- **ElevenLabs model locked to `eleven_multilingual_v2`** for cloned-voice voicemail renders (quality over Turbo latency/cost).

**Changes from v1.2 (May 28, 2026):**

- **Contract term + auto renewal date.** HubSpot Deal property `ss_contract_term_months` (3, 6, or 12). Daily `syncDealRenewalDates` (9:45 AM ET) defaults missing term to **12** (no paid HubSpot workflows), then sets `ss_renewal_date = closedate + term`. Operator: only set term manually for 3- or 6-month deals; on renewal, bump **Close Date** to the new contract start. Guide: `data/hubspot/RENEWAL_OPERATOR.md`.

**Changes from v1.2:**

- **Deployment on Railway.** One web service + one Postgres plugin + one cron service (`cronTick` every 5 min UTC, dispatches PRD §9.1 jobs in Eastern time). See `RAILWAY.md` and `railway.toml`. Cheaper than 16 separate cron services.
- **`refreshIntentSignals` implemented (§9.12).** Monday 4 AM ET cron refreshes Places ratings + hiring signals on top open deals; hiring flips audit `intent.hiring-spike` for the daily brief.

**Changes from v1.2 (continued):**

- **`syncToHubspot` on daily cron (5:45 AM ET).** Runs after `enrichAll` so new enrichments mirror to HubSpot before scoring and drafting.
- **`draftFollowups` implemented (7:00 AM ET).** Batch `draftNudge` for 10+ day silence leads; defers to `runSequences` when an auto touch is due.

**Changes from v1.1:**

- Added three high-value enrichment signals: competing-directory presence (Psychology Today, Rehabs.com, Recovery.com), LinkedIn hiring activity, and marketing tech stack detection (HubSpot/Salesforce/CallRail tags found in HTML)
- Added **discovery call prep brief generator** to V1 — the 5-minute pre-call document that turns Sonia into a psychic on every call
- Added `.cursorrules` and `CURSOR GUIDE - SDR agent v2.md` as committed repo artifacts so Cursor builds correctly the first time
- Schema: enrichment signals live inside `Enrichment.painPoints` JSON; PRD §9.7 reply-detection adds two additive nullable columns on `Draft` (`inboundGmailMessageId @unique`, `hubspotInboundEmailId`) — additive migration, no data loss
- **Reply detection (§9.7) hardened.** Race-safe dedup via a UNIQUE index on `Draft.inboundGmailMessageId` (the Gmail id of the inbound that triggered a `kind='replied'` draft), plus a HubSpot `INCOMING_EMAIL` engagement is upserted to the contact + company timeline on every matched reply (idempotency tracked on `Draft.hubspotInboundEmailId`). The 5 PM daily brief gains a `📬 New replies` section pinning inbound replies from the last 24h at the top of Sonia's triage list.

-----

## 1. Mission

Build a single Node.js/TypeScript service that automates 80% of the SDR workflow for Sobriety Select — lead sourcing, enrichment, drafting outbound emails, follow-up sequencing, pipeline scoring, voicemail drops, and post-sale account management — so Sonia spends her hours where she has unfair advantage: **live discovery calls and closing**.

**North-star metric:** Net Revenue generated from new client sales + renewals/upsells per hour worked, measured monthly.

**Anti-goal:** Activity-volume vanity metrics. We do not optimize for emails sent or calls made.

-----

## 2. Operating Principle

> **AI drafts everything. Human approves everything that touches a relationship.**

1. Automated jobs run on cron (scrape, enrich, score, draft).
1. Sonia opens `/queue` once or twice a day.
1. Sonia reviews batches of 10–20 items in 60-second decisions: **send / edit / kill**.
1. Approved items go out. Killed items train the prompt.

No AI ever sends an email or makes a phone call without Sonia’s explicit approval, with these **exceptions**:

1. Automated no-reply follow-up touches 2–5 in a pre-approved sequence.
2. **Reactivation AI voicemail** — only when `VM_AI_AUTO_SEND=true` (counsel-approved), `Lead.priorWrittenConsent=true`, a sent **reactivation** email exists, and Twilio AMD detects a **machine** (human answers get an honest automated disclosure + live bridge to Sonia, not a conversational AI agent).

**Operational note (v1.8):** AI voicemail is **currently paused** — `dropVoicemails` and `runSecondCalls` are disabled in cron. Reactivations and cold prospects route to **manual live-call lanes** instead (§9.6, §9.10). Re-enable by flipping both jobs to `enabled: true` after counsel sign-off.

-----

## 3. Automation Map (Locked)

|Function                             |Automation                       |Rationale                   |
|-------------------------------------|---------------------------------|----------------------------|
|Scraping + list building             |100%                             |Pure grunt work             |
|Lead enrichment                      |100%                             |Pattern-matching task       |
|CRM population                       |100%                             |Data entry                  |
|Deal stage progression               |0% (manual in HubSpot)           |Forecast integrity          |
|Cold email drafting                  |100% (Sonia approves)            |Volume + personalization    |
|Cold email sending after approval    |100%                             |Throughput                  |
|Cold-call cadence (3 touches, BD 2/5/9)|100% flag + HubSpot tasks      |Pairs email with live calls |
|No-reply follow-ups (touches 2–5)    |100%                             |Low risk, high cadence      |
|Replied / booked / no-show follow-ups|AI drafts, Sonia sends           |Relationship signal         |
|Lost-deal nurture                    |100%                             |Long horizon, low risk      |
|Cold deal reactivation flagging      |100% flag, AI drafts, Sonia sends|Salvage                     |
|Reactivation manual call (vm paused) |100% flag + HubSpot task         |Live call — replaces AI vm  |
|Reactivation AI vm (machine-only)    |**PAUSED** — re-enable w/ counsel|Post-consent salvage touch  |
|Daily pipeline scoring + brief       |100%                             |Morning briefing            |
|**Discovery calls**                  |**0%**                           |**Sonia’s competitive moat**|
|**Discovery call prep brief**        |**100% (generated on demand)**   |**5-min pre-call read**     |
|Proposals                            |AI drafts, Sonia finalizes       |Stakes too high             |
|Live objection email responses       |0%                               |Relationship                |
|Closed-won onboarding                |100% drafted, Sonia approves     |Set tone                    |
|Quarterly client check-ins           |100% drafted, Sonia approves     |Renewal pipeline            |
|Renewal early-warning email          |100% flag, AI drafts, Sonia sends|Money on the table          |
|**Renewal live-call cadence**        |**100% flag + HubSpot tasks**    |**Live calls — no AI vm**   |
|Upsell trigger detection             |100% flag, Sonia decides         |Strategic                   |
|Post-sale FAQ replies                |100% drafted, Sonia approves     |Time saved                  |

-----

## 4. Product Catalog & Pricing (Locked from May 8 proposal)

|Product                      |Avg Value  |Sonia’s Commission|Per-sale Commission|Target Buyer                         |
|-----------------------------|-----------|------------------|-------------------|-------------------------------------|
|Claimed Listing              |$600       |10%               |$60                |Solo / single-location               |
|Select Listing               |$2,400     |10%               |$240               |Small operators, sober living, IOP   |
|Premium Listing              |$9,600     |10%               |$960               |Multi-location, large residential    |
|SEO Programs                 |$18,000    |5%                |$900               |Mid-size with existing site          |
|Social Media Management      |$12,000    |5%                |$600               |Family/employer referral targeters   |
|Advertising / PPC            |$18,000    |5%                |$900               |LegitScript-certified, ready to scale|
|Renewals & Upsells (existing)|$25,000 avg|5%                |$1,250             |Existing clients                     |

**System implications:**

- Targeting splits by product fit via `expectedProduct` on Enrichment
- Pipeline scoring weights by expected commission (Premium prospect = 16× Claimed)
- KB co-pilot answers pricing from these numbers
- Proposal drafts use these prices verbatim

-----

## 5. System Architecture

**One service. One database. No queues. No Redis. No WebSockets. No Docker Compose locally.**

```
┌────────────────────────────────────────────────────────────────┐
│              Sobriety Select SDR Agent (Node.js)               │
│                                                                │
│   Cron tick (Railway, 5 min)     Express API                  │
│   - scrape  - enrich              /queue   /copilot/ask       │
│   - draft   - score               /approve /webhook/...       │
│   - send    - follow-up           /health  /prep-brief        │
│   - meetings - call sync          /cold-call /renewals-call   │
│                                                                │
│   ┌──────────────────────────────────────────────────────┐    │
│   │  Service Layer — TWO LOGICAL DOMAINS                 │    │
│   │  ┌────────────────┐  ┌────────────┐                  │    │
│   │  │ pipeline/      │  │ outreach/  │                  │    │
│   │  │ (data plumbing)│  │ (relations)│                  │    │
│   │  └────────────────┘  └────────────┘                  │    │
│   │  ┌────────────────┐  ┌────────────┐                  │    │
│   │  │ shared/        │  │ ui/        │                  │    │
│   │  └────────────────┘  └────────────┘                  │    │
│   └──────────────────────────────────────────────────────┘    │
└───────────────────────┬────────────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┬──────────────┐
        ▼               ▼               ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │Postgres │   │ HubSpot  │   │  Claude  │   │ Twilio + │
   │+pgvector│   │   Free   │   │   API    │   │ElevenLabs│
   └─────────┘   └──────────┘   └──────────┘   └──────────┘
        │
        ▼
   ┌─────────────────────────────────────────┐
   │ FindTreatment.gov  |  Google Places API │
   │ Serper (LinkedIn + directory checks)   │
   └─────────────────────────────────────────┘
```

-----

## 6. Tech Stack (Locked)

|Layer     |Choice                                           |
|----------|-------------------------------------------------|
|Runtime   |Node.js 20.x LTS                                 |
|Language  |TypeScript 5.x (strict)                          |
|Framework |Express 4.x                                      |
|ORM       |Prisma 5.x                                       |
|Database  |PostgreSQL 15+ with pgvector                     |
|AI        |Anthropic Claude (`claude-sonnet-4-5-20250929`)  |
|Embeddings|Voyage AI (`voyage-3`, 1024-dim)                 |
|Scraping  |Playwright + Cheerio                             |
|CRM       |HubSpot Free + `@hubspot/api-client` (auth via Service Key — token in `HUBSPOT_ACCESS_TOKEN`, identical bearer-header transport as a private app; scopes managed on the Service Key in HubSpot UI)|
|Email send|Gmail API via OAuth2 (`sonia@sobrietyselect.com`)|
|Voice     |Twilio AMD voicemail drop + ElevenLabs TTS (`eleven_multilingual_v2` default; override via `ELEVENLABS_MODEL_ID`) |
|Email body|Markdown source → HTML at send time (`markdownHtml.ts`, `emailHtml.ts`) |
|Hosting   |Railway (web + cron + Postgres)                  |

**Explicitly excluded:** Redis, WebSockets, OpenAI, Docker Compose, BullMQ, Turborepo, custom React UI, Salesforce, microservices.

-----

## 7. Folder Structure

```
sobriety-select-sdr/
├── .cursorrules                 # Cursor reads automatically
├── CURSOR GUIDE - SDR agent v2.md
├── PRD - SDR agent v2.md
├── INSTRUCTIONS- SDR agent v2.md
├── CHECKLIST.md
├── README.md
├── RAILWAY.md
├── railway.toml
├── data/
│   └── exclusions/              # directory + client CSV imports (see data/exclusions/README.md)
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/
│   └── schema.prisma
├── kb/
│   ├── product/
│   ├── objections/
│   ├── competitors/
│   ├── compliance/
│   └── industry/
├── src/
│   ├── pipeline/                # Data plumbing domain
│   │   ├── sources/
│   │   │   ├── samhsa.ts
│   │   │   ├── places.ts
│   │   │   └── psychtoday.ts
│   │   ├── enrich.ts
│   │   ├── signals.ts           # NEW: directory check, hiring, tech stack
│   │   ├── hubspotSync.ts
│   │   ├── syncDealRenewalDates.ts  # closedate + term → ss_renewal_date
│   │   ├── exclusions/          # directory API sync + CSV import
│   │   └── scoring.ts
│   ├── outreach/                # Relationship domain
│   │   ├── draftCold.ts
│   │   ├── coldEmailQuality.ts  # v1.8: subject + body quality gates
│   │   ├── coldCallFlag.ts      # v1.8: 3-touch cold-call cadence
│   │   ├── reactivationCallFlag.ts  # v1.8: manual reactivation calls (vm paused)
│   │   ├── meetingAttribution.ts    # v1.8: credit meetings to sourcing draft
│   │   ├── meetingFollowup.ts       # v1.8: passed-meeting recap/reschedule surfacing
│   │   ├── callDispositionSync.ts   # v1.8: HubSpot call sync for dashboard
│   │   ├── sequencer.ts
│   │   ├── replyWatcher.ts
│   │   ├── quarterlyCheckin.ts
│   │   ├── renewalWarning.ts
│   │   ├── renewalCallFlag.ts   # v1.6: renewal live-call cadence + HubSpot tasks
│   │   ├── reactivation.ts
│   │   ├── voicemail.ts
│   │   ├── prepBrief.ts         # NEW: discovery call prep
│   │   ├── dailyBrief.ts
│   │   ├── emailEngagementStats.ts  # v1.7+: open/reply/book rates + call stats
│   │   └── sender.ts
│   ├── shared/
│   │   ├── coldCallTouches.ts   # v1.8: BD 2/5/9 touch math
│   │   ├── exclusion.ts         # v1.8: directory-listed / existing-client cold skip
│   │   ├── emailHtml.ts         # v1.8: HTML email rendering
│   │   ├── markdownHtml.ts      # v1.8: markdown → HTML for sends + briefs
│   │   ├── logHubspotCall.ts    # v1.8: outbound call engagement writer
│   │   ├── renewalCallTouches.ts
│   │   ├── hubspotTask.ts
│   │   ├── smokeTestLead.ts
│   │   ├── voicemailCompliance.ts
│   │   ├── lead.ts
│   │   ├── claude.ts
│   │   ├── hubspot.ts
│   │   ├── gmail.ts
│   │   ├── voyage.ts
│   │   ├── twilio.ts
│   │   ├── eleven.ts
│   │   ├── serpapi.ts
│   │   ├── fetchSite.ts
│   │   ├── businessDays.ts
│   │   ├── guessEmail.ts
│   │   ├── dealRenewal.ts           # contract term + renewal date math
│   │   └── unsubscribeToken.ts
│   ├── prompts/
│   │   ├── coldEmail.ts
│   │   ├── reschedule.ts        # v1.8: no-show / re-book nudge
│   │   ├── websiteAnalyzer.ts
│   │   ├── followUpTemplates.ts
│   │   ├── replied.ts
│   │   ├── quarterlyCheckin.ts
│   │   ├── renewalWarning.ts
│   │   ├── reactivation.ts
│   │   ├── voicemailScript.ts
│   │   ├── prepBrief.ts         # NEW
│   │   ├── copilot.ts
│   │   └── dailyBrief.ts
│   ├── ui/
│   │   ├── queue.ts
│   │   ├── engagementDashboard.ts   # v1.7+: engagement panel + lead detail HTML
│   │   ├── renewalsCall.ts      # v1.6: /renewals-call live renewal queue
│   │   ├── coldCall.ts          # v1.8: /cold-call disposition queue
│   │   ├── manualVmQueue.ts
│   │   ├── copilot.ts
│   │   └── prepBrief.ts         # NEW: /prep-brief/:dealId route
│   ├── routes/
│   │   ├── unsubscribe.ts
│   │   ├── phoneConsent.ts      # v1.6: GET /consent-phone PEWC opt-in
│   │   └── twilioHooks.ts       # AMD twiml, inbound forward, audio serve
│   ├── middleware/
│   │   └── queueAuth.ts
│   ├── scripts/
│   └── server.ts
└── tests/prompts/
```

-----

## 8. Data Model (6 tables — additive v1.6 columns on Lead)

```prisma
model Lead {
  id                String   @id @default(cuid())
  source            String
  name              String
  nameNormalized    String
  street            String?
  city              String
  state             String
  zip               String?
  addressHash       String
  phoneE164         String?
  website           String?
  googleRating      Float?
  googleReviews     Int?
  services          String[]
  sourceMeta        Json
  hubspotCompanyId  String?
  doNotContact      Boolean  @default(false)
  priorWrittenConsent   Boolean   @default(false)  // v1.6: PEWC opt-in via /consent-phone
  priorWrittenConsentAt DateTime?
  enrichment        Enrichment?
  drafts            Draft[]
  createdAt         DateTime @default(now())
  @@unique([nameNormalized, addressHash])
  @@index([state, city])
}

model Enrichment {
  id                String   @id @default(cuid())
  leadId            String   @unique
  lead              Lead     @relation(fields: [leadId], references: [id])
  ownerName         String?
  ownerTitle        String?
  ownerEmail        String?
  ownerLinkedIn     String?
  teamSizeSignal    String?
  expectedProduct   String?
  painPoints        Json     // expanded — see §9.3
  signals           Json     // NEW container — see §9.3
  legitscriptStatus String?
  evidenceQuote     String?
  enrichedAt        DateTime @default(now())
}

model Draft {
  id                     String    @id @default(cuid())
  leadId                 String
  lead                   Lead      @relation(fields: [leadId], references: [id])
  kind                   String    // 'cold' | 'followup-2/3/4/5' | 'replied' | 'noshow' | 'quarterly' | 'renewal' | 'upsell' | 'reactivation' | 'voicemail' | 'prep-brief'
  subject                String?
  body                   String
  audioMp3               Bytes?
  personalizationPct     Int?
  specificFacts          String[]
  status                 String
  rejectReason           String?
  approvedBy             String?
  sentAt                 DateTime?
  gmailMessageId         String?   // outbound RFC-822 Message-ID we generated in sendEmail
  inboundGmailMessageId  String?   @unique  // v1.2: race-safe dedup for kind='replied' — Gmail id of the inbound that triggered this draft
  hubspotEmailId         String?   // outbound HubSpot Email engagement (EMAIL direction) created on send
  hubspotInboundEmailId  String?   // v1.2: HubSpot INCOMING_EMAIL engagement logged for the inbound reply (kind='replied' only)
  twilioCallSid          String?
  createdAt              DateTime  @default(now())
  @@index([status, createdAt])
  @@index([leadId, kind])
}

model Suppression { /* unchanged */ }
model Score { /* unchanged */ }
model KBChunk { /* unchanged */ }
model AuditLog { /* unchanged */ }
```

Note: `Enrichment.signals` is a new JSON field added to the existing model. This is an additive migration — no data loss.

-----

## 9. Core Workflows

### 9.1 Daily Cron Schedule

|Cron          |Time (ET)|Job                   |Domain  |Enabled|
|--------------|---------|----------------------|--------|-------|
|`0 5 * * *`   |5:00 AM  |`dailyScrape`         |pipeline|yes    |
|`30 5 * * *`  |5:30 AM  |`enrichAll`           |pipeline|yes    |
|`45 5 * * *`  |5:45 AM  |`syncToHubspot`       |pipeline|yes    |
|`0 6 * * *`   |6:00 AM  |`scorePipeline`       |pipeline|yes    |
|`15 6 * * *`  |6:15 AM  |`syncDirectoryExclusions`|pipeline|yes|
|`30 6 * * *`  |6:30 AM  |`draftColdBatch`      |outreach|yes    |
|`0 7 * * *`   |7:00 AM  |`draftFollowups`      |outreach|yes    |
|`15 7 * * *`  |7:15 AM  |`runSecondCalls`      |outreach|**no** (vm paused)|
|`30 7 * * *`  |7:30 AM  |`runSequences`        |outreach|yes    |
|`0 8 * * *`   |8:00 AM  |`renewalCallFollowups`|outreach|yes    |
|`0 8 * * *`   |8:00 AM  |`draftUpsellBatch`    |outreach|yes    |
|`10 8 * * *`  |8:10 AM  |`coldCallFollowups`   |outreach|yes    |
|`0 9 * * *`   |9:00 AM  |`quarterlyCheckins`   |outreach|yes    |
|`45 9 * * *`  |9:45 AM  |`syncDealRenewalDates`|pipeline|yes    |
|`0 10 * * *`  |10:00 AM |`renewalWarnings`     |outreach|yes    |
|`0 14 * * *`  |2:00 PM  |`dropVoicemails`      |outreach|**no** (vm paused)|
|`*/5 * * * *` |~5 min   |`checkReplies`        |outreach|yes    |
|`*/10 * * * *`|10 min   |`sendApproved`        |outreach|yes    |
|`45 16 * * *` |4:45 PM  |`attributeMeetings`   |outreach|yes    |
|`50 16 * * *` |4:50 PM  |`syncCallDispositions`|outreach|yes    |
|`0 17 * * *`  |5:00 PM  |`sendDailyBrief`      |outreach|yes    |
|`30 17 * * *` |5:30 PM  |`checkCostCaps`       |ops     |yes    |
|`0 3 * * 1`   |Mon 3am  |`reactivation`        |outreach|yes    |
|`0 4 * * 1`   |Mon 4am  |`refreshGoogleSignals`|pipeline|yes    |

Prep briefs are **generated on demand** via `GET /prep-brief/:dealId` — no cron needed. Sonia hits it 5 minutes before each call.

**Railway deployment:** One always-on web service plus one cron service on `*/5 * * * *` UTC running `cronTick.ts`, which dispatches PRD jobs by Eastern time. See `RAILWAY.md`. `draftFollowups` (7:00 AM ET) batch-drafts approval-gated `kind='nudge'` emails for leads in the awaiting-reply state (same rules as `/queue` §9.5); `runSequences` (7:30 AM) auto-sends template touches 2–5. **`dropVoicemails` and `runSecondCalls` are disabled** while AI voicemail is paused — reactivations flag for manual call (§9.10); cold prospects use the call cadence (§9.6). Re-enable both jobs after counsel approves `VM_AI_AUTO_SEND`.

### 9.2 Lead Sourcing (pipeline)

1. FindTreatment.gov scraper (paginated, 5 target states)
1. Google Places (New) Text Search (7 queries × major cities)
1. Psychology Today scraper (deferred to V1.5)
1. Dedupe + normalize → upsert Lead

**Success criteria:** ≥5,000 deduplicated leads in FL/CA/TX after week 1.

### 9.2.1 Directory & client exclusions (pipeline) — v1.8

Facilities already on Sobriety Select or already paying must not receive cold "join our directory" mail. Exclusion metadata lives in `Lead.sourceMeta` and/or `Enrichment.signals` (`excludeFromCold: true`, kind `directory-listed` or `existing-client`). This is **not** `doNotContact` — renewals/upsells still work for paying clients.

**Daily sync (`syncDirectoryExclusions`, 6:15 AM ET — before `draftColdBatch`):**

1. Calls Sobriety Select's public search API (`/api/medical-centers/search`)
1. Pulls verified partner listings (`subscriptionType` = `subscribe` or `ads`) — ~80–90 nationwide
1. Matches to `Lead` rows and flags `directory-listed`
1. Rejects pending/approved/paused **cold** drafts for matched leads

**Manual CSV import:** Drop files in `data/exclusions/incoming/{directory,client}/`, run `npm run exclusions:import -- --incoming`. See `data/exclusions/README.md`. Client imports also upsert `Suppression` when email/phone present.

**Defense in depth:** `draftColdBatch`, `sequencer`, and `sender` all call `isExcludedFromCold()` before touching a lead.

### 9.3 Enrichment Workflow (pipeline) — EXPANDED in v1.2

The enrichment pipeline now runs **five stages** per lead:

1. **Website fetch** (Playwright, 15s timeout)
1. **Claude website analysis** — extracts owner, team size, expected product tier, classic pain points (no schema, no reviews, weak SEO, stock photos, etc.)
1. **LinkedIn lookup** — Serper for owner profile
1. **NEW: Three intelligence signals (via Serper + HTML regex)**:
- **A. Competing-directory presence.** Serper queries:
  - `site:psychologytoday.com "{facility}" {city}`
  - `site:rehabs.com "{facility}" {city}`
  - `site:recovery.com "{facility}" {city}`
    Output: `signals.competingDirectories: { psychologyToday: bool, rehabsCom: bool, recoveryCom: bool, missingFromAll: bool }`. The “missingFromAll” flag is the FOMO hook.
- **B. LinkedIn hiring activity.** Serper query: `site:linkedin.com/jobs "{facility}"`. Parse top 5 results for role titles. Output: `signals.hiring: { active: bool, roleTitles: string[], rolesPostedRecently: number }`. The active=true flag is the budget/expansion hook.
- **C. Marketing tech stack.** Regex scan of fetched HTML for known tracking signatures:
  - HubSpot: `js.hs-scripts.com`, `js.hsforms.net`, `js.hsanalytics.net`
  - Salesforce: `salesforceliveagent`, `pardot.com`, `force.com`
  - CallRail: `callrail.com`, `cdn.callrail.com`
  - Google Ads: `googleadservices.com/pagead/conversion`
  - Facebook Pixel: `connect.facebook.net/.*fbevents.js`
  - Marketo: `munchkin.marketo.net`
    Output: `signals.techStack: { hubspot: bool, salesforce: bool, callrail: bool, googleAds: bool, facebookPixel: bool, marketo: bool, bigSpenderScore: 0-5 }` (count of presence). Any score ≥2 is a “big spender” — prime target for Premium / SEO / PPC upsell.

**Tech-stack call-prep mirror (v1.2 addition).** `signals.techStack` round-trips into HubSpot as a single JSON blob (`ss_signals`), which is unreadable on a live call. `hubspotSync.ts` now also writes a sibling Company property `ss_tech_stack_summary` (single-line Text) populated by `buildTechStackSummary(enrichment.signals)` — a human-readable list of detected tools in stable display order with a count suffix, e.g. `"HubSpot, CallRail, Google Ads (3 tools)"`. Empty string when nothing is detected (matches the empty-string convention of other `ss_*` fields). The new property is provisioned by `setupHubspotCustomProperties.ts` and is idempotent on re-run. No schema change: the source of truth stays `Enrichment.signals.techStack` and `ss_signals`; this is a derived read-optimized field for the Company record view Sonia opens during discovery calls. (Per-tool boolean properties for HubSpot list segmentation are intentionally deferred — file under "add when first list-filter need shows up.")

1. **LegitScript check** + **expectedProduct inference**

The new signals influence `expectedProduct`:

- `signals.techStack.bigSpenderScore ≥ 3` → bias toward `premium` and the SEO/PPC upsells, regardless of size signal
- `signals.competingDirectories.missingFromAll` → strong angle for `claimed` or `select` (low-hanging fruit)
- `signals.hiring.active` → upgrade tier by one notch (a hiring center has budget the team-size signal undersells)

**Cost impact:** 3 additional Serper calls per lead × ~$0.001 each = ~$0.003 per lead. At 5,000 leads = ~$15 total over month 1.

### 9.4 Cold Email Drafting (outreach)

Tier-aware via `expectedProduct`. Now also receives the three new signals as personalization fuel. The evaluator scores personalization — referencing a hiring post or a missing-from-Psychology-Today fact dramatically boosts the score and the relevance.

**Free-listing angle (v1.8).** The primary cold hook is offering to claim Sobriety Select's **free basic directory profile** — a low-commitment "yes" that puts the center on the map where families search by region and insurance. Tier-gated copy in `coldEmail.ts`:

- **claimed/solo:** Lead with the free profile as the reason-to-talk.
- **select:** Open with local census observation, then offer free profile claim before the call.
- **premium / big spenders:** Lead with paid-search pressure; mention free profile as proof we already have them on the map.

Paid tiers belong on the **call**, never in the cold email. The word "free" stays **out of the subject line** (filter risk); it belongs in the body.

**Quality gates (v1.8, `coldEmailQuality.ts`).** After Claude generates body + subject, deterministic checks run before the draft is saved:

| Check | Rule |
| --- | --- |
| Body length | ≥120 words (target 130–165) |
| SS identity | ≥2 markers (Sobriety Select, map-forward, profiles, etc.) |
| Free-listing guardrails | No outcome guarantees ("fill your beds", "guaranteed leads"); no catastrophized invisibility ("nobody can find you", "invisible") |
| Subject words | ≤6 words, ≤50 chars |
| Subject token | Must include a facility-name token (≥4 chars) |
| Subject spam | No `!!`, ALL CAPS spam, banned words (`guaranteed`, `revolutionary`, etc.), no `?` or `!` |

Failed quality + low personalization → one retry with explicit fix instructions. Still failing → skip + `AuditLog 'draftCold.quality-failed'`.

Sales hooks unlocked:

- **Missing from competing directories:** “Noticed Hope Haven isn’t listed on Psychology Today or Rehabs.com — local family searches are routing entirely to your competitors.”
- **Active hiring:** “Saw you’re hiring two intake coordinators in Asheville — perfect timing to make sure the new census pipeline is full.”
- **Big spender stack:** “Since you’re already running CallRail + HubSpot, our directory’s referral tags will pipe straight into your existing tracking — zero new infrastructure.”

**Reject-feedback loop (v1.2 addition).** When `draftColdBatch` re-drafts a lead whose only prior cold drafts are `status='rejected'`, `draftCold.ts` looks up the most recent rejected draft's `rejectReason` and appends it as a single trailing paragraph to the user message (the cached system prompt is unchanged). Cap is 240 chars; empty/null reasons are skipped so the marginal token cost is zero when Sonia hits Reject without typing. Paused drafts are excluded — only `status='rejected'` rows count. Use of the feedback is logged via `AuditLog 'draftCold.reject-feedback-used'` with `{ previousDraftId, reasonChars }` so we can verify the loop is firing without storing the reason text twice.

**Reject-cap (v1.2 addition).** `MAX_REJECTS_PER_LEAD = 3`. Once a lead has accumulated 3 `status='rejected'` cold drafts, `draftCold.ts` skips draft generation entirely and writes `AuditLog 'draftCold.skipped-too-many-rejects'`. The model isn't going to crack the lead with more attempts; further drafts wait until the operator either kills the lead (see §9.5) or restores a rejected draft via `/undo`. This bounds Anthropic spend on un-draftable leads (otherwise a single broken lead would re-enter the batch every day forever).

**Leak guard (v1.2 addition).** After every `generate()` call (both first attempt and personalization-retry), the body is run through `src/outreach/leakScan.ts` against four regex patterns: dollar amounts (`/\$\s?\d/`), pricing words (`price|pricing|cost|costs|fee|fees|dollars?|USD`), per-year/month framings, and capitalized tier names (`Claimed|Select|Premium`). The facility name is passed as `ignoreSubstrings` so a center literally named "Premium Recovery" doesn't false-positive. Any hit → skip the draft, write `AuditLog 'draftCold.leak-detected'` with `{ attempt, hits }`. No automatic retry on a leak — a leak indicates a deeper failure of the COLD_EMAIL_SYSTEM rules and is worth surfacing rather than papering over. The same `scanLeaks(...)` helper is used by the `_tmpDraftOne.ts` and `_tmpDraftRejected.ts` dev scripts so production and dev share one source of truth for the pattern set.

**Do-not-contact respect.** `draftColdBatch` filters `doNotContact: false` in the candidate query, and `draftCold.ts` re-checks `lead.doNotContact` as defense in depth (logs `draftCold.do-not-contact` and returns null if true). This means once §9.5's Kill lead button flips the flag, no further drafts are generated regardless of suppression-table state.

### 9.5 Approval Queue (`/queue`)

Same as v1.1, plus:

- Each draft card shows a small “signals” line below the pain points: e.g., “🎯 Missing from PT + Rehabs.com · 📈 Hiring 2 intake roles · 💰 HubSpot+CallRail detected”
- This is the visual cue that lets Sonia eyeball “high-leverage” drafts and approve those first
- **Kill lead button (v1.2 addition).** Each pending, approved, and paused/rejected draft card carries a red `Kill lead` button next to Pause. Two-step confirm in the browser (consequences confirm + optional reason prompt), then `POST /kill-lead/:leadId` delegates to `src/outreach/killLead.ts`. That helper: (a) sets `Lead.doNotContact = true`, (b) `prisma.suppression.upsert` on the lead's known email + phone (composite-PK row, reason `kill-lead: <text>`), (c) `updateMany` flips all `pending|approved|paused` drafts for the lead to `rejected` with `rejectReason = 'Lead killed: <text>'`, (d) best-effort updates the HubSpot contact's native `hs_lead_status` to `UNQUALIFIED` (HubSpot's default enum has no `DO_NOT_CONTACT` value — confirmed against the 8 defaults: NEW, OPEN, IN_PROGRESS, OPEN_DEAL, UNQUALIFIED, ATTEMPTED_TO_CONTACT, CONNECTED, BAD_TIMING. If Sonia later adds a custom enum value to `hs_lead_status` in Settings > Data Management > Properties, swap the constant `HUBSPOT_LEAD_STATUS_UNQUALIFIED` in `killLead.ts` to match). HubSpot failures are non-fatal and surface as a separate `AuditLog 'killLead.hubspot-failed'`. The kill itself writes `AuditLog 'lead.killed'` with `{ reason, cancelledDrafts, suppressedEmail, suppressedPhone, hubspotContactId, hubspotError, killedBy }`. Idempotent — re-killing an already-killed lead is a no-op DB-side and a fresh `hs_lead_status` write on the HubSpot side.
- **HubSpot engagement on mark-sent (v1.2 addition).** When `/mark-sent/:id` fires, `src/outreach/logSentEmail.ts` logs an Email engagement against the HubSpot contact + company so the timeline reflects the send. Properties: `hs_timestamp` (sentAt epoch ms), `hs_email_direction = 'EMAIL'`, `hs_email_status = 'SENT'`, `hs_email_subject`, `hs_email_text` (capped at 60K chars). Associations are created via `hs.crm.associations.v4.basicApi.createDefault('emails', emailId, 'contacts'|'companies', ...)` so type IDs are resolved by HubSpot, not hard-coded. The returned engagement id is stored on `Draft.hubspotEmailId` for idempotency (a second mark-sent call returns the cached id without re-creating). Best-effort: internal try/catch in the helper means HubSpot failures never block the `/queue` redirect — they surface as `AuditLog 'hubspotEngagement.failed'` with the error message. Skip path: if no HubSpot contact exists by email AND no `hubspotCompanyId` is on the Lead, log `AuditLog 'hubspotEngagement.skipped-no-associations'` and don't create an orphan engagement. Success path logs `AuditLog 'hubspotEngagement.logged'` with `{ emailId, contactId, companyId }`. Same helper is the integration point when the Gmail-API send (PRD §9.6) replaces manual mark-sent.

**Triage hub (v1.6).** `/queue` opens with a **triage strip**: pending email count, renewals-to-call count (links to `/renewals-call`), manual-vm count (links to `/manual-vm-queue`), awaiting-reply count, and approved count. Pending drafts support **lane filters** via `?lane=`: `all` (default), `post-sale` (renewal / reactivation / quarterly / upsell), `sequence` (cold + followup-*), `replies` (replied / noshow), `vm` (voicemail drafts). Post-sale cards show a clickable **phone line** (`tel:`) when `phoneE164` is on file. A compact **Renewals to call** section (top 5 open sequences) appears when any renewal call cadence is active. Toolbar links: Sales co-pilot, Renewals to call, Manual VM queue.

**Engagement dashboard (v1.7, expanded v1.8).** Below the triage strip, `/queue` shows an **email engagement panel** scoped by time range (`?period=7d|30d|60d|90d|all`, default `all`). Range pills persist across lane filters and sort mode.

**Headline metrics:** **avg open rate**, **avg reply rate**, **avg book rate**, and **emails sent** (for the selected range, excluding voicemail kinds and smoke-test leads).

**Call performance row (v1.8):**

| Metric | Source |
| --- | --- |
| Cold connect rate | `AuditLog 'cold.call-touch'` from `/cold-call` dispositions |
| Cold calls logged / connected / prospects | Same |
| HubSpot connect rate | `AuditLog 'hubspot.call-synced'` — all outbound calls in account |
| All calls (HubSpot) | Superset — includes calls logged directly in HubSpot |

A collapsible **“Break down by email type”** table stratifies open, reply, and **book** rates by kind bucket:

| Bucket label | Draft `kind` values |
| --- | --- |
| Cold (touch 1) | `cold` |
| Follow-up 1–4 | `followup-2` … `followup-5` |
| Nudge | `nudge` |
| Reactivation | `reactivation` |
| Renewal | `renewal` |
| Quarterly / Upsell | `quarterly`, `upsell` |
| Reply response | `replied` (outbound response draft) |

Only buckets with at least one send appear in the table — the panel stays compact when a lane is unused.

**Rate inputs.**

- **Reply rate (reliable).** Numerator = distinct outbound sends that received an inbound reply, attributed via `AuditLog` rows where `action='reply.draft-created'` and `meta.matchedDraftId` points at the sent draft. Denominator = count of sent email drafts in that bucket. This reuses the same dedup boundary as §9.7 (`Draft.inboundGmailMessageId @unique` on the resulting `kind='replied'` draft).
- **Open rate (tracking pixel, v1.7.1).** Every email sent via `sendApproved` → `sender.ts` embeds a signed 1×1 pixel (`GET /track/open/:draftId?sig=…`) in the HTML part. The route returns a transparent GIF and writes `AuditLog 'email.opened'` once per draft (deduped). Signature uses `OPEN_TRACK_SECRET` (falls back to `UNSUBSCRIBE_SECRET`). Opens count toward the dashboard when the pixel loads — **not** a guaranteed read. Image-blocked clients under-report; Apple Mail Privacy Protection may inflate counts. Emails marked **Sent manually** from Gmail (`/mark-sent`) do not carry the pixel. Reply rate remains a primary actionable signal.
- **Book rate (v1.8).** Numerator = sends credited with sourcing a HubSpot meeting via `AuditLog 'meeting.booked'` (`attributeMeetings` cron attributes each meeting to the most recent outbound draft sent within 90 days). Denominator = sent drafts in bucket. Many prospects book via calendar link without replying — book rate captures conversion reply rate misses.

**Per-lead temperature.** Draft cards (pending + approved), and rows in the **💤 Sent — awaiting reply** section, show a clickable badge when the lead has prior sends:

| Badge | Rule | Operator hint |
| --- | --- | --- |
| **Booked — meeting on calendar** | HubSpot meeting attributed to this lead | Stop sequencing — prep brief + pivot from free listing to paid tier on the call |
| **Hot — replied** | At least one inbound reply recorded | Prioritize thoughtful reply or call; skip generic sequence templates |
| **Warm — opened** | Tracking pixel loaded, no reply yet | Shorter nudge with one clear ask, or a different pain-point angle |
| **Cool — awaiting signal** | 1–2 sends, no open/reply yet | Stay on sequence timing unless awaiting-reply window triggers nudge |
| **Cold — no engagement** | 3+ sends, no open or reply | Consider pausing sequence, nudge, or alternate channel |

Clicking a badge opens **`GET /queue/lead-engagement/:leadId`** — a server-rendered page listing every sent email for that lead (type, date, opened?, replied?, booked?) plus the suggested approach text. Honors the same `?period=` filter as the dashboard. Same auth cookie as `/queue` (`queueAuth`).

**Smoke-test exclusion (v1.8).** Leads matching `SMOKE_TEST_LEAD_ID`, name prefix `SMOKE `, or `sourceMeta.smokeLane` are excluded from engagement stats, cold-call queue, renewal/reactivation call queues, and meeting attribution display. Operator inbox validation only.

**JSON API (v1.7+, v1.8 range).** For scripts or future UI:

- `GET /queue/engagement-stats` → full overview (`totals`, `openRate`, `replyRate`, `bookRate`, `byBucket[]`, `callStats`, `computedAt`, `openDataNote`, `range`, `rangeLabel`).
- `GET /queue/engagement-stats?leadId={id}` → single-lead `LeadEngagementSummary`.
- `GET /queue/engagement-stats?refresh=1` → bypass the 5-minute in-process cache.
- `GET /queue/engagement-stats?period=30d` → scope all metrics to last 30 days.

Implementation: `src/outreach/emailEngagementStats.ts` (aggregation), `src/outreach/meetingAttribution.ts` (booking credit), `src/outreach/callDispositionSync.ts` (HubSpot call sync), `src/ui/engagementDashboard.ts` (HTML), `src/shared/openTrackToken.ts` + `src/routes/openTrack.ts` (pixel). No schema change — opens, bookings, and call dispositions live in `AuditLog`.

**Specialized operator queues (v1.6+, v1.8).**

| Route | Purpose |
| --- | --- |
| `/queue` | Email draft review + triage + engagement dashboard |
| `/queue?period=30d` | Same, scoped to 30-day engagement window |
| `/queue/lead-engagement/:leadId` | Per-lead send history, open/reply/book flags, temperature + approach hint |
| `/queue/engagement-stats` | JSON engagement overview (optional `?leadId=`, `?refresh=1`, `?period=`) |
| `/track/open/:draftId` | Signed 1×1 pixel — logs `email.opened` to AuditLog (no auth) |
| `/cold-call` | Cold-call disposition queue — 3-touch cadence, one-click logging |
| `/renewals-call` | Live renewal calls — 5 touches on BD 3–7, HubSpot task mirror |
| `/manual-vm-queue` | State-law restricted leads (FL, OK, WA, IN, MA, TX, CA) — human-placed vm/call |

### 9.6 Sending, Sequencing & Cold-Call Cadence

**Email send (unchanged core).** Approved drafts ship via Gmail API every 10 min (`sendApproved`). Markdown bodies render as HTML (`markdownHtml.ts` → `emailHtml.ts`). Tracking pixel embedded in HTML part. Post-sale emails always append phone-consent/opt-out footer.

**Auto-sequence touches 2–5 (unchanged).** `runSequences` (7:30 AM ET) auto-sends template follow-ups for leads in the no-reply sequence.

**Cold-call cadence (v1.8).** When a `kind='cold'` email sends to a lead with `phoneE164` on file (and not smoke-test / excluded / doNotContact), `flagColdForCall()` opens a **3-touch human call sequence**:

| Touch | Due | HubSpot task | Operator surface |
| --- | --- | --- | --- |
| 1 | BD 2 after cold send | `Cold call 1/3 — {facility}` | `/cold-call`, daily brief |
| 2 | BD 5 | `Cold call 2/3 — {facility}` | `coldCallFollowups` cron creates task |
| 3 | BD 9 | `Cold call 3/3 — {facility}` | Window closes after BD 9 |

**Disposition:** `/cold-call` offers Connected / No answer / Done buttons. Each logs `AuditLog 'cold.call-touch'` + HubSpot outbound call engagement. **Connected** closes the sequence. Sequence also retires on inbound reply, attributed meeting booked, or window expiry.

**Operator guidance:** Lead with the free Sobriety Select profile offer; keep paid tier for the booked call. Prep brief link on each row when `hubspotCompanyId` exists.

**Meeting attribution (v1.8).** `attributeMeetings` (4:45 PM ET) scans HubSpot meetings created in the last 30 days, maps company → Lead, credits the most recent attributable outbound draft (`AuditLog 'meeting.booked'` with `{ draftId, leadId, kind, startAt }`). Credits cold-call sequence retirement and engagement book rate.

### 9.7 Reply Detection — v1.2 additions

`checkReplies` (every ~5 min via `cronTick`) polls Gmail with `newer_than:15m -from:me`, header-checks against `GMAIL_FROM` to guard against BCC-to-self and filter re-delivery routes, runs an OOO heuristic (`Out of Office` / `Automatic reply` subject prefixes; `I am out of the office` / `currently out of the office` body markers), then parses `In-Reply-To` + `References` headers and matches the resulting RFC-822 ids against `Draft.gmailMessageId`. A match generates a `kind='replied'` Draft via Claude (`claude-sonnet-4-5-20250929`, max_tokens 512, temperature 0.5) using the COLD draft (not the last follow-up) as the original-pitch context.

**Race safety.** The 15-min lookback × ~5-min cron cadence overlaps deliberately so a missed tick is recovered. Two concurrent `checkReplies` invocations could both pass the AuditLog fast-path; race-safe correctness is enforced by the `Draft.inboundGmailMessageId @unique` index. The losing worker hits `P2002`, re-loads the winner, and resumes the HubSpot upsert half if it was skipped.

**HubSpot inbound engagement (v1.2 addition).** Every matched reply also logs a HubSpot Email engagement with `hs_email_direction='INCOMING_EMAIL'`, `hs_timestamp` = the message's `internalDate` (actual receive time, not our cron-tick time), `hs_email_subject` and `hs_email_text` from the snippet, plus `hs_email_headers` carrying the parsed `from` address. Associations are created via `hs.crm.associations.v4.basicApi.createDefault('emails', emailId, 'contacts'|'companies', ...)` so HubSpot resolves type IDs. Idempotency lives on `Draft.hubspotInboundEmailId` — separate from `hubspotEmailId` because the outbound *response* engagement (created when sender.ts sends the replied draft) will claim the latter. Best-effort: HubSpot failures audit as `hubspotInboundEngagement.failed` and never propagate; the DB-side `Draft kind='replied'` is the source of truth.

**Brief surfacing (v1.2 addition).** Inbound replies in the last 24h appear as a dedicated `📬 New replies` section in the 5 PM daily brief (PRD §9.8 / INSTRUCTIONS Prompt 7.2), with facility name, owner, snippet, received-at, and a deep link into `/queue`. This is the highest-leverage section of the brief — replies are warm intent and Sonia should triage them first.

**Snippet persistence (v1.2 follow-up, INSTRUCTIONS Prompt 7.3).** The `reply.draft-created` AuditLog row carries `meta.inboundSnippet` (capped at 2000 chars, ~10× the brief's display cap). The daily brief reads the snippet from audit meta first and only falls back to `emails.basicApi.getById(['hs_email_text'])` on the matching `Draft.hubspotInboundEmailId` for historical drafts created before this follow-up landed. This eliminates up to one HubSpot GET per replied draft per brief and lets the brief render correctly even when the HubSpot inbound engagement step is mid-retry. No schema change — `inboundSnippet` lives in the existing `AuditLog.meta` JSONB.



### 9.8 Pipeline Scoring + Brief

Scoring unchanged from v1.1 (sorts by `score × expectedCommission`).

**Daily brief sections (5:00 PM ET, v1.8 order of leverage):**

1. `📬 New replies` — last 24h inbound (highest priority)
2. `📈 Hiring spikes` — intent signal flips
3. Hot leads + at-risk deals (scoring; $0-weighted leads excluded from hot top-5)
4. Suggested call list (prospect pool)
5. **`📞 Renewals to call`** — open renewal call sequences (7-day window, link to `/renewals-call`)
6. **`📞 Reactivations to call`** — sent reactivations awaiting manual call (14-day window; vm paused)
7. **`📞 Cold calls to make`** — open 3-touch cold-call sequences (link to `/cold-call`)
8. **`📅 Meeting follow-ups`** — passed booked meetings needing recap or reschedule (operator decides held vs no-show)
9. `🚨 Manual VM required` — restricted-state leads (`/manual-vm-queue`)
10. Queue depth + yesterday stats (sent count, replies, meetings booked)

### 9.9 Voicemail Drops (AMD — consent-gated reactivation only)

> **⚠️ OPERATIONAL STATUS (v1.8): PAUSED.** `dropVoicemails` and `runSecondCalls` are **disabled** in `src/shared/cronSchedule.ts`. While paused, sent reactivations flag for **manual live call** (§9.10) and cold prospects use the **call cadence** (§9.6). All code, Twilio hooks, ElevenLabs rendering, and compliance wrappers are preserved. Re-enable by setting both jobs to `enabled: true` after counsel approves `VM_AI_AUTO_SEND=true` on web + cron.

**Scope (v1.6, when enabled).** AI voicemail applies **only** to **reactivation** prospects who have opted in via **prior express written consent (PEWC)** after a sent reactivation email. **Renewals never receive AI vm** — they use the live-call cadence in §9.10. **Cold-prospect vm is off.**

**What this is.** A standard Twilio outbound call with Answering Machine Detection (`DetectMessageEnd`, 30s timeout). The callee's phone **rings**. If Twilio classifies the answer as a machine (voicemail greeting + beep), Twilio plays a pre-rendered ElevenLabs MP3 (`eleven_multilingual_v2`) wrapped with **deterministic artificial-voice + opt-out disclosures** (`wrapVoicemailScript`). If a **human** answers, Twilio plays a brief **honest automated disclosure** (Twilio `<Say>`, not ElevenLabs — e.g. "This is an automated follow-up from Sobriety Select…") and **bridges to Sonia** on `SONIA_PHONE` with prep brief email + whisper. No conversational AI agent — live conversation is always the real operator.

**What this is not.** Ringless voicemail (RVM) — silent carrier-side injection without ringing — is explicitly out of scope. Live two-way AI voice remains a **V1 non-goal** (§14).

**Consent gate.** Renewal and reactivation emails append an optional PEWC footer linking to `GET /consent-phone` (JWT-signed). On opt-in: `Lead.priorWrittenConsent=true`, `priorWrittenConsentAt` set. `dropVoicemails` requires consent **and** a sent **reactivation** draft within 30 days. STOP/unsubscribe replies clear consent and suppress (§12).

**Auto-send gate.** Twilio dials only when `VM_AI_AUTO_SEND=true` on **both** web and cron services (counsel sign-off). When enabled, reactivation vm drafts are created as `status='approved'` so `sendApproved` picks them up every 10 min. When disabled, vm scripts appear in `/queue` as reference only.

**ElevenLabs.** One TTS render per draft at draft-creation time; MP3 stored on `Draft.audioMp3`. Model: `eleven_multilingual_v2` via `ELEVENLABS_VOICE_ID`.

**Safety gates (before any paid API call):** landline-only (`isLandline` via Twilio Lookups; `SMOKE_TEST_LEAD_ID` bypasses for operator validation), `doNotContact` / Suppression, state matrix (`MANUAL_ONLY_US_STATES`: FL, OK, WA, IN, MA, TX, CA → `/manual-vm-queue`), federal TCPA quiet hours (8 AM–9 PM local), one active vm-1 pipeline per lead (rejected / tombstone drafts do not block retry).

**Two-touch sequence (reactivation trigger only):**

| Touch | Draft kind | Cron | Send window | Human answers | Machine |
| --- | --- | --- | --- | --- | --- |
| 1st | `voicemail` | `dropVoicemails` 2 PM ET | **After-hours only** — outside local Mon–Fri 9 AM–6 PM, or anytime Sat/Sun (`isVm1SendWindowOpen`) | **Say + bridge to Sonia** | Play MP3 after beep |
| 2nd | `voicemail-2` | `runSecondCalls` (~3 business days after vm-1 dropped) | Anytime within TCPA hours | **Say + bridge to Sonia** | Play MP3 after beep |

**Inbound callbacks.** `POST /webhook/twilio/inbound` forwards callers on the Twilio number to `SONIA_PHONE` (live operator, not AI).

**Operator smoke test.** Set `SMOKE_TEST_LEAD_ID` to the test `Lead.id` on web + cron. Run `npx tsx src/scripts/seedSmokeTestPostSaleQueue.ts` to stage renewal + reactivation queue fixtures; `RUN_VM_PIPELINE=true VM_AI_AUTO_SEND=true` exercises the full reactivation → consent → vm path.

**v1.6 note (revised).** Human pickup on consent-gated reactivation vm uses the same live-bridge path as v1.5 (prep brief + whisper), with an added honest `<Say>` disclosure to the callee before the bridge. Renewals never receive AI vm — live calls use §9.10.

### 9.10 Post-Sale Workflows — renewal vs reactivation

**Renewal (`kind='renewal'`, daily `renewalWarnings` 10 AM ET).**

- **Who:** Closed-won clients whose `ss_renewal_date` falls 55–65 days out.
- **Email:** CSM tone — confirm next contract period; pricing belongs on the **live call**, not in the email.
- **After send:** `flagRenewalForCall()` fires from `sendApproved` / `/mark-sent`. No AI vm.
- **Live-call cadence:** Up to **5 touches** on business days **3, 4, 5, 6, 7** after the renewal email sends (first HubSpot task due **BD 3**; window closes after **BD 7**). Progress tracked in `AuditLog` (`renewal.call-flagged`, `renewal.call-touch`, `renewal.call-completed`, `renewal.call-expired`); HubSpot tasks created/completed via `src/shared/hubspotTask.ts`.
- **Operator surfaces:** `/renewals-call` (full table), compact preview on `/queue`, `📞 Renewals to call` in daily brief, HubSpot task on company.
- **Cron:** `renewalCallFollowups` 8:00 AM ET — creates due touch tasks, expires stale sequences.

**Reactivation (`kind='reactivation'`, weekly Mon 3 AM ET).**

- **Who:** Open HubSpot deals stale 30+ days with prior engagement (`replied` or `followup-*` draft history).
- **Email:** Win-back tone — fresh angle + 15-min ask; optional PEWC footer if phone on file.
- **After send (v1.8, vm paused):** `flagReactivationForCall()` creates one HubSpot call task due **1 business day** after send. Surfaces in daily brief **"Reactivations to call"** for **14 days** or until the lead replies. No dedicated web queue — HubSpot task is system of record. Audit: `reactivation.call-flagged`, `reactivation.call-completed`.
- **After send + PEWC (when vm re-enabled):** Optional consent-gated AI vm (§9.9). Cap 10 drafts/week.

**Quarterly check-ins and upsell** — unchanged from v1.1 (draft + Sonia approves).

### 9.11 NEW: Discovery Call Prep Brief

**Endpoint:** `GET /prep-brief/:dealId` (queueAuth-protected). Optionally `?send=email` to email it to Sonia instead of rendering HTML.

**Purpose:** Sonia reads this in the 5 minutes before each call. It is the difference between “another SDR call” and “this person knows my business.”

**Generation flow:**

1. Look up HubSpot deal → get associated company + contact
1. Find the matching Lead + Enrichment in our DB by domain
1. Pull recent activity from HubSpot: last 5 engagements (emails, notes, calls), all open tasks, deal stage history
1. Generate brief via Claude with the prep-brief system prompt

**Brief contains (~250 words, markdown-rendered as HTML when emailed):**

- **One-line summary:** “Hope Haven, 24-bed sober living in Asheville NC, owner Sarah Kim, expectedProduct=select ($240 commission)”
- **The three sharpest data points** — usually pulled from `signals` (missing from PT, hiring 2 roles, runs CallRail)
- **Pain points** (top 3 from the painPoints JSON)
- **Conversation history** — 1-line summary of last 3 engagements
- **The 3 questions to ask** — generated by Claude from context
- **Known objections to expect** — based on tier (e.g., for Select: “we tried directories before”). When `freeListingOffered=true`, always include the free-vs-paid objection with a grounded rebuttal.
- **💎 Free listing → premium pivot** (v1.8, only when `freeListingOffered=true`) — two bullets: (1) confirm/claim the free basic profile live on the call; (2) specific incremental value of this prospect's expected tier over the free listing, grounded in a real signal. Honest framing only — no outcome guarantees.
- **The angle to lead with** — single sentence Sonia uses as her opener
- **Pricing reminder** — exact tier + price + commission

`freeListingOffered` is derived from draft history: true when a sent `kind='cold'` email exists for this lead (they entered through the free-profile offer).

Brief is *also* persisted as a `Draft` with `kind='prep-brief'`, status=‘sent’ (no approval needed — it’s not outbound), so it shows up in the lead’s history. Sonia can re-pull or share with Mark.

### 9.12 LinkedIn-aware Re-engagement Trigger (subtle bonus)

`refreshGoogleSignals` (Mon 4am) is renamed to `refreshIntentSignals`. In addition to re-checking Places reviews, it now re-runs the Serper hiring query for the top 100 open deals. If a deal that was previously `hiring.active=false` becomes `hiring.active=true`, that’s a major re-engagement signal — push to top of next-day’s daily brief with a “🚨 Hiring spike” badge.

### 9.13 Operator Clustering (DEFERRED — not yet implemented)

**Problem.** The addiction-treatment industry is heavily PE-rolled-up; one operator commonly runs many facilities. After enrichment, several owners cluster into multiple Lead rows that should be a single buying decision:

```
Robert Rihn          → 6 facilities
Cindy Grubbs SHRM-CP → 3 facilities
Roaya Tyson          → 3 facilities
+ ~7 owners running 2 facilities each
```

(Numbers from the ~170-row May 2026 enrichment cohort.) Treated independently, each lead would get its own cold email — same human gets emailed up to 6× → spam-trap risk, wasted Anthropic spend, and HubSpot ends up with N Companies that should be 1.

**Decision: ship the read-only signal first, gate behavior later.** A column on Enrichment is rejected because the operator-key formula will evolve (the search-fallback path already returned two different LinkedIn URLs for the same Robert Rihn) and a column locks in stale values that need backfilling on every formula tweak. A draft-time suppression layer is rejected as the first move because it changes outcomes based on a formula no human has eyeballed. The right first step is a derived view that surfaces clusters without committing to behavior.

**Phase 1 (when needed):** Postgres view `OperatorClusters` derived from Enrichment, grouped by `COALESCE("ownerLinkedIn", LOWER(TRIM("ownerName")))`. Exposed through one Prisma raw-query helper `getOperatorClusters()`. No schema migration beyond the view itself. ~30 lines.

**Phase 2 (when drafts go autopilot):** Inside `outreach/draftCold.ts`, before generating a Draft, check the view: if any other Lead in the same cluster already has a Draft with `status IN ('approved','sent')` within the last 30 days, skip and `AuditLog 'draft.skipped.operator-duplicate'`. ~15 lines.

**Phase 3 (only if hot-path filtering on operator key proves needed):** Promote to a materialized `operatorKey` column on Enrichment with a one-shot backfill. Probably never required at our volume.

**Touchpoint integration when each is built:**

- **`pipeline/hubspotSync.ts`:** Use the cluster as the dedup key. Each cluster maps to one HubSpot Company with `operatorKey` as a custom property; member Leads write the same `hubspotCompanyId` back. Robert Rihn’s 6 facilities = 1 Company with 6 Contacts, not 6 Companies.
- **`ui/queue.ts`:** Draft cards in the same cluster show a “🏢 Roll-up: N facilities · M pending drafts · Skip duplicates →” line above the existing signals line. The skip-duplicates action bulk-rejects sibling drafts with `rejectReason: 'operator-duplicate-of-{leadId}'`.
- **`outreach/dailyBrief.ts`:** Dedicated section before the per-deal scoring list — “TODAY’S OPERATOR CLUSTERS: 5 owners running 2+ facilities, total weighted LTV $X”, then the top operators with facility counts and tier inference rolled up to the cluster.

**Known precision caveat.** The fallback `findFacilityLeadership` query occasionally returns a real LinkedIn human whose profile mentions the facility name but who actually works elsewhere (observed: a Coral Sober Living lead tagged with someone from Lighthouse Recovery). The view is informational, so a human reviews; once Phase 2 is on, that precision tradeoff is what gates whether to enable suppression by default vs. require approval.

**Why it’s not in §6 “No new tables” conflict.** The view is not a table — it’s a query expressed as DDL. It can be `DROP VIEW`-ed at any time without data loss. If Phase 3 ever happens it adds a column, not a table.

-----

## 10. Claude Prompt Architecture

All prompts in `src/prompts/`. New file: `src/prompts/prepBrief.ts`.

Required prompts:

- `coldEmail.ts` — generator + evaluator (tier + signals-aware, free-listing angle)
- `coldEmailQuality.ts` lives in `src/outreach/` — deterministic quality gates, not a Claude prompt
- `websiteAnalyzer.ts` — extracts owner, tier, painPoints
- `followUpTemplates.ts` — rule-based touches 2–5
- `replied.ts` — replied-thread drafter
- `reschedule.ts` — no-show / re-book nudge (v1.8)
- `quarterlyCheckin.ts` — 90/180/270-day touch (the `Q{N} listing analytics` soft offer resolves to the **current calendar quarter** 1-4, never customer tenure — see INSTRUCTIONS Prompt 9.1.1)
- `renewalWarning.ts` — 60-day pre-renewal (term-aware via `ss_contract_term_months`)
- `reactivation.ts` — stale-deal drafter
- `voicemailScript.ts` — 25-second VM script
- `prepBrief.ts` — NEW — discovery call brief
- `copilot.ts` — RAG sales co-pilot
- `dailyBrief.ts` — 5 PM digest

-----

## 11. Knowledge Base — unchanged from v1.1

`kb/` directory with locked pricing in `kb/product/listing-tiers.md`.

-----

## 12. Compliance Architecture

CAN-SPAM, TCPA, HIPAA, contract §7d, audit logging. See `kb/compliance/can-spam-tcpa.md`.

**v1.6 additions:**

- **PEWC (prior express written consent)** for post-sale phone contact — click-through on `/consent-phone`; stored on `Lead.priorWrittenConsent`. Required before reactivation AI vm (when re-enabled).
- **Artificial-voice disclosures** injected deterministically on all vm scripts (`wrapVoicemailScript`) — not left to the LLM.
- **STOP / unsubscribe replies** — `replyWatcher` detects opt-out text, suppresses email + phone, clears PEWC, cancels pending drafts.
- **State matrix expanded** — TX and CA added to manual-only states (FL, OK, WA, IN, MA, TX, CA).
- **Renewals** — live calls only; no prerecorded vm to existing clients without a separate counsel review path.

**v1.8 operational:**

- **AI voicemail paused** — `VM_AI_AUTO_SEND` unset; cron jobs disabled. Manual live calls for reactivations (HubSpot task) and cold prospects (`/cold-call` cadence). Counsel briefing HTML in `src/shared/counselBriefingHtml.ts` documents current posture for legal review.

-----

## 13. Success Metrics & Thresholds

Same as v1.1, plus new V1.2 KPI:

- **Personalization “specificity” score** — average personalization_pct across approved drafts. v1.1 baseline target: ≥65%. v1.2 expectation with three new signals: ≥75%. If we don’t see the lift, the signals aren’t being woven in correctly.
- **Prep-brief usage rate** — % of discovery calls where Sonia pulled the brief beforehand. Target: 90%+. Self-tracked in a Notion checklist.
- **Book rate per sequence step (v1.8)** — primary conversion metric now visible on `/queue` engagement dashboard. Target: establish baseline in week 2, optimize cold + follow-up-1 buckets first (calendar-link bookings often skip reply).
- **Cold connect rate (v1.8)** — % of cold-call dispositions marked Connected via `/cold-call`. Track alongside email reply rate — the sequence pairs both channels.

Stage gates unchanged.

-----

## 14. Non-Goals (V1)

- No SMS outbound
- No LinkedIn auto-DM
- No live two-way AI voice agent
- No public-facing app, multi-tenant, or mobile app
- No CRM other than HubSpot
- No analytics dashboard beyond HubSpot + daily brief email + `/queue` engagement panel (v1.7+)
- No separate scraping/CRM microservice
- **No BuiltWith paid API** (we’re doing tech-stack detection in-house via regex on already-fetched HTML)

-----

## 15. Risks & Mitigations — unchanged from v1.1

Plus new risk:

|Risk                                                                                         |Mitigation                                                                                  |
|---------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
|Serper spend balloons with 3 extra queries per lead                                         |Cap `enrichAll` daily processing volume to 200 leads/day; budget alert at $50/mo (see §16)  |
|Tech-stack regex false positives (e.g., a blog about HubSpot that has the script URL in text)|Match script tag context only (`<script.*src=.*hs-scripts`), not bare URL appearance in body|
|Signals data goes stale                                                                      |Re-run `refreshIntentSignals` weekly for top 100 active deals                               |

-----

## 16. Deployment & cost ceiling (first 60 days)

Railway Hobby $5/mo base + usage-based compute. Web + Postgres + **one** cron tick service (`*/5 * * * *` UTC) ≈ **$12/mo** infra at our volume.

**Monthly caps (infra + APIs):**

| Item | Monthly cap |
| --- | --- |
| Railway web + Postgres + cron | $12 |
| Claude API | $80 |
| Voyage AI (embeddings) | $5 |
| Google Places | $50 |
| Serper (incl. signals checks) | $50 |
| Twilio (voice + lookups) | $30 |
| ElevenLabs | $22 |
| Mailwarm or equivalent | $50 |
| **Total infra+APIs** | **~$299/month** |

Break-even at ~2 Select-tier deals/month ($240 × 2 = $480). Target 5+ deals/month by month 3.

Signals enrichment adds ~$0.003/lead in Serper marginal cost (~$15 at 5,000 leads in month 1); the $50 Serper cap above covers all search use including signals.

**Cost cap alerts (v1.2).** `checkCostCaps` runs daily at 5:30 PM ET via `cronTick`. It sums `AuditLog` rows with `action='cost.usage'` and emails `BRIEF_RECIPIENT` at 80%/100% of caps or ~$299 total. Twilio, ElevenLabs, and Mailwarm are manual dashboard checks. Marginal alert cost: ~$0.

-----

## 17. Open Questions for Mark Beach — unchanged from v1.1