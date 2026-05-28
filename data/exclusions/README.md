# Exclusion imports (directory + existing clients)

Drop spreadsheets here so cold outreach skips facilities already on Sobriety Select or already paying.

## Folders

| Folder | Use for |
|--------|---------|
| `incoming/directory/` | Directory backend export (all active listings) |
| `incoming/client/` | HubSpot / paying-client export |
| `processed/` | Filled automatically after a successful import |

**Do not commit real CSVs** — they may contain PII. Only `.gitkeep` files are tracked.

## Automatic directory sync (daily cron)

Every day at **6:15 AM ET** (before `draftColdBatch`), `syncDirectoryExclusions`:

1. Calls Sobriety Select's public search API (`/api/medical-centers/search`)
2. Pulls all **verified partner listings** (`subscriptionType` = `subscribe` or `ads`) — currently ~80–90 nationwide
3. Matches to your `Lead` rows and flags them `directory-listed` (cold excluded, not `doNotContact`)
4. Logs `catalogTotalEstimate` (~9,700) — the searchable inventory shown when you filter by insurance/region; **those are not SS clients**

**Important:** Filtering Midwest + Anthem shows **400+ results** because that's the full searchable catalog, not verified Sobriety Select listings. Only `subscribe`/`ads` rows get the verified badge and cold exclusion.

Manual run:

```bash
npm run exclusions:sync-directory
```

When Mark’s CSV arrives, still run `exclusions:import` — it is more complete than the public scrape.

## Run import

From repo root, with `DATABASE_URL` pointing at your DB (local or production):

```bash
npm run exclusions:import -- --incoming
```

Or a single file:

```bash
npm run exclusions:import -- directory ./data/exclusions/incoming/directory/listings-2026-05-27.csv
npm run exclusions:import -- client ./data/exclusions/incoming/client/hubspot-closed-won.csv
```

On Railway (production DB):

```bash
railway run npm run exclusions:import -- --incoming
```

## CSV columns (flexible headers)

At minimum include **facility name**. More columns = better matching.

| Purpose | Accepted header names |
|---------|------------------------|
| Name | `name`, `facility_name`, `company`, `company_name` |
| Address | `street`, `address`, `address1` |
| City / state / zip | `city`, `state`, `zip`, `postal_code` |
| Website | `website`, `url`, `domain` |
| Email | `email`, `owner_email`, `contact_email` |
| Phone | `phone`, `main_phone` |
| Tier | `tier`, `listing_tier`, `ss_product_type`, `product` |
| External ID | `id`, `facility_id`, `hubspot_company_id`, `company_id` |
| Status | `status` — rows with `inactive`, `removed`, `draft` are skipped |

## What the importer does

1. Matches each row to a `Lead` (domain → address → name+city+state).
2. Writes `exclusion` metadata on `Lead.sourceMeta` and `Enrichment.signals` (if enriched).
3. **Does not** set `doNotContact` (so renewal/upsell paths still work for paying clients).
4. For **client** imports: also upserts `Suppression` when email/phone is present.
5. Rejects any pending/approved/paused **cold** drafts for matched leads.
6. Logs `exclusion.import-*` rows in `AuditLog`; prints a JSON summary.

## After import

- `draftColdBatch` and `draftCold` skip excluded leads automatically.
- Review `unmatched` and `ambiguous` counts in the JSON output; fix CSV or match manually in `/queue` (Kill lead) if needed.
