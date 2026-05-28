# PRD — Sobriety Select SDR Agent (SSA)

**Version:** 1.3
**Owner:** Sonia Gibbs (Independent Contractor, Sobriety Select)
**Engagement Start:** May 27, 2026
**Last Updated:** May 28, 2026

**Changes from v1.2 (May 28, 2026):**

- **Contract term + auto renewal date.** HubSpot Deal property `ss_contract_term_months` (3, 6, or 12). Daily `syncDealRenewalDates` (9:45 AM ET) sets `ss_renewal_date = closedate + term` for every closed-won deal with both fields set. `renewalWarnings` (10:00 AM ET) reads the term so pre-renewal copy matches 3-/6-/12-month contracts. Operator: set term at close; on each renewal, bump **Close Date** to the new contract start.

**Changes from v1.2:**

- **Deployment on Railway.** One web service + one Postgres plugin + one cron service (`cronTick` every 5 min UTC, dispatches PRD §9.1 jobs in Eastern time). See `RAILWAY.md` and `railway.toml`. Cheaper than 16 separate cron services.
- **`refreshIntentSignals` implemented (§9.12).** Monday 4 AM ET cron refreshes Places ratings + hiring signals on top open deals; hiring flips audit `intent.hiring-spike` for the daily brief.

**Changes from v1.2 (continued):**

- **`syncToHubspot` on daily cron (5:45 AM ET).** Runs after `enrichAll` so new enrichments mirror to HubSpot before scoring and drafting.
- **`draftFollowups` implemented (7:00 AM ET).** Batch `draftNudge` for 10+ day silence leads; defers to `runSequences` when an auto touch is due.

**Changes from v1.1:**

- Added three high-value enrichment signals: competing-directory presence (Psychology Today, Rehabs.com, Recovery.com), LinkedIn hiring activity, and marketing tech stack detection (HubSpot/Salesforce/CallRail tags found in HTML)
- Added **discovery call prep brief generator** to V1 — the 5-minute pre-call document that turns Sonia into a psychic on every call
- Added `.cursorrules` and CURSOR_GUIDE.md as committed repo artifacts so Cursor builds correctly the first time
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

No AI ever sends an email or makes a phone call without Sonia’s explicit approval, with the **single exception** of automated no-reply follow-up touches 2–5 in a pre-approved sequence.

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
|No-reply follow-ups (touches 2–5)    |100%                             |Low risk, high cadence      |
|Replied / booked / no-show follow-ups|AI drafts, Sonia sends           |Relationship signal         |
|Lost-deal nurture                    |100%                             |Long horizon, low risk      |
|Cold deal reactivation flagging      |100% flag, AI drafts, Sonia sends|Salvage                     |
|Daily pipeline scoring + brief       |100%                             |Morning briefing            |
|**Discovery calls**                  |**0%**                           |**Sonia’s competitive moat**|
|**Discovery call prep brief**        |**100% (generated on demand)**   |**5-min pre-call read**     |
|Proposals                            |AI drafts, Sonia finalizes       |Stakes too high             |
|Live objection email responses       |0%                               |Relationship                |
|Closed-won onboarding                |100% drafted, Sonia approves     |Set tone                    |
|Quarterly client check-ins           |100% drafted, Sonia approves     |Renewal pipeline            |
|Renewal early-warning                |100% flag, AI drafts             |Money on the table          |
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
|Voice     |Twilio + ElevenLabs TTS (voicemail only)         |
|Hosting   |Railway (web + cron + Postgres)                  |

**Explicitly excluded:** Redis, WebSockets, OpenAI, Docker Compose, BullMQ, Turborepo, custom React UI, Salesforce, microservices.

-----

## 7. Folder Structure

```
sobriety-select-sdr/
├── .cursorrules                 # Cursor reads automatically
├── CURSOR_GUIDE.md              # how Sonia uses Cursor with this repo
├── PRD.md
├── INSTRUCTIONS.md
├── CHECKLIST.md
├── README.md
├── RAILWAY.md
├── railway.toml
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
│   │   └── scoring.ts
│   ├── outreach/                # Relationship domain
│   │   ├── draftCold.ts
│   │   ├── sequencer.ts
│   │   ├── replyWatcher.ts
│   │   ├── quarterlyCheckin.ts
│   │   ├── renewalWarning.ts
│   │   ├── reactivation.ts
│   │   ├── voicemail.ts
│   │   ├── prepBrief.ts         # NEW: discovery call prep
│   │   ├── dailyBrief.ts
│   │   └── sender.ts
│   ├── shared/
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
│   │   ├── copilot.ts
│   │   └── prepBrief.ts         # NEW: /prep-brief/:dealId route
│   ├── routes/
│   │   ├── unsubscribe.ts
│   │   └── twilioHooks.ts
│   ├── middleware/
│   │   └── queueAuth.ts
│   ├── scripts/
│   └── server.ts
└── tests/prompts/
```

-----

## 8. Data Model (6 tables — unchanged from v1.1)

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

|Cron          |Time (ET)|Job                   |Domain  |
|--------------|---------|----------------------|--------|
|`0 5 * * *`   |5:00 AM  |`dailyScrape`         |pipeline|
|`30 5 * * *`  |5:30 AM  |`enrichAll`           |pipeline|
|`45 5 * * *`  |5:45 AM  |`syncToHubspot`       |pipeline|
|`0 6 * * *`   |6:00 AM  |`scorePipeline`       |pipeline|
|`30 6 * * *`  |6:30 AM  |`draftColdBatch`      |outreach|
|`0 7 * * *`   |7:00 AM  |`draftFollowups`      |outreach|
|`30 7 * * *`  |7:30 AM  |`runSequences`        |outreach|
|`0 8 * * *`   |8:00 AM  |`draftUpsellBatch`    |outreach|
|`0 9 * * *`   |9:00 AM  |`quarterlyCheckins`   |outreach|
|`45 9 * * *`  |9:45 AM  |`syncDealRenewalDates`|pipeline|
|`0 10 * * *`  |10:00 AM |`renewalWarnings`     |outreach|
|`0 14 * * *`  |2:00 PM  |`dropVoicemails`      |outreach|
|`*/5 * * * *` |~5 min   |`checkReplies`        |outreach|
|`*/10 * * * *`|10 min   |`sendApproved`        |outreach|
|`0 17 * * *`  |5:00 PM  |`sendDailyBrief`      |outreach|
|`30 17 * * *` |5:30 PM  |`checkCostCaps`       |ops     |
|`0 3 * * 1`   |Mon 3am  |`reactivation`        |outreach|
|`0 4 * * 1`   |Mon 4am  |`refreshGoogleSignals`|pipeline|

Prep briefs are **generated on demand** via `GET /prep-brief/:dealId` — no cron needed. Sonia hits it 5 minutes before each call.

**Railway deployment:** One always-on web service plus one cron service on `*/5 * * * *` UTC running `cronTick.ts`, which dispatches PRD jobs by Eastern time. See `RAILWAY.md`. `draftFollowups` (7:00 AM ET) batch-drafts approval-gated `kind='nudge'` emails for leads in the awaiting-reply state (same rules as `/queue` §9.5); `runSequences` (7:30 AM) auto-sends template touches 2–5. `dropVoicemails` stays disabled until implemented.

### 9.2 Lead Sourcing (pipeline)

1. FindTreatment.gov scraper (paginated, 5 target states)
1. Google Places (New) Text Search (7 queries × major cities)
1. Psychology Today scraper (deferred to V1.5)
1. Dedupe + normalize → upsert Lead

**Success criteria:** ≥5,000 deduplicated leads in FL/CA/TX after week 1.

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

### 9.6 Sending & Sequencing — unchanged from v1.1

### 9.7 Reply Detection — v1.2 additions

`checkReplies` (every ~5 min via `cronTick`) polls Gmail with `newer_than:15m -from:me`, header-checks against `GMAIL_FROM` to guard against BCC-to-self and filter re-delivery routes, runs an OOO heuristic (`Out of Office` / `Automatic reply` subject prefixes; `I am out of the office` / `currently out of the office` body markers), then parses `In-Reply-To` + `References` headers and matches the resulting RFC-822 ids against `Draft.gmailMessageId`. A match generates a `kind='replied'` Draft via Claude (`claude-sonnet-4-5-20250929`, max_tokens 512, temperature 0.5) using the COLD draft (not the last follow-up) as the original-pitch context.

**Race safety.** The 15-min lookback × ~5-min cron cadence overlaps deliberately so a missed tick is recovered. Two concurrent `checkReplies` invocations could both pass the AuditLog fast-path; race-safe correctness is enforced by the `Draft.inboundGmailMessageId @unique` index. The losing worker hits `P2002`, re-loads the winner, and resumes the HubSpot upsert half if it was skipped.

**HubSpot inbound engagement (v1.2 addition).** Every matched reply also logs a HubSpot Email engagement with `hs_email_direction='INCOMING_EMAIL'`, `hs_timestamp` = the message's `internalDate` (actual receive time, not our cron-tick time), `hs_email_subject` and `hs_email_text` from the snippet, plus `hs_email_headers` carrying the parsed `from` address. Associations are created via `hs.crm.associations.v4.basicApi.createDefault('emails', emailId, 'contacts'|'companies', ...)` so HubSpot resolves type IDs. Idempotency lives on `Draft.hubspotInboundEmailId` — separate from `hubspotEmailId` because the outbound *response* engagement (created when sender.ts sends the replied draft) will claim the latter. Best-effort: HubSpot failures audit as `hubspotInboundEngagement.failed` and never propagate; the DB-side `Draft kind='replied'` is the source of truth.

**Brief surfacing (v1.2 addition).** Inbound replies in the last 24h appear as a dedicated `📬 New replies` section in the 5 PM daily brief (PRD §9.8 / INSTRUCTIONS Prompt 7.2), with facility name, owner, snippet, received-at, and a deep link into `/queue`. This is the highest-leverage section of the brief — replies are warm intent and Sonia should triage them first.

**Snippet persistence (v1.2 follow-up, INSTRUCTIONS Prompt 7.3).** The `reply.draft-created` AuditLog row carries `meta.inboundSnippet` (capped at 2000 chars, ~10× the brief's display cap). The daily brief reads the snippet from audit meta first and only falls back to `emails.basicApi.getById(['hs_email_text'])` on the matching `Draft.hubspotInboundEmailId` for historical drafts created before this follow-up landed. This eliminates up to one HubSpot GET per replied draft per brief and lets the brief render correctly even when the HubSpot inbound engagement step is mid-retry. No schema change — `inboundSnippet` lives in the existing `AuditLog.meta` JSONB.



### 9.8 Pipeline Scoring + Brief — unchanged from v1.1 (sorts by `score × expectedCommission`)

### 9.9 Voicemail Drops — unchanged from v1.1

### 9.10 Post-Sale Workflows — unchanged from v1.1

### 9.11 NEW: Discovery Call Prep Brief

**Endpoint:** `GET /prep-brief/:dealId` (queueAuth-protected). Optionally `?send=email` to email it to Sonia instead of rendering HTML.

**Purpose:** Sonia reads this in the 5 minutes before each call. It is the difference between “another SDR call” and “this person knows my business.”

**Generation flow:**

1. Look up HubSpot deal → get associated company + contact
1. Find the matching Lead + Enrichment in our DB by domain
1. Pull recent activity from HubSpot: last 5 engagements (emails, notes, calls), all open tasks, deal stage history
1. Generate brief via Claude with the prep-brief system prompt

**Brief contains (~250 words, markdown-rendered):**

- **One-line summary:** “Hope Haven, 24-bed sober living in Asheville NC, owner Sarah Kim, expectedProduct=select ($240 commission)”
- **The three sharpest data points** — usually pulled from `signals` (missing from PT, hiring 2 roles, runs CallRail)
- **Pain points** (top 3 from the painPoints JSON)
- **Conversation history** — 1-line summary of last 3 engagements
- **The 3 questions to ask** — generated by Claude from context
- **Known objections to expect** — based on tier (e.g., for Select: “we tried directories before”)
- **The angle to lead with** — single sentence Sonia uses as her opener
- **Pricing reminder** — exact tier + price + commission

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

- `coldEmail.ts` — generator + evaluator (tier + signals-aware)
- `websiteAnalyzer.ts` — extracts owner, tier, painPoints
- `followUpTemplates.ts` — rule-based touches 2–5
- `replied.ts` — replied-thread drafter
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

## 12. Compliance Architecture — unchanged from v1.1

CAN-SPAM, TCPA, HIPAA, contract §7d, audit logging.

-----

## 13. Success Metrics & Thresholds

Same as v1.1, plus new V1.2 KPI:

- **Personalization “specificity” score** — average personalization_pct across approved drafts. v1.1 baseline target: ≥65%. v1.2 expectation with three new signals: ≥75%. If we don’t see the lift, the signals aren’t being woven in correctly.
- **Prep-brief usage rate** — % of discovery calls where Sonia pulled the brief beforehand. Target: 90%+. Self-tracked in a Notion checklist.

Stage gates unchanged.

-----

## 14. Non-Goals (V1)

- No SMS outbound
- No LinkedIn auto-DM
- No live two-way AI voice agent
- No public-facing app, multi-tenant, or mobile app
- No CRM other than HubSpot
- No analytics dashboard beyond HubSpot + daily brief email
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