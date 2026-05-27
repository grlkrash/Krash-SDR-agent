# Exclusion imports (directory + existing clients)

Drop spreadsheets here so cold outreach skips facilities already on Sobriety Select or already paying.

## Folders

| Folder | Use for |
|--------|---------|
| `incoming/directory/` | Directory backend export (all active listings) |
| `incoming/client/` | HubSpot / paying-client export |
| `processed/` | Filled automatically after a successful import |

**Do not commit real CSVs** — they may contain PII. Only `.gitkeep` files are tracked.

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
