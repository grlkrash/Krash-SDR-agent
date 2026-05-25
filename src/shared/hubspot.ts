// HubSpot client wrapper.
//
// Auth: we're using a HubSpot Service Key, not a private app. The token still
// goes in HUBSPOT_ACCESS_TOKEN and authenticates identically via the bearer
// header — no code difference. Scopes are set on the Service Key in the
// HubSpot UI.
//
// Required scopes on the Service Key:
//   - crm.objects.contacts.read, crm.objects.contacts.write
//   - crm.objects.companies.read, crm.objects.companies.write
//   - crm.objects.deals.read, crm.objects.deals.write
//   - crm.schemas.contacts.read, crm.schemas.companies.read, crm.schemas.deals.read
//   - crm.schemas.contacts.write, crm.schemas.companies.write,
//     crm.schemas.deals.write   (required by setupHubspotCustomProperties.ts
//     to create custom CRM properties; HubSpot returns 403 MISSING_SCOPES
//     on /crm/v3/properties without the write scope, even for GET —
//     verified against this token on 2026-05-25)
//   - sales-email-read
//   - crm.objects.owners.read   (the granular owners scope; the legacy
//     `settings.users.read` no longer satisfies /crm/v3/owners on a Service
//     Key — verified 403 MISSING_SCOPES against this token on 2026-05-25)

import { Client } from '@hubspot/api-client';

export const hs = new Client({ accessToken: process.env.HUBSPOT_ACCESS_TOKEN });

const RETRY_STATUSES = new Set([429, 502, 503]);
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getStatusCode = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'number') return e.code;
  const response = e.response;
  if (typeof response === 'object' && response !== null) {
    const status = (response as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }
  return null;
};

export const hsRetry = async <T>(
  fn: () => Promise<T>,
  attempts = 5,
): Promise<T> => {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = getStatusCode(err);
      const retriable = status !== null && RETRY_STATUSES.has(status);
      if (!retriable || i === attempts - 1) throw err;
      const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** i);
      await sleep(delay);
    }
  }
  throw lastError;
};
