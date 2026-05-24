# PRD — Sobriety Select SDR Agent (SSA)

**Version:** 1.2
**Owner:** Sonia Gibbs (Independent Contractor, Cardwell-Beach LLC / Sobriety Select)
**Engagement Start:** May 27, 2026
**Last Updated:** May 20, 2026

**Changes from v1.1:**

- Added three high-value enrichment signals: competing-directory presence (Psychology Today, Rehabs.com, Recovery.com), LinkedIn hiring activity, and marketing tech stack detection (HubSpot/Salesforce/CallRail tags found in HTML)
- Added **discovery call prep brief generator** to V1 — the 5-minute pre-call document that turns Sonia into a psychic on every call
- Added `.cursorrules` and CURSOR_GUIDE.md as committed repo artifacts so Cursor builds correctly the first time
- Schema unchanged from v1.1 (new signals live inside `Enrichment.painPoints` JSON field — no migration needed)

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
│   Cron Jobs (Render Cron)        Express API                  │
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
|CRM       |HubSpot Free + `@hubspot/api-client`             |
|Email send|Gmail API via OAuth2 (`sonia@sobrietyselect.com`)|
|Voice     |Twilio + ElevenLabs TTS (voicemail only)         |
|Hosting   |Render (web + cron + Postgres)                   |

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
├── render.yaml
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
  id                 String    @id @default(cuid())
  leadId             String
  lead               Lead      @relation(fields: [leadId], references: [id])
  kind               String    // 'cold' | 'followup-2/3/4/5' | 'replied' | 'noshow' | 'quarterly' | 'renewal' | 'upsell' | 'reactivation' | 'voicemail' | 'prep-brief'
  subject            String?
  body               String
  audioMp3           Bytes?
  personalizationPct Int?
  specificFacts      String[]
  status             String
  rejectReason       String?
  approvedBy         String?
  sentAt             DateTime?
  gmailMessageId     String?
  hubspotEmailId     String?
  twilioCallSid      String?
  createdAt          DateTime  @default(now())
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
|`0 6 * * *`   |6:00 AM  |`scorePipeline`       |pipeline|
|`30 6 * * *`  |6:30 AM  |`draftColdBatch`      |outreach|
|`0 7 * * *`   |7:00 AM  |`draftFollowups`      |outreach|
|`30 7 * * *`  |7:30 AM  |`runSequences`        |outreach|
|`0 9 * * *`   |9:00 AM  |`quarterlyCheckins`   |outreach|
|`0 10 * * *`  |10:00 AM |`renewalWarnings`     |outreach|
|`0 14 * * *`  |2:00 PM  |`dropVoicemails`      |outreach|
|`*/15 * * * *`|15 min   |`checkReplies`        |outreach|
|`*/10 * * * *`|10 min   |`sendApproved`        |outreach|
|`0 17 * * *`  |5:00 PM  |`sendDailyBrief`      |outreach|
|`0 3 * * 1`   |Mon 3am  |`reactivation`        |outreach|
|`0 4 * * 1`   |Mon 4am  |`refreshGoogleSignals`|pipeline|

Prep briefs are **generated on demand** via `GET /prep-brief/:dealId` — no cron needed. Sonia hits it 5 minutes before each call.

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

### 9.5 Approval Queue (`/queue`)

Same as v1.1, plus:

- Each draft card shows a small “signals” line below the pain points: e.g., “🎯 Missing from PT + Rehabs.com · 📈 Hiring 2 intake roles · 💰 HubSpot+CallRail detected”
- This is the visual cue that lets Sonia eyeball “high-leverage” drafts and approve those first

### 9.6 Sending & Sequencing — unchanged from v1.1

### 9.7 Reply Detection — unchanged from v1.1

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

-----

## 10. Claude Prompt Architecture

All prompts in `src/prompts/`. New file: `src/prompts/prepBrief.ts`.

Required prompts:

- `coldEmail.ts` — generator + evaluator (tier + signals-aware)
- `websiteAnalyzer.ts` — extracts owner, tier, painPoints
- `followUpTemplates.ts` — rule-based touches 2–5
- `replied.ts` — replied-thread drafter
- `quarterlyCheckin.ts` — 90/180/270-day touch
- `renewalWarning.ts` — 60-day pre-renewal
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
|Serper spend balloons with 3 extra queries per lead                                         |Cap `enrichAll` daily processing volume to 200 leads/day; budget alert at $80/mo            |
|Tech-stack regex false positives (e.g., a blog about HubSpot that has the script URL in text)|Match script tag context only (`<script.*src=.*hs-scripts`), not bare URL appearance in body|
|Signals data goes stale                                                                      |Re-run `refreshIntentSignals` weekly for top 100 active deals                               |

-----

## 16. Deployment — unchanged from v1.1

Render web $7 + Postgres $7 + Cron free = ~$14/mo infra. API costs ~$200/mo at expected volume (with the three new Serper calls; Serper is ~5× cheaper than the SerpAPI plan we initially scoped, so signals checks add ~$15/mo rather than ~$50/mo).

-----

## 17. Open Questions for Mark Beach — unchanged from v1.1