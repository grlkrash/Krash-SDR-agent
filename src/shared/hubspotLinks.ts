// HubSpot CRM deep links for operator queues. HubSpot does not expose a public
// URL that auto-starts the dialer from outside the CRM — open the contact or
// company record and use HubSpot's built-in call button on the phone field.

import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from './hubspot.js';

const DEFAULT_UI_DOMAIN = 'app-na2.hubspot.com';
const CONTACT_OBJECT = '0-1';
const COMPANY_OBJECT = '0-2';

let cachedPortalId: string | null = null;
let cachedUiDomain: string | null = null;

export const getHubspotPortalContext = async (): Promise<{ portalId: string; uiDomain: string }> => {
  const envPortal = process.env.HUBSPOT_PORTAL_ID?.trim();
  const envUi = process.env.HUBSPOT_UI_DOMAIN?.trim();
  if (envPortal !== undefined && envPortal !== '' && envUi !== undefined && envUi !== '') {
    return { portalId: envPortal, uiDomain: envUi };
  }
  if (cachedPortalId !== null && cachedUiDomain !== null) {
    return { portalId: cachedPortalId, uiDomain: cachedUiDomain };
  }
  const token = process.env.HUBSPOT_ACCESS_TOKEN ?? '';
  const res = await fetch('https://api.hubapi.com/account-info/v3/details', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HubSpot account-info failed: ${res.status}`);
  const details = await res.json() as { portalId?: number; uiDomain?: string };
  const portalId = String(details.portalId ?? envPortal ?? '');
  const uiDomain = details.uiDomain ?? envUi ?? DEFAULT_UI_DOMAIN;
  if (portalId === '') throw new Error('Could not resolve HubSpot portalId');
  cachedPortalId = portalId;
  cachedUiDomain = uiDomain;
  return { portalId, uiDomain };
};

export const buildHubspotRecordUrl = (opts: {
  portalId: string;
  uiDomain: string;
  objectTypeId: string;
  recordId: string;
}): string =>
  `https://${opts.uiDomain}/contacts/${opts.portalId}/record/${opts.objectTypeId}/${opts.recordId}`;

export const buildHubspotContactUrl = async (contactId: string): Promise<string> => {
  const ctx = await getHubspotPortalContext();
  return buildHubspotRecordUrl({
    portalId: ctx.portalId,
    uiDomain: ctx.uiDomain,
    objectTypeId: CONTACT_OBJECT,
    recordId: contactId,
  });
};

export const buildHubspotCompanyUrl = async (companyId: string): Promise<string> => {
  const ctx = await getHubspotPortalContext();
  return buildHubspotRecordUrl({
    portalId: ctx.portalId,
    uiDomain: ctx.uiDomain,
    objectTypeId: COMPANY_OBJECT,
    recordId: companyId,
  });
};

export const findContactIdByEmail = async (email: string): Promise<string | null> => {
  const trimmed = email.trim();
  if (trimmed === '') return null;
  const res = await hsRetry(() =>
    hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: trimmed,
        }],
      }],
      properties: ['email'],
      limit: 1,
    }),
  );
  return res.results[0]?.id ?? null;
};

export const resolveHubspotCallTarget = async (opts: {
  companyId: string | null;
  ownerEmail: string | null;
}): Promise<{ url: string; kind: 'contact' | 'company' } | null> => {
  if (opts.ownerEmail !== null && opts.ownerEmail !== '') {
    const contactId = await findContactIdByEmail(opts.ownerEmail);
    if (contactId !== null) {
      return { url: await buildHubspotContactUrl(contactId), kind: 'contact' };
    }
  }
  if (opts.companyId !== null && opts.companyId !== '') {
    return { url: await buildHubspotCompanyUrl(opts.companyId), kind: 'company' };
  }
  return null;
};
