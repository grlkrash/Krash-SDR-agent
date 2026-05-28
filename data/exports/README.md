# Lead export for HubSpot overlap check

Generated CSVs land here. **Do not commit real exports** — they contain PII.

## Generate (Sonia)

```bash
npm run leads:export
```

Default file: `data/exports/sdr-leads-YYYY-MM-DD.csv`

Options:

```bash
npm run leads:export -- --enriched-only
npm run leads:export -- --output ~/Desktop/ss-overlap.csv
railway run npm run leads:export
```

## Compare against Sobriety Select HubSpot (their team)

### Step 1 — Export from HubSpot (Companies)

In their portal: **Contacts → Companies → Export**

Include at minimum:

- Record ID
- Company name
- **Company Domain Name**
- City, State/Region
- Phone Number
- Lifecycle stage (optional)
- Last Activity Date (optional)

Save as `ss-companies.csv`.

### Step 2 — Export from HubSpot (Contacts, optional)

**Contacts → Export** with:

- Email
- First Name, Last Name
- Associated Company (domain or company name)

Save as `ss-contacts.csv`.

### Step 3 — Match companies (primary)

In Excel or Google Sheets:

1. Open `ss-companies.csv` and Sonia’s `sdr-leads-*.csv`.
2. Normalize domains to lowercase (both files, column **Company Domain Name**).
3. Add a column on the SS sheet:  
   `=XLOOKUP(A2, [Sonia file]!Company Domain Name column, [Sonia file]!SDR lead ID, "")`  
   (or VLOOKUP / INDEX-MATCH if older Excel).
4. Rows with a match = **already in our prospect pool** (may still differ in HubSpot if never synced).
5. Rows with **empty domain** on Sonia’s side cannot auto-match — use Step 4.

### Step 4 — Secondary match (no domain)

For Sonia rows with blank **Company Domain Name**:

- Match on **Email** (Sonia `Email` ↔ SS contact export), or
- Fuzzy match **Company name** + **City** + **State/Region**.

### Step 5 — Interpret overlap

| Result | Meaning |
|--------|---------|
| Domain match + SS **Record ID** present | Already in their CRM — check lifecycle / last activity before cold outreach |
| Domain match, no SS record | Net-new company for them; good import candidate |
| No match | Net-new to both systems |
| Sonia **Exclude from cold** = yes | Our agent already flagged (directory client or imported SS list) — do not cold |

### Step 6 — Trial import (optional)

Import 20–50 **unmatched** Sonia rows into a **sandbox** HubSpot with duplicate rules on **Company Domain Name** and **Email**. Confirms custom `ss_*` properties and association behavior before production.

## Column reference (Sonia export)

| Column | Use in HubSpot compare |
|--------|-------------------------|
| Company Domain Name | **Primary** match key |
| Email | Contact-level match |
| Company record ID | Sonia’s HubSpot company ID if already synced to their portal |
| Company name, City, State/Region | Fallback fuzzy match |
| Exclude from cold / Exclusion reason | Already suppressed in SDR agent |
| Email source | `guessed` emails may not match CRM — treat as low confidence |
