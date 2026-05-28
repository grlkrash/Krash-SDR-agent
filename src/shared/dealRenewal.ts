// Contract term + renewal-date helpers for closed-won HubSpot deals.
// Source of truth: ss_contract_term_months + closedate → ss_renewal_date
// (maintained by pipeline/syncDealRenewalDates).

export const CONTRACT_TERM_MONTHS = [3, 6, 12] as const;
export type ContractTermMonths = (typeof CONTRACT_TERM_MONTHS)[number];

export const DEFAULT_CONTRACT_TERM_MONTHS: ContractTermMonths = 12;

export const parseContractTermMonths = (
  raw: string | null | undefined,
): ContractTermMonths | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (n === 3 || n === 6 || n === 12) return n;
  return null;
};

// HubSpot returns dates as ISO strings on most v3 endpoints; legacy/system
// properties occasionally arrive as Unix-ms.
export const parseHsDate = (raw: string | null | undefined): Date | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return new Date(iso);
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return new Date(num);
  return null;
};

/** UTC calendar date YYYY-MM-DD for HubSpot date properties. */
export const formatHsDateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export const computeRenewalDate = (
  closeDate: Date,
  termMonths: ContractTermMonths,
): Date => {
  const y = closeDate.getUTCFullYear();
  const m = closeDate.getUTCMonth();
  const day = closeDate.getUTCDate();
  return new Date(Date.UTC(y, m + termMonths, day));
};

export const hsDateOnlyEqual = (
  a: Date | null,
  b: Date | null,
): boolean => {
  if (a === null || b === null) return false;
  return formatHsDateOnly(a) === formatHsDateOnly(b);
};

/** Prompt-facing phrase for the contract length (not the renewal calendar date). */
export const contractTermPartnershipLabel = (term: ContractTermMonths): string => {
  if (term === 3) return 'three-month';
  if (term === 6) return 'six-month';
  return 'twelve-month';
};
