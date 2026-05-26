# INSTRUCTIONS — Sobriety Select SDR Agent (SSA)

**Version:** 1.2
**For:** Sonia (operator) using Cursor
**Companion files:** `.cursorrules` (Cursor reads automatically), `CURSOR_GUIDE.md` (operator manual)

**Changes from v1.1:**

- All engineering rules (DO/DON’T lists, style preferences) are now in `.cursorrules` — Cursor reads them on every prompt automatically. Per-prompt blocks below are tighter as a result.
- Three new prompts for the intelligence signals (competing directories, hiring activity, marketing tech stack)
- New prompt for the discovery call prep brief generator
- Updated website analyzer + cold email prompts to consume the new signals
- Each prompt now has a strict “STOP” instruction at the end + explicit “this prompt creates these files only” list

**How to use this doc:**

1. Open Cursor in the repo. Verify it sees `.cursorrules` (ask “what rules are you following?”).
2. Open Composer (Cmd/Ctrl+I).
3. Copy ONE prompt block at a time. Paste. Wait for diff. Verify acceptance criteria. Commit. Move on.
4. See CURSOR_GUIDE.md for troubleshooting.

---

## Phase 0 — Project Scaffold

### Prompt 0.1 — Initialize the repo

```
Initialize a Node.js 20 + TypeScript project for an SDR automation service.

Files to create (ONLY these — STOP after):
- package.json
- tsconfig.json
- .gitignore
- .env.example
- src/server.ts
- README.md

package.json scripts: "dev" (tsx watch src/server.ts), "build" (tsc), "start" (node dist/server.js), "kb:reindex" (tsx src/scripts/reindexKB.ts), "migrate" (prisma migrate dev), "test" (vitest run), "test:watch" (vitest)

tsconfig.json: ES2022, moduleResolution "bundler", strict true, rootDir "src", outDir "dist", esModuleInterop true, skipLibCheck true.

.gitignore: node_modules, dist, .env, *.log, .DS_Store, playwright-report, test-results

src/server.ts: minimal Express server. GET /health returns { ok: true, uptime: process.uptime(), version: "0.1.0" }. Listen on process.env.PORT || 3000.

.env.example with empty values, one per line:
DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY, GOOGLE_MAPS_API_KEY, SERPER_API_KEY, HUBSPOT_ACCESS_TOKEN, HUBSPOT_OWNER_ID, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, QUEUE_PASSWORD, PUBLIC_URL, UNSUBSCRIBE_SECRET, BRIEF_RECIPIENT, SONIA_PHONE

README.md: 4-line stub pointing to PRD.md, INSTRUCTIONS.md, CURSOR_GUIDE.md.

Install:
- runtime: express, prisma, @prisma/client, zod, dotenv
- dev: tsx, typescript, @types/node, @types/express, vitest

Create empty folders:
src/{pipeline/sources,outreach,shared,prompts,ui,routes,middleware,scripts}
kb/{product,objections,competitors,compliance,industry}
tests/prompts
prisma

No business logic. Just the skeleton.

STOP. Do not create prisma/schema.prisma — that's the next prompt.
```

**Acceptance:** `npm install && npm run dev` → `curl localhost:3000/health` returns JSON.

---

### Prompt 0.2 — Prisma schema (6 tables, locked)

```
Create ONLY prisma/schema.prisma. Six models exactly as in PRD.md §8.

datasource db { provider = "postgresql"; url = env("DATABASE_URL"); extensions = [vector] }
generator client { provider = "prisma-client-js"; previewFeatures = ["postgresqlExtensions"] }

Models in order: Lead, Enrichment, Draft, Suppression, Score, KBChunk, AuditLog.

Critical fields from PRD §8:
- Lead.doNotContact Boolean @default(false)
- Enrichment.expectedProduct String? + Enrichment.signals Json (default to "{}" via @default(...) only if Prisma supports — otherwise leave required and populate at write time)
- Draft.audioMp3 Bytes?, Draft.subject String? (nullable for voicemail/prep-brief kinds)
- KBChunk.embedding Unsupported("vector(1024)")?
- Suppression composite ID on (email, phoneE164)

Do NOT create Sequence, VoicemailAudio, or VoicemailLog. Sequence state is derived from Draft history.

After writing schema, output the bash commands (don't run them):
1. docker run -d --name ssa-pg -p 5432:5432 -e POSTGRES_PASSWORD=ssa -e POSTGRES_DB=ssa pgvector/pgvector:pg15
2. Add to .env: DATABASE_URL=postgresql://postgres:ssa@localhost:5432/ssa?schema=public
3. npx prisma migrate dev --name init
4. npx prisma generate

STOP after writing the schema and the commands.
```

**Acceptance:** Run the commands. `npx prisma studio` shows all 7 tables (Lead, Enrichment, Draft, Suppression, Score, KBChunk, AuditLog).

---

## Phase 1 — Lead Sourcing

### Prompt 1.1 — Lead types and normalization

```
Create ONLY src/shared/lead.ts.

Install libphonenumber-js first (npm install libphonenumber-js).

Export:
1. zod schema `LeadInput` with fields: source (enum 'samhsa'|'gmaps'|'psychtoday'), name (string), street (nullable), city (string), state (string), zip (nullable), phone (nullable), website (nullable), googleRating (nullable number), googleReviews (nullable int), services (string array), sourceMeta (record/unknown).
2. `normalizeName(name: string): string` — lowercase, trim, strip case-insensitive suffixes "LLC", "Inc", "Corp", "Center", "Recovery", "Treatment", "Services" plus commas and periods. Collapse internal whitespace to single space.
3. `addressHash(street: string|null, zip: string|null): string` — sha256 hex of `${(street||'').toLowerCase().replace(/[^a-z0-9]/g,'')}|${zip||''}`. Use node:crypto.
4. `toE164(raw: string|null|undefined): string|null` — libphonenumber-js, US default, return null on invalid.
5. `upsertLead(input: z.infer<typeof LeadInput>)` — Prisma upsert on composite unique (nameNormalized, addressHash). Compute fields. Returns Lead.

Under 100 lines. No other exports.

STOP.
```

**Acceptance:** Insert “Hope Haven LLC, 123 Main St, 28801” and “Hope Haven, Inc, 123 Main St, 28801” → single row.

---

### Prompt 1.2 — FindTreatment.gov scraper

```
Create ONLY src/pipeline/sources/samhsa.ts AND src/scripts/scrapeSamhsa.ts.

src/pipeline/sources/samhsa.ts:
Export `scrapeSamhsa(lat: number, lng: number, radiusMiles: number): Promise<number>`.
URL: https://findtreatment.gov/locator/exportsAsJson/v2?sAddr={lat},{lng}&limitType=2&limitValue={meters}&pageSize=2000&page={page}&sType=sa
meters = Math.round(radiusMiles * 1609.34).
Paginate page=1..totalPages.

For each row, call upsertLead from src/shared/lead.ts with:
- source: 'samhsa'
- name: row.name1 || row.name2
- street, city, state, zip from row
- phone: row.phone
- website: row.website
- services: parse row.services array's f1/f2/f3 codes — map 'OTP'→'mat','BU'→'mat','NU'→'mat','DM'→'detox','IOP'→'iop','PHP'→'php','RES'→'residential','OUTPATIENT'→'outpatient' (deduplicate the result array)
- sourceMeta: the original row

Set fetch User-Agent: "Cardwell-Beach Sobriety-Select Research/1.0 (sonia@sobrietyselect.com)".

Returns count upserted.

src/scripts/scrapeSamhsa.ts:
CLI taking lat lng radius from process.argv. Example invocation in a comment at top:
// tsx src/scripts/scrapeSamhsa.ts 27.6648 -81.5158 500

STOP.
```

**Acceptance:** `tsx src/scripts/scrapeSamhsa.ts 27.6648 -81.5158 200` → 500+ FL leads in `Lead` table.

---

### Prompt 1.3 — Google Places scraper

```
Create ONLY src/pipeline/sources/places.ts AND src/scripts/scrapePlaces.ts.

src/pipeline/sources/places.ts:
Export `scrapePlaces(query: string, lat: number, lng: number, radiusMeters: number): Promise<number>`.

POST https://places.googleapis.com/v1/places:searchText
Headers:
- X-Goog-Api-Key: process.env.GOOGLE_MAPS_API_KEY
- X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.userRatingCount,places.rating,places.businessStatus
- Content-Type: application/json

Body: { textQuery: query, pageSize: 20, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters }}}

Paginate via nextPageToken, max 3 pages (Google's hard cap is 60).

For each place where businessStatus === 'OPERATIONAL':
- Parse formattedAddress: split by ', '. Last = country (US), second-to-last = "STATE ZIP" (split on space → [state, zip]), before that = city, all earlier parts = street joined.
- source: 'gmaps', googleRating: place.rating, googleReviews: place.userRatingCount
- services: []
- sourceMeta: full place object

Returns count.

src/scripts/scrapePlaces.ts:
Hardcode a city lookup const at the top:
const CITIES = {
  miami: { lat: 25.7617, lng: -80.1918, state: 'FL' },
  tampa: { lat: 27.9506, lng: -82.4572, state: 'FL' },
  orlando: { lat: 28.5383, lng: -81.3792, state: 'FL' },
  jacksonville: { lat: 30.3322, lng: -81.6557, state: 'FL' },
  losAngeles: { lat: 34.0522, lng: -118.2437, state: 'CA' },
  sanFrancisco: { lat: 37.7749, lng: -122.4194, state: 'CA' },
  sanDiego: { lat: 32.7157, lng: -117.1611, state: 'CA' },
  houston: { lat: 29.7604, lng: -95.3698, state: 'TX' },
  dallas: { lat: 32.7767, lng: -96.7970, state: 'TX' },
  austin: { lat: 30.2672, lng: -97.7431, state: 'TX' },
  columbus: { lat: 39.9612, lng: -82.9988, state: 'OH' },
  cincinnati: { lat: 39.1031, lng: -84.5120, state: 'OH' },
  cleveland: { lat: 41.4993, lng: -81.6944, state: 'OH' },
  nyc: { lat: 40.7128, lng: -74.0060, state: 'NY' },
  buffalo: { lat: 42.8864, lng: -78.8784, state: 'NY' },
};
const QUERIES = ['treatment center', 'sober living', 'IOP program', 'MAT clinic', 'addiction recovery', 'detox center', 'halfway house'];

For each city × query: call scrapePlaces with radius 50000m.

STOP.
```

**Acceptance:** Run for `miami` → ≥100 leads with `googleReviews` populated.

---

### Prompt 1.4 — Daily scrape wrapper

```
Create ONLY src/scripts/dailyScrape.ts.

Under 60 lines. Pure glue.

const TARGETS = [
  { lat: 27.6648, lng: -81.5158, radius: 500 }, // FL
  { lat: 36.7783, lng: -119.4179, radius: 500 }, // CA
  { lat: 31.9686, lng: -99.9018, radius: 500 }, // TX
  { lat: 40.4173, lng: -82.9071, radius: 300 }, // OH
  { lat: 42.1657, lng: -74.9481, radius: 300 }, // NY
];

For each TARGET: call scrapeSamhsa.
For each city in scrapePlaces' city lookup: call scrapePlaces for each query.

Total upserted summed. Write AuditLog { action: 'cron.success', entity: 'dailyScrape', meta: { totalUpserted } } at end. On any throw: AuditLog { action: 'cron.failure', entity: 'dailyScrape', meta: { error } } then re-throw.

Exit code: 1 if totalUpserted < 100, else 0.

STOP.
```

**Acceptance:** First run → ≥2,000 leads across all 5 states. AuditLog row appears.

---

## Phase 2 — Enrichment

### Prompt 2.1 — Website fetcher (shared)

```
Create ONLY src/shared/fetchSite.ts.

Install playwright (npm install playwright). Add postinstall to package.json: "postinstall": "playwright install chromium".

Export `fetchSite(url: string): Promise<{ html: string; finalUrl: string } | null>`.

Playwright chromium, headless. Settings:
- 15s navigation timeout
- waitUntil 'domcontentloaded'
- User-Agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
- Block resource types image, media, font, stylesheet via route handler
- Capture content; truncate to first 200_000 characters before returning

On ANY error (timeout, navigation failure, 4xx, 5xx): write AuditLog { action: 'fetchSite.error', entity: 'url', entityId: url, meta: { error: errorMessage }}, return null. Single browser instance per call — open, fetch, close.

Under 60 lines.

STOP.
```

**Acceptance:** Fetch a known site → returns html. Fetch bogus URL → returns null + AuditLog row.

---

### Prompt 2.2 — Claude client + website analyzer prompt (tier + signals-aware)

```
Create ONLY src/shared/claude.ts AND src/prompts/websiteAnalyzer.ts.

Install @anthropic-ai/sdk (npm install @anthropic-ai/sdk).

src/shared/claude.ts:
- Export const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
- Export extractText(msg): string — filter content array by type === 'text', map .text, join ''
- Export extractJSON<T>(msg): T — extractText, strip /^```json\n?|\n?```$/g, trim, JSON.parse
- Export setClaudeMock(handler: ((args) => Promise<any>) | null): void — for tests. When set, wrap claude.messages.create to delegate to handler. (Pattern: a module-level `let mockHandler` and a getter.)

src/prompts/websiteAnalyzer.ts:

Export WEBSITE_ANALYZER_SYSTEM: instructional system prompt. Content:

"You analyze treatment-center websites to extract decision-maker signals, marketing pain points, AND infer which Sobriety Select listing tier is the best fit.

Sobriety Select tiers (use to set expected_product):
- claimed ($600/yr): solo or single-location small centers, ≤10 reviews, minimal web presence
- select ($2,400/yr): small-to-medium operators (sober living, IOP, single-location residential) with active web presence
- premium ($9,600/yr): multi-location operators, large residential, MAT chains, established centers

Output ONLY valid JSON. No preamble, no markdown fences. Never invent facts; use null when unknown. Never reference patient information (PHI)."

Export buildWebsiteAnalyzerUserPrompt(facility: { name; city; state }, html: string): string. Returns a prompt containing facility info, html (sliced to 80_000 chars), and the JSON schema:

{
  "owner_or_clinical_director": { "name": string|null, "title": string|null, "evidence_quote": string|null },
  "team_size_signal": "solo"|"small"|"medium"|"large"|"unknown",
  "expected_product": "claimed"|"select"|"premium",
  "pain_points": {
    "thin_about_page": boolean, "no_team_photos": boolean,
    "stock_photography_only": boolean, "no_outcomes_data": boolean,
    "broken_or_no_https": boolean, "no_schema_markup": boolean,
    "no_reviews_mentioned": boolean, "weak_seo_title": boolean
  },
  "services_listed": string[], "insurance_listed": string[],
  "estimated_bed_count": number|null,
  "legitscript_mentioned": boolean
}

STOP.
```

**Acceptance:** Compiles. No Claude calls happen yet — purely prompt strings.

---

### Prompt 2.3 — Intelligence signals service (NEW)

```
Create ONLY src/pipeline/signals.ts AND src/shared/serpapi.ts.

This prompt implements the three new intelligence signals from PRD §9.3 stage 4.

src/shared/serpapi.ts:
Export `serpapi(query: string, num = 5): Promise<{ link?: string; title?: string; snippet?: string }[]>`.
POST https://google.serper.dev/search with header `X-API-KEY: {env SERPER_API_KEY}`, header `Content-Type: application/json`, JSON body `{ q: query, num }`.
Return `organic` array (or [] on error). Log to AuditLog on error, return []. Function/file/audit-action names kept as `serpapi` for call-site stability — see in-file migration comment.

src/pipeline/signals.ts:
Export `detectSignals(facility: { name: string; city: string }, html: string): Promise<Signals>`.

Type Signals:
{
  competingDirectories: { psychologyToday: boolean; rehabsCom: boolean; recoveryCom: boolean; missingFromAll: boolean };
  hiring: { active: boolean; roleTitles: string[]; rolesPostedRecently: number };
  techStack: { hubspot: boolean; salesforce: boolean; callrail: boolean; googleAds: boolean; facebookPixel: boolean; marketo: boolean; bigSpenderScore: number };
}

Implementation:

A. Directory checks — 3 parallel Serper calls (Promise.all):
   - serpapi(`site:psychologytoday.com "${facility.name}" ${facility.city}`)
   - serpapi(`site:rehabs.com "${facility.name}" ${facility.city}`)
   - serpapi(`site:recovery.com "${facility.name}" ${facility.city}`)
   Boolean = (results.length > 0 && first result's title/snippet contains facility.name case-insensitive).
   missingFromAll = !pt && !rc && !rec.

B. Hiring activity — 1 Serper call:
   - serpapi(`site:linkedin.com/jobs "${facility.name}"`, 10)
   active = results.length > 0.
   roleTitles = extract titles, strip " - " and trailing company name, dedupe, max 5.
   rolesPostedRecently = same as results.length (we don't have post dates without LinkedIn API, so this is just the count).

C. Tech stack — regex over HTML (no API call):
   const TECH_PATTERNS = {
     hubspot: /<script[^>]+src=[^>]*(?:js\.hs-scripts|js\.hsforms|js\.hsanalytics)/i,
     salesforce: /<script[^>]+src=[^>]*(?:salesforceliveagent|pardot\.com|force\.com)/i,
     callrail: /<script[^>]+src=[^>]*(?:callrail\.com|cdn\.callrail)/i,
     googleAds: /<script[^>]+src=[^>]*googleadservices\.com\/pagead\/conversion/i,
     facebookPixel: /<script[^>]+src=[^>]*connect\.facebook\.net/i,
     marketo: /<script[^>]+src=[^>]*munchkin\.marketo\.net/i,
   };
   For each: test() against html. Count trues = bigSpenderScore (0-6).

Return all three blocks. The whole function is sequential: directories first (parallel), then hiring, then techStack (synchronous regex).

Under 120 lines.

STOP.
```

**Acceptance:** Call `detectSignals({ name: 'Hope Haven', city: 'Asheville' }, '<html>...</html>')` against a fixture — returns valid Signals object. Try with a known facility that’s on Psychology Today (e.g., a major rehab chain) → psychologyToday=true.

---

### Prompt 2.4 — Enrichment pipeline (combines all signals)

```
Create ONLY src/pipeline/enrich.ts AND src/scripts/enrichAll.ts.

src/pipeline/enrich.ts:
Export `enrichLead(leadId: string): Promise<void>`.

Flow:
1. Load lead via Prisma. Skip if Enrichment row already exists.
2. If lead.website is null:
   - Write Enrichment with painPoints: { no_website: true }, signals: { /* empty defaults */ }, expectedProduct: 'claimed'.
   - Return.
3. fetchSite(lead.website). If null:
   - Write Enrichment with painPoints: { broken_or_slow: true }, signals: { /* empty defaults */ }, expectedProduct: 'claimed'.
   - Return.
4. Call claude.messages.create with model 'claude-sonnet-4-5-20250929', max_tokens 2048, temperature 0, system: WEBSITE_ANALYZER_SYSTEM, messages: [{ role: 'user', content: buildWebsiteAnalyzerUserPrompt(lead, html) }].
5. extractJSON. On parse failure: retry once with appended "Output ONLY raw JSON, no preamble, no fences." On second failure: AuditLog 'enrich.claude.parse-failed' and return.
6. Call detectSignals({ name: lead.name, city: lead.city }, html) → signals.
7. Tier adjustment based on signals (PRD §9.3):
   - If signals.techStack.bigSpenderScore >= 3 → upgrade expectedProduct (claimed→select→premium, capped at premium)
   - If signals.hiring.active → upgrade by one notch (capped at premium)
   - If signals.competingDirectories.missingFromAll AND analyzed.expected_product === 'premium' → no change (premium already)
8. findLinkedIn lookup if ownerName populated (next prompt creates findLinkedIn).
9. Write Enrichment row with all fields populated.

src/scripts/enrichAll.ts:
Pulls all leads where Enrichment is null. Process 5 concurrent (write a small inline concurrency helper — no new dependency). Sleep 1s between batches. Cap at 200 leads per run to control Serper spend.

Under 150 lines total across both files.

STOP.
```

**Acceptance:** Run on 20 SAMHSA leads → ≥15 Enrichment rows created. Each has populated `signals` JSON (even if all false). At least 1 has hiring.active=true or a non-zero bigSpenderScore (because real treatment centers have these).

---

### Prompt 2.5 — Serper LinkedIn lookup (and integrate into enrich)

```
Edit src/shared/serpapi.ts to add ONE new export, AND edit src/pipeline/enrich.ts to use it.

In src/shared/serpapi.ts, add:
Export `findLinkedIn(ownerName: string, facilityName: string, city: string): Promise<string | null>`.

Logic:
1. Primary query: serpapi(`site:linkedin.com/in/ "${ownerName}" "${facilityName}"`, 5)
2. If first result's link starts with "https://www.linkedin.com/in/" or "https://linkedin.com/in/", return it.
3. Otherwise, fallback query: serpapi(`site:linkedin.com/in/ "${ownerName}" ${city} addiction treatment`, 5). Same check.
4. Return null if both fail.

In src/pipeline/enrich.ts, in the flow at step 8 (between signals and writing Enrichment):
If analyzed.owner_or_clinical_director?.name is non-null, call findLinkedIn(name, lead.name, lead.city) and use the result for Enrichment.ownerLinkedIn. Otherwise null.

STOP.
```

**Acceptance:** For 5 enriched leads with owner names → ≥2 LinkedIn URLs found and stored.

---

## Phase 3 — Cold Drafting

### Prompt 3.1 — Tier + signals-aware cold email prompts

```
Create ONLY src/prompts/coldEmail.ts.

Export three things:

1. COLD_EMAIL_SYSTEM — system prompt string. Content:

"You write cold B2B emails to addiction-treatment-center owners and clinical directors on behalf of Sobriety Select, a curated treatment directory operated by Cardwell-Beach LLC.

You will receive: prospect facts, the expected Sobriety Select tier for this prospect, AND intelligence signals (competing directories, hiring activity, marketing tech stack).

TIER ANGLES:
- claimed ($600/yr): low-friction first step. 'Let's get you visible without a big commitment.' Acknowledge their size honestly. Don't oversell.
- select ($2,400/yr): the workhorse tier. 'Enhanced presence + lead routing for growing centers.' Note they're past basics.
- premium ($9,600/yr): top-of-directory + premium support. 'For serious operators competing on visibility.' Reference their scale or quality.

INTELLIGENCE SIGNAL ANGLES (use one if relevant — these are gold):
- missing from competing directories → FOMO hook: 'Local family searches route entirely to your competitors right now.'
- actively hiring → expansion hook: 'Saw you're hiring [role] in [city] — perfect timing to keep that pipeline full.'
- big spender tech stack (HubSpot/Salesforce/CallRail/etc.) → fit hook: 'Since you already run [tool], our referral tags pipe directly in — zero new infra.'

HARD RULES:
1. ≥60% of body must reference THIS prospect specifically (facility name, city, owner, review count, specific signal, specific service).
2. NO generic openers ('Hope this finds you well', 'I came across your website').
3. Lead with ONE specific observation — not three weak ones. Prioritize signal-based observations over generic pain points when available.
4. Subject: max 6 words, lowercase, no questions, no spam hype.
5. Body: 80–130 words. One short paragraph or two micro-paragraphs.
6. End with ONE soft CTA matching tier:
   - claimed: 'worth 5 mins to walk through?'
   - select: 'open to a 15-min look next week?'
   - premium: 'would Tuesday or Wednesday work for a brief call?'
7. Never claim outcomes data. Never reference PHI.
8. Banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge, world-class.

Output ONLY valid JSON. No preamble, no markdown fences.
Schema: { \"subject\": string, \"body\": string, \"specific_facts_used\": string[] }"

2. COLD_EMAIL_EVALUATOR_SYSTEM — system prompt string. Content:

"You are a strict cold-email QA reviewer. Score the email's prospect-specific personalization as a percentage of body content.

SPECIFIC = names, places, numbers, signals, or observations unique to THIS prospect (facility name, city, review count, owner name, specific service, hiring fact, competing-directory observation, tech-stack reference).
GENERIC = anything that could be sent to any treatment center.

Output ONLY valid JSON, no fences.
Schema: { \"specific_sentences\": string[], \"generic_sentences\": string[], \"personalization_pct\": number, \"reasoning\": string }"

3. buildColdEmailUser(lead, enrichment) — function. Returns a string.

Logic:
- Rank painPoints by strategic value: ['no_outcomes_data','no_reviews_mentioned','weak_seo_title','stock_photography_only','thin_about_page','no_team_photos','no_schema_markup','broken_or_no_https']. Take top 2 that are true.
- Build a structured context object: { facility, city, state, website, googleRating, googleReviews, services, owner: { name, title, linkedin } | null, teamSize, topPainPoints, signals: enrichment.signals, evidenceQuote }
- Return a string:

  "Prospect facts:\n" + JSON.stringify(context, null, 2) + "\n\nEXPECTED PRODUCT TIER: " + enrichment.expectedProduct + "\n\nWrite the email per the tier's angle. If any intelligence signal is high-leverage (missing from competing directories, active hiring, or big spender tech stack), prefer it as your lead observation."

STOP.
```

**Acceptance:** Prompts compile. No Claude calls.

---

### Prompt 3.2 — Cold email drafter + batch script

```
Create ONLY src/outreach/draftCold.ts, src/shared/guessEmail.ts, AND src/scripts/draftColdBatch.ts.

src/shared/guessEmail.ts:
Export `guessEmail(ownerName: string|null, website: string|null): string|null`.
- If !website: return null.
- Extract domain: strip protocol + path, take hostname, remove 'www.'.
- If ownerName: split on whitespace, take firstName lowercased, return `${firstName}@${domain}`.
- Else: return `info@${domain}`.

src/outreach/draftCold.ts:
Export `draftColdEmail(leadId: string): Promise<string | null>` — returns Draft.id on success, null on failure.

Flow:
1. Load lead + enrichment. If !enrichment, return null. If existing Draft with kind='cold' and not status='rejected', return null.
2. Compute targetEmail: enrichment.ownerEmail || guessEmail(enrichment.ownerName, lead.website). If null, AuditLog 'draftCold.no-email' and return null.
3. Check Suppression { email: targetEmail }. If exists, AuditLog 'draftCold.suppressed' and return null.
4. STAGE A — Generate:
   - claude.messages.create with model 'claude-sonnet-4-5-20250929', max_tokens 1024, temperature 0.7, system: COLD_EMAIL_SYSTEM, messages: [{ role: 'user', content: buildColdEmailUser(lead, enrichment) }]
   - extractJSON → { subject, body, specific_facts_used }
5. STAGE B — Evaluate:
   - claude.messages.create with model 'claude-sonnet-4-5-20250929', max_tokens 512, temperature 0.3, system: COLD_EMAIL_EVALUATOR_SYSTEM, messages: [{ role: 'user', content: `Email body:\n${body}\n\nProspect facts:\n${JSON.stringify({lead, enrichment}, null, 2)}` }]
   - extractJSON → { personalization_pct }
6. If pct < 60:
   - Retry Stage A once with appended user message: "Previous attempt scored ${pct}%. Increase prospect-specific references to ≥60%. Reference at least one intelligence signal if present (hiring, missing directories, tech stack)."
   - Re-evaluate.
   - If still <60: AuditLog 'draftCold.score-too-low' and return null.
7. Persist Draft: { leadId, kind: 'cold', subject, body, personalizationPct: pct, specificFacts: specific_facts_used, status: 'pending' }.
8. Return draft.id.

src/scripts/draftColdBatch.ts:
- Pull 30 leads where:
  - Enrichment exists
  - No existing Draft of kind='cold' with status NOT IN ('rejected')
  - Either enrichment.ownerEmail OR guessEmail(...) is non-null
  - Not in Suppression
- Process with concurrency 3, 1s pacing between batches.
- AuditLog 'cron.success' / 'cron.failure' at end.

STOP.
```

**Acceptance:** Run script → 30 Draft rows in `status='pending'`, mostly `personalizationPct >= 60`. At least 3 reference an intelligence signal (you’ll see this in the body).

---

## Phase 4 — HubSpot Sync

### Prompt 4.1 — HubSpot client wrapper

```
Create ONLY src/shared/hubspot.ts.

Install @hubspot/api-client (npm install @hubspot/api-client).

Auth: we use a HubSpot Service Key, not a private app. Token goes in HUBSPOT_ACCESS_TOKEN and authenticates identically via the bearer header — no code difference. Scopes are configured on the Service Key in the HubSpot UI.

Export const hs = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN }).

Export hsRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T>. On 429/502/503: exponential backoff capped at 30s. Otherwise rethrow.

Output the required Service Key scopes (paste into the file as a top comment):
- crm.objects.contacts.read, crm.objects.contacts.write
- crm.objects.companies.read, crm.objects.companies.write
- crm.objects.deals.read, crm.objects.deals.write
- crm.schemas.contacts.read, crm.schemas.companies.read, crm.schemas.deals.read
- crm.schemas.contacts.write, crm.schemas.companies.write, crm.schemas.deals.write   (required by Prompt 4.2 setupHubspotCustomProperties.ts to create custom properties; HubSpot returns 403 MISSING_SCOPES on /crm/v3/properties without the write scope, even for GET)
- sales-email-read
- crm.objects.owners.read   (granular owners scope — the legacy `settings.users.read` no longer satisfies /crm/v3/owners on a Service Key)

STOP.
```

**Acceptance:** Compiles. Sonia configures these scopes on the HubSpot Service Key manually (HubSpot UI → Settings → Integrations → Private Apps and Service Keys → edit the Service Key → Scopes tab).

---

### Prompt 4.2 — HubSpot custom properties setup

```
Create ONLY src/scripts/setupHubspotCustomProperties.ts.

Idempotent one-shot. For each property below, GET first; on 404 POST to create; on 200 skip with "exists" log.

Company custom properties (groupName: 'sobrietyselect'):
- ss_source (enumeration: samhsa, gmaps, psychtoday)
- ss_google_rating (number)
- ss_google_reviews (number)
- ss_expected_product (enumeration: claimed, select, premium)
- ss_pain_points (string, multi-line)
- ss_signals (string, multi-line — stores JSON.stringify of signals)
- ss_legitscript_status (string)

Contact custom properties:
- ss_linkedin_url (string, single-line)

Deal custom properties:
- ss_renewal_date (date)
- ss_product_type (enumeration: claimed, select, premium, seo, social, ppc, upsell-bundle)

Use hs.crm.properties API: hs.crm.properties.coreApi.getByName(objectType, name) for the GET check, hs.crm.properties.coreApi.create(objectType, propertyCreate) for the POST.

Wrap each call in hsRetry. 100ms pacing.

STOP.
```

**Acceptance:** Run twice — first run creates properties, second run says “exists” for all. HubSpot UI shows the new fields.

---

### Prompt 4.3 — HubSpot upsert

```
Create ONLY src/pipeline/hubspotSync.ts AND src/scripts/syncToHubspot.ts.

src/pipeline/hubspotSync.ts:
Export `syncLeadToHubspot(leadId: string): Promise<{ companyId: string; contactId: string | null }>`.

Flow:
1. Load lead + enrichment.
2. Extract domain from lead.website. If null, AuditLog and skip.
3. Upsert company:
   - Search via hs.crm.companies.searchApi.doSearch with filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }]}].
   - If found, hs.crm.companies.basicApi.update(id, properties).
   - Else hs.crm.companies.basicApi.create({ properties }).
   Properties:
   {
     name: lead.name, domain, city: lead.city, state: lead.state, phone: lead.phoneE164 ?? '',
     industry: 'Health Care: Addiction Treatment', lifecyclestage: 'lead',
     ss_source: lead.source,
     ss_google_rating: lead.googleRating?.toString() ?? '',
     ss_google_reviews: lead.googleReviews?.toString() ?? '',
     ss_expected_product: enrichment.expectedProduct ?? 'claimed',
     ss_pain_points: JSON.stringify(enrichment.painPoints),
     ss_signals: JSON.stringify(enrichment.signals),
     ss_legitscript_status: enrichment.legitscriptStatus ?? 'unknown',
   }
4. If enrichment.ownerEmail OR guessEmail returns non-null:
   - Upsert contact by email. Properties: email, firstname, lastname (split ownerName), jobtitle: enrichment.ownerTitle ?? '', hs_lead_status: 'NEW', ss_linkedin_url: enrichment.ownerLinkedIn ?? ''
   - Associate contact → company via hs.crm.companies.associationsApi.create(companyId, 'contacts', contactId, [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }])
5. Update lead.hubspotCompanyId.
6. Every HubSpot call wrapped in hsRetry. 100ms pacing.

src/scripts/syncToHubspot.ts:
Find all leads with enrichment but no hubspotCompanyId. Sync concurrency 5.

STOP.
```

**Acceptance:** Run on 5 enriched leads → 5 HubSpot companies appear with all `ss_`* fields populated, including ss_signals as a JSON string.

---

## Phase 5 — Approval Queue UI

### Prompt 5.1 — Auth middleware and queue routes (signals-aware)

```
Create ONLY src/middleware/queueAuth.ts AND src/ui/queue.ts. Mount queueRouter in src/server.ts.

src/middleware/queueAuth.ts:
Export const queueAuth: Express middleware.
- Check req.query.pw OR req.headers['x-queue-pw'] OR cookie 'qpw' against process.env.QUEUE_PASSWORD.
- If mismatch: res.status(401).json({ error: 'unauthorized' }).
- Else: next().

src/ui/queue.ts:
Export const queueRouter = express.Router().

GET /queue (queueAuth):
- Pull Drafts where status='pending', max 30, sorted by createdAt DESC OR by expectedCommission DESC if ?sort=value
- For each draft, join lead and enrichment
- Compute commission preview from enrichment.expectedProduct: {claimed:60, select:240, premium:960}
- Render server-side HTML (single inline <style>, no framework, max-width 760px)

For each draft, render a card containing:
- Lead name + city + state (website link if present)
- Owner: name + LinkedIn link if present
- Top 2 pain points as small gray badges
- Signals line below: 
  * if signals.competingDirectories.missingFromAll → "🎯 Missing from PT + Rehabs + Recovery.com"
  * if signals.hiring.active → "📈 Hiring " + signals.hiring.roleTitles.slice(0,2).join(', ')
  * if signals.techStack.bigSpenderScore >= 2 → "💰 " + signals.techStack.bigSpenderScore + " marketing tools detected"
- Commission badge: "$60 Claimed" / "$240 Select" / "$960 Premium" — colored by tier (claimed gray, select blue, premium gold)
- personalizationPct badge: green ≥70, yellow 60-69, red <60
- Editable input for subject, textarea (12 rows) for body
- Two submit buttons in a tiny form: Approve (POST /approve/:id, which always diff-and-saves any subject/body edits) and Reject (POST /reject/:id with reason input). The textarea is always editable — clicking Approve persists whatever's in it; there is no separate "Edit & Approve" button (removed in v1.2 as redundant)

Top of page:
- Pending count
- Sort dropdown: Newest | Commission value (high to low)
- "Approve all visible" button with inline JS 3-second hold-to-confirm (mousedown timer; if released early, cancel)

POST /approve/:id (queueAuth):
Body: { subject, body }. Update Draft: subject (if changed), body (if changed), status='approved', approvedBy='sonia'. Write AuditLog. 303 redirect to /queue?pw=...

POST /reject/:id (queueAuth):
Body: { reason }. Update Draft: status='rejected', rejectReason. AuditLog. 303 redirect.

Mount in src/server.ts: app.use('/', queueRouter) AFTER existing /health route.

STOP.
```

**Acceptance:** Hit `/queue?pw=$QUEUE_PASSWORD` → list of cards visible with signal badges. Approve/Reject works. Refresh shows updated state.

---

### Prompt 5.2 — Unsubscribe endpoint

```
Create ONLY src/shared/unsubscribeToken.ts, src/routes/unsubscribe.ts. Mount in src/server.ts.

Install jsonwebtoken (npm install jsonwebtoken @types/jsonwebtoken).

src/shared/unsubscribeToken.ts:
- Export signUnsubToken(email: string): string — jwt.sign({ email }, process.env.UNSUBSCRIBE_SECRET, { expiresIn: '10y' })
- Export verifyUnsubToken(token: string): { email: string } | null — try jwt.verify, return payload or null on error

src/routes/unsubscribe.ts:
Export unsubscribeRouter = express.Router().

GET /unsubscribe?token=...:
- verifyUnsubToken(token). If null: 400 "Invalid or expired link."
- Prisma upsert Suppression { email, reason: 'opt-out' }.
- Render small HTML: "You've been unsubscribed. We won't email you again."

Mount: app.use('/', unsubscribeRouter).

STOP.
```

**Acceptance:** Generate token via Node REPL with signUnsubToken(‘[test@example.com](mailto:test@example.com)’), hit URL → see confirmation, Suppression row exists.

---

### Prompt 5.3 — Stale-paused re-draft on resume (NEW)

```
Edit ONLY src/ui/queue.ts. Add a re-draft action that replaces "↩ Undo" on paused drafts older than 14 days, so resume regenerates with fresh enrichment instead of restoring stale content.

At top of file (with other consts):
const STALE_PAUSE_DAYS = 14;
const DAY_MS = 86_400_000;

Add helper near other helpers:
const isStalePaused = (d: DraftWithRel): boolean =>
  d.status === 'paused' && Date.now() - d.createdAt.getTime() > STALE_PAUSE_DAYS * DAY_MS;

Modify renderUndoRow:
- If isStalePaused(d): render a single button posting to /redraft/${encodeURIComponent(d.id)}, label "↻ Re-draft fresh", class="btn-undo", style override background:#0d9488. onsubmit="return confirm('Discard this stale paused draft so a fresh one is generated tomorrow?')".
- Otherwise: keep current "↩ Undo" button.

Add new route POST /redraft/:id (queueAuth):
- Validate id via existing readId helper.
- prisma.draft.findUnique select { status: true, leadId: true, createdAt: true }. 404 if missing.
- 400 if status !== 'paused' (don't redraft from rejected — those have an explicit reject path already).
- prisma.draft.update → status='rejected', rejectReason='auto-redraft on resume (stale)'.
- prisma.auditLog.create action='queue.redraft-on-resume', entity='Draft', entityId=id, meta={ leadId, ageDays: Math.floor((Date.now() - existing.createdAt.getTime()) / DAY_MS) }.
- res.redirect(303, '/queue').

Why no synchronous re-draft: rejecting unblocks draftColdBatch's eligibility query (it skips on status NOT 'rejected'), so the lead re-enters generation on the next cron tick with current enrichment. Calling draftColdEmail inline here would hold the redirect for ~10s of Claude calls.

STOP.
```

**Acceptance:** Pause a draft, set its `createdAt` to 15 days ago via SQL (`UPDATE "Draft" SET "createdAt" = now() - interval '15 days' WHERE id='...'`), reload `/queue`. Undo zone shows "↻ Re-draft fresh" instead of Undo. Click → row disappears, draft is `status='rejected'` with reason `'auto-redraft on resume (stale)'`, AuditLog has `queue.redraft-on-resume`. Run `draftColdBatch` → lead is eligible again, new pending cold draft appears.

---

## Phase 6 — Sending & Sequencing

### Prompt 6.1 — Gmail OAuth + send

```
Create ONLY src/shared/gmail.ts AND src/scripts/gmailAuth.ts.

Install googleapis (npm install googleapis).

src/shared/gmail.ts:
Export `sendEmail(opts: { to: string; subject: string; body: string; inReplyTo?: string; references?: string }): Promise<string>` returning Gmail message ID.

OAuth2 client built from GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, with credentials.refresh_token = GMAIL_REFRESH_TOKEN. Send as process.env.GMAIL_FROM.

Body construction:
- Append CAN-SPAM footer (blank line + hr + lines):
  Sobriety Select / Cardwell-Beach LLC, 105 Maxess Road, Suite 124, Melville, NY 11747
  Unsubscribe: {PUBLIC_URL}/unsubscribe?token={signUnsubToken(to)}
- Headers set in the raw email:
  - List-Unsubscribe: <{PUBLIC_URL}/unsubscribe?token=...>, <mailto:unsubscribe@sobrietyselect.com>
  - List-Unsubscribe-Post: List-Unsubscribe=One-Click
  - If inReplyTo provided: add In-Reply-To and References

Encode as base64url RFC 2822, call gmail.users.messages.send({ userId: 'me', requestBody: { raw } }).

Return the messageId.

src/scripts/gmailAuth.ts:
Comment at top with usage:
// Run once: tsx src/scripts/gmailAuth.ts
// Then paste the printed refresh_token into GMAIL_REFRESH_TOKEN in .env

Use google-auth-library's authorize() flow with localhost:53682 callback. Print refresh_token. Exit.

STOP.
```

**Acceptance:** Run gmailAuth.ts → OAuth in browser → refresh_token printed. Paste into .env. Test sendEmail to your own address → arrives with footer + List-Unsubscribe header.

---

### Prompt 6.2 — Send approved drafts

```
Create ONLY src/outreach/sender.ts, src/shared/businessDays.ts, AND src/scripts/sendApproved.ts.

src/shared/businessDays.ts:
Export `businessDay(date: Date, addDays: number): Date`. Skip Saturdays and Sundays. Under 20 lines.

src/outreach/sender.ts:
Export `sendApprovedDraft(draftId: string): Promise<void>`.

Flow:
1. Load Draft + Lead + Enrichment. Skip if status !== 'approved'. Skip if kind === 'voicemail' (different code path in Phase 8).
2. Compute targetEmail: enrichment.ownerEmail || guessEmail(enrichment.ownerName, lead.website). If null: AuditLog and update draft.status='sent-suppressed'.
3. Check Suppression { email: targetEmail }. If found: draft.status='sent-suppressed'; AuditLog; return.
4. Call sendEmail({ to: targetEmail, subject: draft.subject, body: draft.body }).
5. Update draft.status='sent', sentAt=now, gmailMessageId.
6. Log HubSpot engagement:
   hs.crm.objects.basicApi.create('emails', {
     properties: { hs_timestamp: Date.now().toString(), hs_email_direction: 'EMAIL', hs_email_subject: subject, hs_email_html: body, hs_email_status: 'SENT', hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '' },
     associations: [associate to contact + company via lead.hubspotCompanyId]
   })
   Save engagement.id to draft.hubspotEmailId.

src/scripts/sendApproved.ts:
Find all Drafts where status='approved', not yet sent, kind !== 'voicemail'. Process with 200ms pacing. AuditLog cron success/failure.

STOP.
```

**Acceptance:** Approve a draft in /queue → next sendApproved run → email arrives at test address → HubSpot engagement appears.

---

### Prompt 6.3 — Follow-up templates

```
Create ONLY src/prompts/followUpTemplates.ts.

Export FOLLOWUP_TEMPLATES — a Record<number, (ctx) => { subject: string; body: string }>.

ctx type: { facility: string; googleReviews?: number; nextQ?: string; phone?: string; signals?: any }

Templates:

2 (T+3d):
subject: 'quick bump'
body: `Bumping this up — saw ${ctx.facility} has ${ctx.googleReviews ?? 'limited'} Google reviews, makes the case for stronger directory presence even stronger.\n\nWorth 10 mins this week?`

3 (T+7d):
subject: 'two quick things'
body: `Last week pinged you about ${ctx.facility}. For context: centers your size typically add 8-15 new family inquiries/month from a Select-tier listing.\n\nOpen to a brief look?`

4 (T+14d):
subject: 'should i circle back'
body: `Should I assume directory visibility isn't a priority right now? Happy to circle back in ${ctx.nextQ ?? 'a few weeks'} — totally fine to say "later."`

5 (T+30d):
subject: 'closing the loop'
body: `Closing the loop on this. If anything changes on ${ctx.facility}'s listing strategy, my line is open: ${ctx.phone ?? '(reply to this email)'}.`

STOP. NO Claude calls in this file.
```

**Acceptance:** Import and call each template — returns sensible strings.

---

### Prompt 6.4 — Sequencer (derives state from Draft history)

```
Create ONLY src/outreach/sequencer.ts AND src/scripts/runSequences.ts.

src/outreach/sequencer.ts:
Export `runSequenceStep(leadId: string): Promise<void>`.

Helper inside (not exported):
async function getSequenceState(leadId: string):
1. Query Drafts where leadId=X, kind IN ('cold','followup-2','followup-3','followup-4','followup-5'), status IN ('sent','auto-sent'). Order by sentAt ASC.
2. If [] return null.
3. Query: any Draft where leadId=X, kind='replied' → if found, return { status: 'replied' }.
4. lastStep = drafts.length (cold=1, +1 per followup-N).
5. lastSentAt = drafts[drafts.length-1].sentAt.
6. intervals (days TO NEXT step): { 1: 3, 2: 4, 3: 7, 4: 16 }.
7. nextStep = lastStep + 1. If nextStep > 5: return { status: 'completed' }.
8. nextSendAt = businessDay(lastSentAt, intervals[lastStep] ?? 3).
9. Return { status: 'active', nextStep, nextSendAt, coldDraft: drafts[0] }.

runSequenceStep flow:
1. state = getSequenceState(leadId). If null OR status !== 'active' OR nextSendAt > now: return.
2. Load lead + enrichment.
3. template = FOLLOWUP_TEMPLATES[state.nextStep].
4. ctx = { facility: lead.name, googleReviews: lead.googleReviews ?? undefined, nextQ: '2-3 weeks', phone: process.env.SONIA_PHONE, signals: enrichment.signals }
5. { subject: tSubject, body } = template(ctx). Final subject = 'Re: ' + state.coldDraft.subject.
6. targetEmail = enrichment.ownerEmail || guessEmail(...). Skip if null.
7. Suppression check. Skip if found.
8. Persist Draft: { leadId, kind: `followup-${state.nextStep}`, subject, body, status: 'auto-sent' }.
9. sendEmail({ to, subject, body, inReplyTo: state.coldDraft.gmailMessageId, references: state.coldDraft.gmailMessageId }) → gmailMessageId.
10. Update draft: sentAt=now, gmailMessageId.
11. Log HubSpot engagement (same shape as sender.ts).

src/scripts/runSequences.ts:
Find leadIds where there's a cold Draft with sentAt < (now - 3 days) AND no Draft kind='replied' for that lead. Call runSequenceStep with 500ms pacing. Cap at 100 per run.

STOP.
```

**Acceptance:** Set a cold draft’s sentAt to 4 days ago manually. Run script → follow-up email arrives in same thread as the original (check Gmail thread view).

---

### Prompt 6.5 — Reply detection

```
Create ONLY src/outreach/replyWatcher.ts, src/prompts/replied.ts, AND src/scripts/checkReplies.ts.

src/prompts/replied.ts:
Export REPLIED_SYSTEM string:
"Draft a short, no-fluff response to this reply. Match their energy. Move toward a 15-min discovery call OR answer their direct question. 60 words max. No greeting fluff, no closing fluff. Match their tone."

Export buildRepliedUser(coldDraft, replyText, lead, enrichment): string. Returns a prompt containing the original cold email, the reply text, and key lead/enrichment context.

src/outreach/replyWatcher.ts:
Export `checkReplies(): Promise<void>`.

Use googleapis Gmail client (reuse the OAuth2 setup from src/shared/gmail.ts — either factor it out or duplicate minimally).

Flow:
1. gmail.users.messages.list({ userId: 'me', q: 'newer_than:30m -from:me', maxResults: 50 }).
2. For each message:
   a. gmail.users.messages.get to load headers (From, In-Reply-To, References, Subject, Message-Id) and the body snippet.
   b. Skip messages where 'From' contains GMAIL_FROM (self-sent).
   c. Detect OOO: subject startsWith 'Out of Office' or 'Automatic reply' OR body contains 'I am out of the office' / 'currently out of the office'. If OOO: AuditLog 'reply.ooo-detected' and skip.
   d. Find matching Draft: Draft.findFirst where gmailMessageId IN (parse In-Reply-To and References — split on whitespace, strip angle brackets).
   e. If matched: generate Draft of kind='replied' via Claude (model 'claude-sonnet-4-5-20250929', max_tokens 512, temperature 0.5, system: REPLIED_SYSTEM, user: buildRepliedUser(...)). Persist with status='pending'. AuditLog 'reply.draft-created'.

src/scripts/checkReplies.ts:
Cron entry. Call checkReplies. AuditLog success/failure.

STOP.
```

**Acceptance:** Reply to a sent email from another address → within 15 min, a Draft kind=‘replied’ appears in /queue. The original sequence’s next touch won’t fire (sequencer detects replied=true).

---

### Prompt 6.6 — Manual nudge + awaiting-reply queue section (NEW)

```
Create ONLY src/prompts/nudge.ts AND src/outreach/draftNudge.ts. Edit src/ui/queue.ts to add (A) a Nudge button on paused undo-rows, (B) a new "💤 Sent — awaiting reply 10+ days" section, and (C) the POST /nudge/:leadId route shared by both surfaces. Goal: zero manual memory needed to know which leads are due for a follow-up nudge.

src/prompts/nudge.ts:
Export NUDGE_SYSTEM:
"Write a short check-in to a treatment-center prospect we recently corresponded with but who has gone quiet. Reference the prior thread vaguely ('after our chat last week', 'following up on my note'). One specific value-prop hook tied to a known fact about THEIR facility (named missing directory, hiring role, detected tech, owner name). End with a clear ask: 15-min call OR a yes/no question. 60 words max. No greeting fluff. No 'just checking in'. No pricing, no tier names ('Claimed', 'Select', 'Premium'), no dollar amounts.

Output ONLY valid JSON. No preamble, no markdown fences. Schema: { \"subject\": string, \"body\": string }"

Export buildNudgeUser(lead, enrichment, priorDraftBody): string. Structured key:value block with facility name, city, state, top 1-2 strongest signals (hiring/competingDirectories/techStack from enrichment.signals), and the prior draft body verbatim under "Prior thread tone reference:".

src/outreach/draftNudge.ts:
Export draftNudge(leadId: string): Promise<string | null>.

Mirror the prisma adapter, cached() helper, audit() helper, and zod parsing setup from src/outreach/draftCold.ts.

Flow:
1. Fetch lead include enrichment. Return null if missing.
2. If lead.doNotContact → audit('draftNudge.do-not-contact', leadId, {}), return null.
3. priorDraft = prisma.draft.findFirst where leadId, status IN ('sent','paused'), orderBy createdAt desc. If null → audit('draftNudge.no-prior-draft', leadId, {}), return null.
4. claude.messages.create model 'claude-sonnet-4-5-20250929', max_tokens 512, temperature 0.6, system cached(NUDGE_SYSTEM), single user message buildNudgeUser(lead, enrichment, priorDraft.body).
5. extractJSON → zod parse z.object({ subject: z.string(), body: z.string() }).
6. scanLeaks(body, [lead.name]) → on hits, audit('draftNudge.leak-detected', leadId, { hits }), return null.
7. prisma.draft.create kind='nudge', status='pending', subject, body, specificFacts=[], personalizationPct=null. Return draft.id.

No evaluator step (nudges are short and approval-gated; saves a Claude call).

src/ui/queue.ts edits:

Add at top with other consts:
const REPLY_SILENCE_DAYS = 10;
(Reuse existing DAY_MS constant added in Prompt 5.3.)

(A) Nudge button on paused undo-rows:
In renderUndoRow, when d.status === 'paused' (regardless of stale), append a "↻ Nudge" button next to the existing restore button (Undo OR Re-draft fresh — both keep their normal behavior). Form POST to /nudge/${encodeURIComponent(d.lead.id)}, class="btn-undo" with style override background:#0d9488. onsubmit="return confirm('Generate a nudge draft for this lead? The current paused draft will be archived.')".

(B) New "💤 Sent — awaiting reply 10+ days" section:
- Refactor renderKillLeadForm to expose a helper renderKillLeadFormById(leadId: string): string used by both renderKillLeadForm(d) and the new awaiting-reply rows. No behavior change.
- Add to the GET /queue Promise.all:
    const tenDaysAgoMs = Date.now() - REPLY_SILENCE_DAYS * DAY_MS;
    const tenDaysAgo = new Date(tenDaysAgoMs);
  prisma.lead.findMany where:
    doNotContact: false,
    drafts: {
      some: { status: 'sent' },
      none: { OR: [
        { status: { in: ['pending','approved','paused'] } },
        { status: 'sent', sentAt: { gt: tenDaysAgo } },
        { kind: 'nudge', createdAt: { gt: tenDaysAgo } },
      ] },
    },
  include: { enrichment: true, drafts: { where: { status: 'sent' }, orderBy: { sentAt: 'desc' }, take: 1, select: { sentAt: true, kind: true } } }
  take: FETCH_CAP.
- prisma.lead.count with the same where (totalAwaitingReply).
- Sort the fetched leads in JS by drafts[0].sentAt asc (oldest silence first).
- Slice to PAGE_SIZE for display.
- Render section between Approved and Undo zones. Title: `💤 Sent — awaiting reply ${REPLY_SILENCE_DAYS}+ days <span class="count">(${totalAwaitingReply})</span>`. If totalAwaitingReply === 0, omit the section entirely (mirror the existing undo-section pattern).
- Each row: lead name, "City, State", "Last sent N days ago" (Math.floor((Date.now() - drafts[0].sentAt.getTime()) / DAY_MS)), then two buttons: Nudge (POST /nudge/:leadId, confirm "Generate a nudge draft for this lead?") and renderKillLeadFormById(lead.id, lead.name). Reuse the existing .undo-row / .undo-info / .undo-actions classes.
- Update top-meta line: include `${totalAwaitingReply} awaiting reply` between approved-count and the to-undo link, with an anchor to #awaiting-reply when > 0. Give the section id="awaiting-reply".

(C) POST /nudge/:leadId route:
- queueAuth, validate leadId param string non-empty (400 otherwise).
- newId = await draftNudge(leadId). If null → res.redirect(303, '/queue?nudge=skipped').
- prisma.draft.updateMany where leadId AND status='paused' → { status: 'rejected', rejectReason: 'Superseded by nudge draft' }. Capture {count}. (No-op cleanly when there are no paused drafts — the awaiting-reply path leaves the original sent draft untouched.)
- prisma.auditLog.create action='queue.nudge-generated', entity='Lead', entityId=leadId, meta={ newDraftId: newId, supersededCount: count }.
- res.redirect(303, '/queue').

STOP.
```

**Acceptance:**
1. Pause a cold draft on lead A, click "↻ Nudge" in the undo zone → new pending draft kind='nudge' appears in Pending Review with a sensible subject + body, no pricing leaks. The previously paused draft is now status='rejected' reason 'Superseded by nudge draft'. AuditLog has 'queue.nudge-generated' with supersededCount=1.
2. On lead B with a sent cold draft 11+ days old and no pending/paused/approved drafts and no recent nudge, /queue shows lead B in the "💤 Sent — awaiting reply" section with "Last sent 11 days ago". Click Nudge → new pending nudge appears, lead B disappears from the awaiting-reply section. AuditLog 'queue.nudge-generated' with supersededCount=0.
3. Lead with doNotContact=true does not appear in awaiting-reply, and direct POST /nudge/:leadId redirects without creating a draft and writes 'draftNudge.do-not-contact'.

---

## Phase 7 — Pipeline Scoring & Daily Brief

### Prompt 7.1 — Score open deals

```
Create ONLY src/pipeline/scoring.ts AND src/scripts/scorePipeline.ts.

src/pipeline/scoring.ts:
Export `scoreAllDeals(): Promise<void>`.

Hardcoded at top:
const COMMISSION_BY_PRODUCT: Record<string, number> = {
  'claimed': 60, 'select': 240, 'premium': 960,
  'seo': 900, 'social': 600, 'ppc': 900, 'upsell-bundle': 1250
};

Flow:
1. Fetch open deals: hs.crm.deals.searchApi.doSearch with filter dealstage NOT IN ('closedwon','closedlost'). Properties to return: dealname, dealstage, amount, hs_lastmodifieddate, notes_last_contacted, hs_email_last_open_date, ss_product_type, hubspot_owner_id. Use hsRetry. Paginate via after.
2. For each deal:
   - Base score 50
   - daysSinceContact = (now - notes_last_contacted) / 86400000 (or 999 if null)
   - if daysSinceContact > 7: score -= (daysSinceContact - 7) * 2
   - if daysSinceContact < 2: score += 10
   - stageAge = (now - dealstage transition date — approximated from hs_lastmodifieddate since we don't get stage history without paid HubSpot)
   - if stageAge > 14: score -= (stageAge - 14)
   - hs_email_last_open_date within 48h → score += 15
   - Clamp 0-100
3. expectedCommission = COMMISSION_BY_PRODUCT[deal.ss_product_type] ?? 240
4. reasons: array of human-readable strings (e.g., "Stalled 21d in stage", "Email opened yesterday", "Premium-tier prospect — $960 commission")
5. Write Score row.

src/scripts/scorePipeline.ts:
Cron entry. AuditLog success/failure.

STOP.
```

**Acceptance:** Run after creating 3 test deals at varied stages and ss_product_type → Score rows show varied scores AND varied expectedCommission per tier.

---

### Prompt 7.2 — Daily brief email

```
Create ONLY src/outreach/dailyBrief.ts, src/prompts/dailyBrief.ts (optional helper), AND src/scripts/sendDailyBrief.ts.

src/outreach/dailyBrief.ts:
Export `sendDailyBrief(): Promise<void>`.

Flow:
1. Pull latest Score per hubspotDealId, last 24h. Dedupe in memory, keep latest by scoredAt.
2. Hot leads = top 5 sorted by (score * expectedCommission) DESC.
3. At-risk = top 3 where any reason contains "Stalled", sorted by stage age DESC (derive from reasons or fetch HubSpot).
4. Suggested call list = top 5 with phone numbers, US business-hour hint by state TZ (just a rough guess — east coast morning, west coast afternoon).
5. Queue depth: prisma.draft.count where status='pending'.
6. Yesterday's metrics: emails sent (Draft count status='sent' OR 'auto-sent' in last 24h), replies received (Draft count kind='replied' in last 24h), meetings booked (HubSpot meetings count today — hs.crm.objects.meetings.basicApi.getPage filtered by createdate).
7. Render markdown:

   # 📊 Pipeline brief — {date}
   ## 🔥 Top 5 hot leads (sorted by score × commission)
   ...
   ## ⚠️ Top 3 deals at risk
   ...
   ## 📞 Suggested call list (tomorrow)
   ...
   ## 📥 Queue: {N} pending
   ## 📈 Yesterday: sent {X} | replies {Y} | meetings {Z}

8. sendEmail to process.env.BRIEF_RECIPIENT. Subject: `📊 Pipeline brief — ${date}`.

src/scripts/sendDailyBrief.ts:
Cron entry.

STOP.
```

**Acceptance:** Run manually → markdown brief arrives at BRIEF_RECIPIENT inbox. Top leads correctly sorted by score × commission.

---

## Phase 8 — Voicemail Drops

### Prompt 8.1 — Twilio + ElevenLabs

```
Create ONLY src/shared/twilio.ts AND src/shared/eleven.ts.

Install twilio (npm install twilio).

src/shared/twilio.ts:
- Export const twilio = Twilio(env, env)
- Export `isLandline(phoneE164: string): Promise<boolean>`:
  const r = await twilio.lookups.v2.phoneNumbers(phoneE164).fetch({ fields: 'line_type_intelligence' });
  return (r.lineTypeIntelligence as any)?.type === 'landline';

src/shared/eleven.ts:
Export `renderVoicemailMp3(text: string): Promise<Buffer>`:
POST https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128
Headers: xi-api-key, Content-Type: application/json
Body: { text, model_id: 'eleven_turbo_v2_5' }
On !response.ok throw. Return Buffer.from(await response.arrayBuffer()).

STOP.
```

**Acceptance:** isLandline returns true for a known landline number, false for a mobile. renderVoicemailMp3 returns non-empty buffer.

---

### Prompt 8.2 — Voicemail drop service + Twilio webhook routes

```
Create ONLY src/prompts/voicemailScript.ts, src/outreach/voicemail.ts, src/routes/twilioHooks.ts, AND src/scripts/dropVoicemails.ts. Mount twilioHooks in src/server.ts.

src/prompts/voicemailScript.ts:
Export VOICEMAIL_SCRIPT_SYSTEM:
"Write a 25-second voicemail script for a cold call to a treatment-center owner. Mention the facility by name and city. If owner first name is known, use it. Lead with ONE specific observation about their listing, reviews, hiring activity, or directory presence. End with: 'Call me back at {PHONE}.' Max 65 words. Natural spoken cadence — avoid written-only phrases. No PHI."

Export buildVoicemailScriptUser(lead, enrichment, phone): string with structured context including signals.

src/outreach/voicemail.ts:
Export `dropVoicemail(leadId: string): Promise<void>`.

Flow:
1. Load lead + enrichment. Skip if !lead.phoneE164, lead.doNotContact, or Suppression { phoneE164 } exists.
2. If existing Draft of kind='voicemail' for this lead with status NOT IN ('rejected'): return.
3. await isLandline(lead.phoneE164). If false: Persist Draft { kind:'voicemail', body:'(skipped — mobile)', status: 'voicemail-skipped-mobile' }. AuditLog. Return.
4. Build script via Claude: model 'claude-sonnet-4-5-20250929', max_tokens 200, temp 0.6, system: VOICEMAIL_SCRIPT_SYSTEM, user: buildVoicemailScriptUser(lead, enrichment, process.env.SONIA_PHONE). extractJSON or extractText (script is plain text — use extractText).
5. mp3 = await renderVoicemailMp3(script).
6. Persist Draft: { leadId, kind:'voicemail', body: script, audioMp3: mp3, status: 'pending' } — voicemail goes through /queue for approval.

After approval (sender.ts already routes voicemail kind differently — add the branch):
7. In src/outreach/sender.ts: if draft.kind === 'voicemail' AND status === 'approved' AND draft.twilioCallSid is null:
   call = await twilio.calls.create({
     to: lead.phoneE164,
     from: process.env.TWILIO_FROM_NUMBER,
     machineDetection: 'DetectMessageEnd',
     machineDetectionTimeout: 30,
     statusCallback: `${process.env.PUBLIC_URL}/webhook/twilio/status?draftId=${draft.id}`,
     url: `${process.env.PUBLIC_URL}/webhook/twilio/twiml?draftId=${draft.id}`,
   });
   Update draft.twilioCallSid = call.sid, status='voicemail-dropped'.

src/routes/twilioHooks.ts:
Export twilioRouter = express.Router(). (No queueAuth — Twilio fetches these unauthenticated.)

POST /webhook/twilio/twiml?draftId=...:
- Load draft.
- if req.body.AnsweredBy?.startsWith('machine'): res.type('text/xml').send(`<Response><Play>${process.env.PUBLIC_URL}/audio/${draftId}</Play></Response>`)
- Else: res.type('text/xml').send('<Response><Hangup/></Response>')

POST /webhook/twilio/status?draftId=...:
- Body contains CallStatus, AnsweredBy, etc.
- AuditLog 'voicemail.status' with all body fields.
- If CallStatus === 'completed' AND AnsweredBy?.startsWith('machine'): ensure draft.status='voicemail-dropped'.
- Log HubSpot call engagement via hs.crm.objects.basicApi.create('calls', { properties: { hs_timestamp: Date.now().toString(), hs_call_direction: 'OUTBOUND', hs_call_status: req.body.CallStatus, hs_call_disposition: AnsweredBy === 'machine_end_beep' ? 'connected' : 'no-answer', hubspot_owner_id: ... }, associations: [...] }).

GET /audio/:draftId:
- Load draft.audioMp3. If null: 404.
- res.set('Content-Type', 'audio/mpeg').send(buffer).

src/scripts/dropVoicemails.ts:
Find leads with approved cold Drafts in last 7 days, lead.phoneE164 != null, no prior Draft of kind='voicemail'. Cap at 50/day. Call dropVoicemail with 1s pacing.

STOP.
```

**Acceptance:** Run dropVoicemails with own phone as test target lead → voicemail draft appears in /queue. Approve it → voicemail arrives on phone within 1 minute. HubSpot call engagement logged.

---

## Phase 9 — Lifecycle Drafts

### Prompt 9.1 — Quarterly check-in

```
Create ONLY src/prompts/quarterlyCheckin.ts, src/outreach/quarterlyCheckin.ts, AND src/scripts/quarterlyCheckins.ts.

src/prompts/quarterlyCheckin.ts:
Export QUARTERLY_CHECKIN_SYSTEM:
"Write a short, warm, no-pitch quarterly check-in to a Sobriety Select client. Reference how long they've been with us. Ask ONE specific question about their listing performance or facility's current census. End with a soft offer ('want me to pull your Q{N} listing analytics?'). 70 words max. No sales pitch — just warmth and service.

Output JSON: { \"subject\": string, \"body\": string }"

Export buildQuarterlyUser(deal, lead, enrichment, daysSinceClose): string with structured context.

src/outreach/quarterlyCheckin.ts:
Export `generateQuarterlyCheckins(): Promise<void>`.

Flow:
1. Query HubSpot deals: dealstage='closedwon' AND closedate in any of these windows: (today-95, today-85), (today-185, today-175), (today-275, today-265).
2. For each, check no Draft with kind='quarterly' was created in last 30 days for that lead.
3. Look up lead via company domain.
4. Generate Draft via Claude (sonnet-4, temp 0.6, max 512). extractJSON.
5. Persist status='pending'.

src/scripts/quarterlyCheckins.ts:
Cron entry.

STOP.
```

**Acceptance:** Stage a test closed-won deal with closedate 90 days ago → run → draft appears in /queue.

---

### Prompt 9.2 — Renewal warning

```
Create ONLY src/prompts/renewalWarning.ts, src/outreach/renewalWarning.ts, AND src/scripts/renewalWarnings.ts.

src/prompts/renewalWarning.ts:
Export RENEWAL_WARNING_SYSTEM:
"Write a 60-day pre-renewal email to a Sobriety Select client. Tone: confident, not anxious. Reference their tier and price (from PRD pricing table — values will be injected). Mention one positive metric placeholder using {placeholder} braces Sonia can fill. Offer a brief renewal conversation. 80 words max. End with 2 calendar options.

Output JSON: { \"subject\": string, \"body\": string }"

Export buildRenewalUser(deal, lead, enrichment, renewalDate, tier, tierPrice): string.

src/outreach/renewalWarning.ts:
Export `generateRenewalWarnings(): Promise<void>`.

Pricing const at top:
const TIER_PRICES = { claimed: 600, select: 2400, premium: 9600 };

Flow:
1. Query HubSpot deals: dealstage='closedwon' AND ss_renewal_date between (today+55d, today+65d).
2. For each, no existing Draft kind='renewal' for this lead in last 60 days.
3. Look up lead. Determine tier from ss_product_type or enrichment.expectedProduct.
4. Generate Draft via Claude.
5. Persist status='pending'.

src/scripts/renewalWarnings.ts:
Cron entry.

STOP.
```

**Acceptance:** Stage deal with ss_renewal_date 60 days out → run → draft appears with tier-appropriate language and exact price.

---

### Prompt 9.3 — Reactivation

```
Create ONLY src/prompts/reactivation.ts, src/outreach/reactivation.ts, AND src/scripts/reactivation.ts.

src/prompts/reactivation.ts:
Export REACTIVATION_SYSTEM:
"Write a reactivation email to a treatment-center prospect we last spoke with ~{daysSinceContact} days ago. Open with a fresh angle: a recent industry observation, a new Sobriety Select feature, or a relevant case study (use {placeholder} braces). 80 words max. End with a clear 15-min ask.

Output JSON: { \"subject\": string, \"body\": string }"

Export buildReactivationUser(...).

src/outreach/reactivation.ts:
Export `generateReactivationDrafts(): Promise<void>`.

Flow:
1. Query HubSpot deals: dealstage NOT IN ('closedwon','closedlost') AND hs_lastmodifieddate < (today-30d).
2. For each, check there's an existing Draft for the lead with kind IN ('replied','followup-*') AND no Draft kind='reactivation' in last 60 days.
3. Cap to 10 drafts per week total.
4. Generate Draft via Claude.
5. Persist status='pending'.

src/scripts/reactivation.ts:
Cron entry (runs Mondays).

STOP.
```

**Acceptance:** Stage stale deal (lastmodified >30d ago) with replied Draft history → run → draft appears.

---

### Prompt 9.4 — NEW: Discovery Call Prep Brief Generator

```
Create ONLY src/prompts/prepBrief.ts, src/outreach/prepBrief.ts, AND src/ui/prepBrief.ts. Mount prepBriefRouter in src/server.ts.

src/prompts/prepBrief.ts:
Export PREP_BRIEF_SYSTEM:
"You generate a 5-minute pre-call brief for a B2B SDR (Sonia) at Sobriety Select. The brief must be markdown, scannable in under 60 seconds, and packed with specific facts that make Sonia sound like she's been studying this prospect for hours.

STRUCTURE (use these exact headers):
## One-line summary
{facility}, {bed-count if known}, {city state}, owner {name if known}. Expected tier: {tier} (${commission} commission).

## 🎯 Three sharpest data points
Three bullet items. Prefer signal-based (hiring spike, missing from competing directories, big-spender tech stack) over generic pain points.

## ⚠️ Pain points
Top 3 from the painPoints JSON. One bullet each, ≤ 12 words.

## 📜 Conversation history
1-line summary of last 3 HubSpot engagements (oldest first → newest). If none, say 'No prior contact'.

## ❓ The 3 questions to ask
Specific, open-ended questions based on context. Not generic ('how's business?'). Examples: 'How many of your beds are private-pay vs Medicaid?' 'Your IOP page has no schema markup — is that intentional or a gap?'

## 🛑 Known objections to expect
2-3 likely objections based on the tier they fit. For Select: 'we tried directories before'. For Premium: 'we already spend on Google Ads'. For Claimed: 'is this just SEO bait?'.

## 🎯 The angle to lead with
ONE sentence Sonia uses as her opener. Specific. Drawn from the sharpest data point.

## 💵 Pricing reminder
Exact tier + annual price + Sonia's commission. From PRD pricing table.

Output ONLY the markdown — no preamble."

Export buildPrepBriefUser(lead, enrichment, hubspotEngagements: any[], hubspotDeal: any, commission: number): string. Returns a structured prompt containing all the lead/enrichment/HubSpot context.

src/outreach/prepBrief.ts:
Export `generatePrepBrief(dealId: string): Promise<string>` — returns the markdown brief.

Flow:
1. Fetch HubSpot deal via hs.crm.deals.basicApi.getById(dealId, ['dealname','dealstage','amount','ss_product_type','closedate']).
2. Get associated company: hs.crm.deals.associationsApi.getAll(dealId, 'companies'). Take first companyId.
3. Get company properties (including ss_signals).
4. Find Lead by hubspotCompanyId === companyId. Load Lead + Enrichment from our DB.
5. Get associated contacts: hs.crm.deals.associationsApi.getAll(dealId, 'contacts'). Get their properties.
6. Get last 5 engagements: hs.crm.deals.associationsApi.getAll(dealId, 'engagements'); then fetch each via hs.crm.objects.basicApi.getById('engagements', id, ['hs_engagement_type', 'hs_timestamp', 'hs_engagement_subject', 'hs_engagement_body']). Sort by hs_timestamp DESC, take 5.
7. Commission lookup: TIER_COMMISSIONS = { claimed: 60, select: 240, premium: 960 }; commission = TIER_COMMISSIONS[ss_product_type ?? enrichment.expectedProduct] ?? 240.
8. Generate brief via Claude (sonnet-4, max_tokens 1500, temp 0.4, system: PREP_BRIEF_SYSTEM, user: buildPrepBriefUser(...)). extractText.
9. Persist Draft: { leadId, kind: 'prep-brief', subject: `Prep brief: ${lead.name}`, body: markdown, status: 'sent', sentAt: now }. (Auto-marked sent because it's not outbound.)
10. Return the markdown.

src/ui/prepBrief.ts:
Export prepBriefRouter = express.Router().

GET /prep-brief/:dealId (queueAuth):
- Generate the brief.
- If req.query.send === 'email': sendEmail({ to: process.env.BRIEF_RECIPIENT, subject: `Prep brief: ${lead.name}`, body: brief }). Render confirmation HTML.
- Else: render an HTML page with the markdown rendered to HTML (use a tiny inline markdown-to-HTML helper — split on lines, basic conversions for headers, lists, bold. Don't pull in a dependency for this.) Print-friendly CSS.

Mount in server.ts after queueRouter.

STOP.
```

**Acceptance:** Create a test HubSpot deal associated with a synced Lead. Hit `/prep-brief/{dealId}?pw=...` → markdown-rendered HTML page appears with all 7 sections populated, including signals-based data points. Hit `?pw=...&send=email` → brief arrives at BRIEF_RECIPIENT.

---

### Prompt 9.5 — Signal-triggered upsell cron (NEW)

```
Create ONLY src/prompts/upsell.ts, src/outreach/draftUpsell.ts, AND src/scripts/draftUpsellBatch.ts. No UI button — drafts surface in /queue automatically because kind='upsell' is rendered by the existing pending section.

src/prompts/upsell.ts:
Export UPSELL_SYSTEM:
"Write a short, warm congratulation + upsell hook to a Sobriety Select customer who has shown a NEW growth signal (hiring, expansion, missing from competing directories, expanded tech stack). Open with a specific congratulation tied to the signal. Pivot to ONE upsell angle that fits: SEO if missing from directories, PPC/Premium if scaling, account expansion if hiring intake. End with a soft ask ('want 10 min to talk about scaling this listing alongside your growth?'). 70 words max. No price, no tier names, no fluff.

Output ONLY valid JSON. No preamble, no markdown fences. Schema: { \"subject\": string, \"body\": string }"

Export buildUpsellUser(lead, enrichment, signalSummary): string. signalSummary is a one-liner like 'hiring 2 intake coordinators in Asheville' or 'missing from PT + Rehabs.com' or 'high-spend tech stack (CallRail + HubSpot, score 4)'.

src/outreach/draftUpsell.ts:
Export draftUpsell(leadId: string, signalSummary: string): Promise<string | null>.

Mirror the setup from draftCold.ts/draftNudge.ts.

Flow:
1. Fetch lead include enrichment. Return null if missing.
2. doNotContact gate.
3. recent = prisma.draft.findFirst where leadId, kind='upsell', createdAt > now - 60d. If non-null → audit('draftUpsell.recent-exists'), return null.
4. Single Claude call: sonnet-4-5, temp 0.6, max 512, cached(UPSELL_SYSTEM), buildUpsellUser(lead, enrichment, signalSummary).
5. extractJSON + zod {subject, body}.
6. scanLeaks → on hit, audit('draftUpsell.leak-detected', { hits }), return null.
7. prisma.draft.create kind='upsell', status='pending', subject, body, specificFacts=[signalSummary], personalizationPct=null. Return draft.id.

src/scripts/draftUpsellBatch.ts:
Cron entry. Cap MAX_DRAFTS_PER_RUN = 5.

Flow:
1. Query HubSpot for closed-won deals with associated companies. Use hs.crm.deals.searchApi.doSearch filter dealstage='closedwon', properties=['dealname','hubspot_owner_id'], request associations=['companies']. Wrap with hsRetry. Paginate, cap candidates at 200.
2. Build a Set of associated companyIds across all closed-won deals.
3. prisma.lead.findMany where hubspotCompanyId IN companyIds, include enrichment. Skip if enrichment is null.
4. For each lead, derive signalSummary from enrichment.signals (Json — narrow with zod, mirror SignalsSchema in src/ui/queue.ts). Priority order:
   - signals.hiring?.active === true → `hiring ${signals.hiring.roleTitles?.[0] ?? 'staff'} in ${lead.city}`
   - signals.competingDirectories?.missingFromAll === true → 'missing from competing directories'
   - signals.techStack?.bigSpenderScore >= 3 → `high-spend tech stack (score ${signals.techStack.bigSpenderScore})`
   - else: skip lead.
5. Call draftUpsell(leadId, signalSummary). Stop loop once MAX_DRAFTS_PER_RUN created.
6. AuditLog action='cron.success' or 'cron.failure', entity='draftUpsellBatch', meta={ candidates, ok, skipped, fail }.
7. console.log JSON summary.

After this prompt: add `'0 8 * * *'  →  draftUpsellBatch  (outreach)` to the PRD §9.1 Daily Cron Schedule and to whatever runs your existing crons (Render cron job). 8:00 AM is unoccupied in the current schedule and runs after enrichAll (5:30) so signals are fresh.

STOP.
```

**Acceptance:** Stage a `Lead` with `hubspotCompanyId` set, an associated closed-won HubSpot deal, and `enrichment.signals.hiring.active=true` with `signals.hiring.roleTitles=['intake coordinators']`. Run `tsx src/scripts/draftUpsellBatch.ts`. A pending draft with `kind='upsell'` appears in `/queue`, body congratulates on the hiring signal and includes a soft ask. Re-running within 60 days does NOT create a duplicate (audits `draftUpsell.recent-exists`). A lead with no qualifying signals is skipped silently.

---

## Phase 10 — RAG Co-Pilot

### Prompt 10.1 — KB seed content + indexer

```
Create the kb/ markdown files AND src/shared/voyage.ts AND src/scripts/reindexKB.ts.

CRITICAL — kb/product/listing-tiers.md must contain the locked pricing from PRD §4:

# Sobriety Select Listing Tiers (2026 Pricing)

## Claimed Listing — $600/year
- For: solo or single-location centers, sober living, small operators
- Includes: verified badge, contact info, basic description, single photo
- Sonia's commission: 10% = $60 per sale
- Buyer: owner/director of 1-location facility with <10 Google reviews

## Select Listing — $2,400/year
- For: small-to-medium operators, active marketing posture
- Includes: enhanced profile, photo gallery, lead capture form, review showcase, monthly insights
- Sonia's commission: 10% = $240 per sale
- Buyer: marketing director or executive director growing past startup

## Premium Listing — $9,600/year
- For: multi-location operators, large residential, established MAT chains
- Includes: top-of-directory placement, premium photo + video, dedicated lead routing, priority support, quarterly performance reviews
- Sonia's commission: 10% = $960 per sale
- Buyer: CEO or VP Marketing of multi-location operator

## Additional Services (5% commission)
- SEO Programs: $18,000/year ($900 commission)
- Social Media Management: $12,000/year ($600 commission)
- Advertising / PPC / Paid Media: $18,000/year ($900 commission) — requires LegitScript on client
- Renewals & Upsells (existing): $25,000 average ($1,250 commission)

For ALL OTHER kb/*.md files listed in PRD §11: write 2-paragraph placeholder content with H1 title + at least one section. Sonia fills these in later.

src/shared/voyage.ts:
Export `embed(texts: string[]): Promise<number[][]>`:
POST https://api.voyageai.com/v1/embeddings
Headers: Authorization Bearer VOYAGE_API_KEY, Content-Type: application/json
Body: { model: 'voyage-3', input: texts }
Returns response.data.map(d => d.embedding) — array of 1024-dim vectors.

src/scripts/reindexKB.ts:
1. Walk kb/ recursively for .md files.
2. For each file: split into ~600-token chunks with 100-token overlap. Crude approach: split on double newlines, group paragraphs until ~2400 chars, slide window.
3. embed() in batches of 20.
4. Delete existing KBChunk for that docPath: prisma.kBChunk.deleteMany({ where: { docPath } }).
5. Insert each chunk via raw SQL (pgvector needs raw):
   await prisma.$executeRawUnsafe(
     `INSERT INTO "KBChunk" ("id","docPath","chunkIdx","content","embedding","metadata") VALUES ($1,$2,$3,$4,$5::vector,$6::jsonb)`,
     cuid(), docPath, idx, content, JSON.stringify(vec), JSON.stringify({})
   );
   (Use @paralleldrive/cuid2 or import cuid from prisma client — actually just use `crypto.randomUUID()` if Prisma's cuid isn't accessible from a script easily.)

STOP.
```

**Acceptance:** Run `npm run kb:reindex` → KBChunk has rows for every kb/*.md. listing-tiers.md chunks contain the exact $600 / $2,400 / $9,600 prices.

---

### Prompt 10.2 — Co-pilot endpoint

```
Create ONLY src/prompts/copilot.ts AND src/ui/copilot.ts. Mount copilotRouter in src/server.ts.

src/prompts/copilot.ts:
Export COPILOT_SYSTEM:
"You are the Sobriety Select sales co-pilot. Answer using ONLY the provided knowledge base. Cite chunks like [docPath#chunkIdx]. If the KB doesn't cover the question, say 'Not in KB — check with Mark Beach.' Brief, specific answers — no fluff. Sonia is on a sales call and needs the answer in 5 seconds of reading."

src/ui/copilot.ts:
Export copilotRouter = express.Router().

POST /copilot/ask (queueAuth):
Body: { question: string, dealId?: string, mode?: 'rag' | 'longctx' }

Flow:
1. mode default 'rag'.
2. dealContext: if dealId, fetch deal name + stage from HubSpot (best-effort, swallow errors).
3. If mode === 'rag':
   - vec = (await embed([question]))[0]
   - Raw SQL: chunks = await prisma.$queryRawUnsafe(`SELECT id, "docPath", "chunkIdx", content FROM "KBChunk" ORDER BY embedding <=> $1::vector LIMIT 8`, JSON.stringify(vec));
   - context = chunks.map(c => `[${c.docPath}#${c.chunkIdx}] ${c.content}`).join('\n\n');
4. If mode === 'longctx':
   - Load all kb/*.md content from disk (fs.readFileSync, recursive).
   - Concatenate into one big string with file path headers.
   - Pass system as multi-part with cache_control: [{ type: 'text', text: COPILOT_SYSTEM }, { type: 'text', text: bigKB, cache_control: { type: 'ephemeral' } }]
5. Call claude (sonnet-4, max 800, temp 0.2, system based on mode, user: `Deal context: ${dealContext ?? 'none'}\n\nQuestion: ${question}`).
6. Return JSON: { answer: extractText(msg), citations: mode === 'rag' ? chunks.map(c => `${c.docPath}#${c.chunkIdx}`) : [] }.

Top of file comment with curl example:
// curl -X POST 'http://localhost:3000/copilot/ask?pw=$QUEUE_PASSWORD' -H 'Content-Type: application/json' -d '{"question":"How much is the Premium tier?"}'

STOP.
```

**Acceptance:** `curl -X POST .../copilot/ask -d '{"question":"How much is the Premium tier?"}'` → coherent answer citing the locked $9,600 from listing-tiers.md.

---

## Phase 11 — Deploy to Render

### Prompt 11.1 — render.yaml

```
Create ONLY render.yaml at repo root.

services:
  - type: web
    name: ssa-web
    runtime: node
    plan: starter
    buildCommand: npm install && npx prisma generate && npm run build && npx playwright install --with-deps chromium
    startCommand: npx prisma migrate deploy && node dist/server.js
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: ssa-db, property: connectionString }
      # for each other env var: { key: NAME, sync: false } so they show in dashboard for manual entry

  # One cron service per scheduled job (PRD §9.1).
  - type: cron
    name: ssa-daily-scrape
    runtime: node
    schedule: "0 5 * * *"
    buildCommand: npm install && npx prisma generate && npm run build && npx playwright install --with-deps chromium
    startCommand: node dist/scripts/dailyScrape.js
    envVars: # same env block
  - type: cron
    name: ssa-enrich
    schedule: "30 5 * * *"
    startCommand: node dist/scripts/enrichAll.js
    # ... etc for all 14 cron jobs in PRD §9.1

databases:
  - name: ssa-db
    plan: starter
    postgresMajorVersion: 15

Output the exact post-deploy steps as a comment block at the top:
# 1. git push, then in Render: New → Blueprint → connect repo → apply render.yaml
# 2. Wait for ssa-db to provision
# 3. Open ssa-web shell: psql $DATABASE_URL -c 'CREATE EXTENSION IF NOT EXISTS vector;'
# 4. Enter all secrets in Render dashboard
# 5. Trigger first manual deploy of ssa-web
# 6. Verify /health green
# 7. Optionally trigger ssa-daily-scrape manually first

STOP.
```

**Acceptance:** Render Blueprint detects render.yaml on push, applies it. `/health` returns 200 at the Render URL. First manual cron run logs visible.

---

### Prompt 11.2 — Beef up /health

```
Edit ONLY src/server.ts to expand /health.

Replace the existing /health handler with one that runs four checks in parallel (Promise.allSettled):

1. Postgres: await prisma.$queryRaw`SELECT 1`. → ok or error.
2. HubSpot: await hsRetry(() => hs.crm.objects.contacts.basicApi.getPage(1)). → ok or error.
3. Claude: await claude.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }). → ok or error.
4. Queue depth: await prisma.draft.count({ where: { status: 'pending' }}).

Also pull last successful cron per job from AuditLog (action='cron.success'):
- prisma.auditLog.findMany({ where: { action: 'cron.success' }, orderBy: { createdAt: 'desc' }, take: 50 })
- Group by meta.entity (in JS, dedupe). For each, compute ageMinutes = (now - createdAt) / 60000.

Return JSON:
{
  ok: boolean, // true iff all checks passed
  uptime: process.uptime(),
  version: '1.2.0',
  checks: { postgres: { ok }, hubspot: { ok }, claude: { ok }, queueDepth: number },
  crons: { [jobName]: { lastRunMinutesAgo: number, ok: true } }
}

STOP.
```

**Acceptance:** `curl /health` → expanded JSON with all checks. Manually kill Postgres → `ok: false` with postgres check failing.

---

## Phase 12 — Hardening

### Prompt 12.1 — Golden prompt tests

```
Create ONLY tests/prompts/coldEmail.test.ts AND tests/prompts/websiteAnalyzer.test.ts.

(setClaudeMock already exists in src/shared/claude.ts from Prompt 2.2.)

tests/prompts/coldEmail.test.ts:

Three describe blocks. Each mocks Claude responses to return deterministic JSON, then calls draftColdEmail (or just buildColdEmailUser + an inline minimal version of the flow if mocking is awkward), then asserts the structure.

Test 1: Solo sober-living in Asheville NC, owner Sarah Kim, 14 Google reviews, no schema markup, expectedProduct='claimed'. Mock returns email referencing "Asheville", "Sarah", "schema". Assert: body contains 'Asheville' AND ('Sarah' OR 'Kim'); pct >= 60; subject ≤ 6 words.

Test 2: Large IOP in Houston TX, no owner, 230 reviews, weak SEO, expectedProduct='premium', signals.hiring.active=true with roleTitles=['Clinical Director', 'Intake Coordinator']. Mock email references "Houston", "IOP", "hiring". Assert: body contains 'Houston' AND 'IOP' AND ('hiring' OR 'expanding'); pct >= 60.

Test 3: MAT clinic in Cincinnati OH, owner Dr. Marcus Walsh, 8 reviews, no outcomes, expectedProduct='select', signals.competingDirectories.missingFromAll=true. Mock email references "MAT", "Cincinnati", "Walsh", "Psychology Today". Assert: body contains 'Cincinnati' AND 'Walsh' AND ('Psychology Today' OR 'directories' OR 'visible'); pct >= 60.

tests/prompts/websiteAnalyzer.test.ts: 2 cases. Clean center site → mock returns owner + tier='select'. Broken site (null html) → enrich writes painPoints with broken_or_slow. Asserts on Enrichment row contents.

Run: npm test.

STOP.
```

**Acceptance:** `npm test` passes.

---

### Prompt 12.2 — Pre-launch checklist

```
Create ONLY CHECKLIST.md at repo root with these checkbox sections:

## Pre-launch
- [ ] SAMHSA API access form submitted
- [ ] Google Places billing enabled, daily quota set to $10 cap
- [ ] Serper subscription active (Developer tier)
- [ ] HubSpot Service Key configured with all required scopes
- [ ] HubSpot custom properties created (setupHubspotCustomProperties.ts)
- [ ] Gmail OAuth refresh token in Render env (run gmailAuth.ts locally first)
- [ ] Twilio number purchased
- [ ] ElevenLabs voice cloned (Sonia's own voice for authenticity)
- [ ] SPF, DKIM, DMARC on sobrietyselect.com confirmed via mxtoolbox
- [ ] Domain warmup started via Mailwarm (4 weeks before bulk)
- [ ] LegitScript status confirmed (or risk flagged)
- [ ] CAN-SPAM footer address confirmed with Mark
- [ ] Existing-client exclusion list pulled, loaded as Suppression rows
- [ ] /queue accessible at production URL
- [ ] /copilot/ask returns answers from KB
- [ ] /prep-brief/:dealId works on a test deal
- [ ] /health all green
- [ ] First daily brief received in inbox

## Week 1 operational
- [ ] 5,000 leads in DB (FL/CA/TX)
- [ ] 200 enrichments with owner names ≥40%
- [ ] expectedProduct distributed: claimed/select/premium ratio sensible
- [ ] Signals populated: ≥30% of enrichments have at least one signal=true
- [ ] 30 cold drafts approved and sent
- [ ] Reply detection confirmed end-to-end
- [ ] First discovery call booked
- [ ] First prep brief used before a real call

## Week 4 review
- [ ] First closed-won deal
- [ ] Domain reputation green (Google Postmaster Tools)
- [ ] Reply rate ≥10%
- [ ] Approval rate ≥60%
- [ ] Personalization average ≥70% (with signals incorporated)
- [ ] Cost per booked discovery call calculated
- [ ] Commission-weighted scoring delivering better priorities than time-weighted

## Ongoing
- [ ] KB updated after every objection
- [ ] Golden tests updated quarterly
- [ ] Suppression list reconciled with HubSpot weekly
- [ ] DNC scrub monthly (once volume justifies)

STOP.
```

**Acceptance:** File exists. Sonia starts checking boxes.

---

## Appendix — Cost ceiling (first 60 days)


| Item                               | Monthly cap     |
| ---------------------------------- | --------------- |
| Render web + Postgres              | $14             |
| Claude API                         | $80             |
| Voyage AI (embeddings)             | $5              |
| Google Places                      | $50             |
| Serper (now incl. signals checks)  | $50             |
| Twilio (voice + lookups)           | $30             |
| ElevenLabs                         | $22             |
| Mailwarm or equivalent             | $50             |
| **Total infra+APIs**               | **~$301/month** |


Break-even at ~2 Select-tier deals/month ($240 × 2 = $480). Target 5+ deals/month by month 3.

---

## Appendix — What we reused vs scrapped from past repos

**Reused:**

1. Express + TypeScript + Prisma layout
2. ElevenLabs + Twilio voicemail pattern (simplified one-way)
3. KB markdown + pgvector RAG
4. Pluggable provider pattern → `src/pipeline/sources/`
5. Render deployment pattern
6. Health endpoint pattern

**Scrapped:**

1. WebSocket bidirectional audio
2. Redis session store
3. OpenAI Realtime API
4. EJS admin dashboard (HubSpot IS the dashboard)
5. Docker Compose locally
6. Multi-tenant Business + AgentConfig models
7. JWT auth middleware (one password env var is enough)
8. Sequence table (state derived from Draft history)
9. VoicemailAudio + VoicemailLog tables (Draft handles it)
10. BuiltWith paid API (regex on already-fetched HTML)

