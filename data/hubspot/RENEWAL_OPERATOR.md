# Renewal dates — operator guide (no HubSpot workflows)

Paid HubSpot **workflows are not required**. The SSA service handles defaults on the daily cron.

## When you close a deal

| Contract length | What you do in HubSpot |
|-----------------|------------------------|
| **12 months** (most deals) | Move to **Closed won** only. Leave **SS Contract Term** blank — the **9:45 AM ET** job sets it to `12` and computes **SS Renewal Date**. |
| **3 or 6 months** | **Closed won** + set **SS Contract Term (months)** to `3` or `6` on the deal (once). |

You never need to set **SS Renewal Date** by hand.

## Daily automation (already on Railway cron)

1. **`syncDealRenewalDates`** (9:45 AM ET) — default term `12` if missing; `ss_renewal_date = closedate + term`
2. **`renewalWarnings`** (10:00 AM ET) — drafts ~60 days before renewal

Optional env on the cron service: `SSA_DEFAULT_CONTRACT_TERM_MONTHS=12` (or `6` if most clients are 6-month).

## Same-day renewal date (optional)

After closing, without waiting for 9:45 AM:

```bash
npx tsx src/scripts/syncDealRenewalDates.ts
```

## On each client renewal

Update the deal’s **Close Date** to the new contract start. Confirm **SS Contract Term** is still correct. The next **SS Renewal Date** is recomputed on the next sync.

## One-time backfill (existing closed-won)

Usually unnecessary — the daily sync defaults terms. To bulk-set before the next cron:

```bash
npx tsx src/scripts/backfillContractTerms.ts
CONFIRM=yes npx tsx src/scripts/backfillContractTerms.ts
npx tsx src/scripts/syncDealRenewalDates.ts
```
