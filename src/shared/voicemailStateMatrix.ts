// US state-by-state matrix for automated voicemail drops.
// Source of truth for eligibility UI, PDF export, and counsel review packets.
// Update only after counsel sign-off — see data/exports/README.md.

import { MANUAL_ONLY_US_STATES } from './voicemailEligibility.js';

export type MatrixRowStatus = 'auto-allowed' | 'manual-only' | 'non-us';

export type VoicemailMatrixRow = {
  code: string;
  name: string;
  status: MatrixRowStatus;
  agentAction: string;
  statute: string;
  notes: string;
};

const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

const MANUAL_STATUTE: Record<string, string> = {
  FL: 'Fla. Stat. § 501.059 (FTSA, am. 2023 HB 761)',
  OK: '15 Okla. Stat. § 775C.1 (OTSA, eff. Nov 2022)',
  WA: 'RCW 80.36.400 + RCW 19.190',
  IN: 'IC 24-5-14 (Indiana Telephone Privacy Act)',
  MA: '940 CMR 19',
  TX: 'Tex. Bus. & Com. Code Ch. 304 + SB 140 (2023)',
  CA: 'Cal. Bus. & Prof. Code §§ 17511–17539 + CPRA',
};

const MANUAL_NOTES: Record<string, string> = {
  FL: 'Prior express written consent for automated/prerecorded telephonic sales calls. Private right of action; statutory damages.',
  OK: 'Modeled on pre-2023 FTSA; prior express written consent required.',
  WA: 'ADAD restrictions for commercial solicitation; consent or established business relationship.',
  IN: 'Prerecorded message restrictions; narrow exemptions.',
  MA: 'Telemarketing registration + restrictions on artificial voice messages.',
  TX: 'Automated/prerecorded voice requires strict disclosure and consent; high penalties ($500–$10,000/violation).',
  CA: 'Mini-TCPA + privacy overlap; artificial voice marketing triggers consent and disclosure analysis.',
};

const FEDERAL_AUTO_NOTE =
  'Federal TCPA B2B landline path only. Agent still requires Twilio Line Type Intelligence = landline and blocks mobile/VoIP.';

export const MATRIX_VERSION = '2026-05-29';
export const MATRIX_COUNSEL_DISCLAIMER =
  'This matrix is a best-faith engineering summary, not legal advice. '
  + 'Have qualified counsel review and sign off before scaling beyond a pilot. '
  + 'State telemarketing law changes frequently.';

export const buildVoicemailMatrixRows = (): VoicemailMatrixRow[] => {
  const codes = Object.keys(US_STATE_NAMES).sort();
  return codes.map((code) => {
    if (MANUAL_ONLY_US_STATES.has(code)) {
      return {
        code,
        name: US_STATE_NAMES[code] ?? code,
        status: 'manual-only',
        agentAction: 'Manual VM / live call only — no automated drop',
        statute: MANUAL_STATUTE[code] ?? 'State telemarketing restriction',
        notes: MANUAL_NOTES[code] ?? 'Counsel review required before any automated outreach.',
      };
    }
    return {
      code,
      name: US_STATE_NAMES[code] ?? code,
      status: 'auto-allowed',
      agentAction: 'Automated landline VM drop permitted (if landline confirmed)',
      statute: '47 U.S.C. § 227(b)(1)(B) B2B landline exemption',
      notes: FEDERAL_AUTO_NOTE,
    };
  });
};

export const NON_US_MATRIX_ROWS: VoicemailMatrixRow[] = [
  {
    code: 'MX',
    name: 'Mexico',
    status: 'non-us',
    agentAction: 'Blocked — manual outreach only',
    statute: 'REPEP / LFTR (Mexico federal telemarketing)',
    notes: 'Requires per-country consent program before any automated dial.',
  },
  {
    code: 'CA',
    name: 'Canada',
    status: 'non-us',
    agentAction: 'Blocked — manual outreach only',
    statute: 'CRTC Unsolicited Telecommunications Rules',
    notes: 'National DNCL + consent rules; no automated drop until program in place.',
  },
  {
    code: 'OTHER',
    name: 'All other non-US',
    status: 'non-us',
    agentAction: 'Blocked — manual outreach only',
    statute: 'Varies by jurisdiction',
    notes: 'libphonenumber country !== US → blocked at draft time.',
  },
];

export const PRIOR_WRITTEN_CONSENT_NOTE =
  'When Lead.priorWrittenConsent = true (documented click-through or signed SOW on file), '
  + 'isAutoVoicemailAllowed returns allowed even in manual-only US states. '
  + 'Landline gate and DNC/suppression checks still apply.';
