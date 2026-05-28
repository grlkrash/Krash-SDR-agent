# HubSpot workflow — contract term on Closed Won

Sets **SS Contract Term (months)** when a deal closes so the SSA cron can derive **SS Renewal Date** the same night (or run `syncDealRenewalDates` manually for instant sync).

## Prerequisites

- Property exists: run `npx tsx src/scripts/setupHubspotCustomProperties.ts` once.
- HubSpot **Operations** or **Sales** automation (workflows) enabled on your portal.

## Workflow A — default 12-month term (recommended start)

1. **Automation** → **Workflows** → **Create workflow** → **From scratch**.
2. **Object:** Deals.
3. **Enrollment trigger:** **Deal stage** → **is any of** → **Closed won** (your pipeline’s closed-won stage).
4. **Re-enrollment:** Off (each deal should only get the default once at close).
5. **Action 1 — IF branch (optional but cleaner):**
   - **SS Contract Term (months)** **is unknown** (or **is not any of** 3, 6, 12 if your UI supports it).
6. **Action 2 — Set property:**
   - Property: **SS Contract Term (months)**
   - Value: **12**
7. **Name:** `SSA — Set 12-month contract term on close`
8. **Turn on.**

Deals with 3- or 6-month contracts: change the term manually on the deal record (or add Workflow B below).

## Workflow B — term from deal name or product (optional)

If you encode term in **SS Product Type** or deal name:

1. Duplicate Workflow A.
2. Replace the single “set 12” action with **branches**:
   - IF deal name **contains** `6mo` or `6-mo` → set term **6**
   - ELSE IF deal name **contains** `3mo` → set term **3**
   - ELSE → set term **12**

Adjust keywords to match how you name deals in HubSpot.

## Same-day renewal date (before 9:45 AM ET cron)

HubSpot workflows cannot reliably run the same UTC calendar math as `syncDealRenewalDates`. After closing (or after Workflow A runs):

```bash
npx tsx src/scripts/syncDealRenewalDates.ts
```

Or wait for the daily **9:45 AM ET** cron.

## One-time backfill for existing closed-won deals

```bash
# Preview counts
npx tsx src/scripts/backfillContractTerms.ts

# Write default 12-month term where missing
CONFIRM=yes npx tsx src/scripts/backfillContractTerms.ts

# Derive renewal dates
npx tsx src/scripts/syncDealRenewalDates.ts
```

Use `DEFAULT_TERM_MONTHS=6` if most legacy deals are 6-month (only affects deals still missing the field).

## On each client renewal

Update the deal’s **Close Date** to the new contract start and confirm **SS Contract Term (months)** is still correct. The next **SS Renewal Date** is recomputed on the next sync.
