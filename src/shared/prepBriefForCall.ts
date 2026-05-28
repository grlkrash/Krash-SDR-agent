// Programmatic prep brief for live voicemail bridges (vm-1 and vm-2).
//
// Two outputs from the same lead + enrichment payload:
//   - buildPrepBriefEmail: full markdown body Sonia receives ~0.5s before
//     Twilio bridges the prospect to her phone. Includes facility facts,
//     owner, signals, recent touches, pitch angle.
//   - buildWhisperText: ~10 seconds of speech for Twilio's <Say> verb that
//     plays in Sonia's ear AFTER she picks up but BEFORE the bridge connects.
//
// Programmatic on purpose — no Claude call. The /twiml webhook responds to
// Twilio within ~1 second; we can't afford an LLM round-trip in the critical
// path. The lead + enrichment data is structured enough to template.

import type { Enrichment, Lead, Prisma } from '@prisma/client';

export type VoicemailBridgeKind = 'voicemail' | 'voicemail-2';

const SIGNAL_KEYS_PRIORITY = [
  'hiring',
  'missingCompetingDirectories',
  'techStack',
  'expansion',
] as const;

const formatPhoneForDisplay = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m === null) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
};

const summarizeOneSignal = (signals: Prisma.JsonValue): string | null => {
  if (signals === null || typeof signals !== 'object' || Array.isArray(signals)) {
    return null;
  }
  const s = signals as Record<string, unknown>;
  for (const key of SIGNAL_KEYS_PRIORITY) {
    const value = s[key];
    if (value === undefined || value === null) continue;
    if (key === 'hiring' && Array.isArray(value) && value.length > 0) {
      const roles = value.slice(0, 2).filter((v) => typeof v === 'string').join(', ');
      return `Hiring: ${roles}`;
    }
    if (key === 'hiring' && value === true) return 'Actively hiring';
    if (key === 'missingCompetingDirectories' && Array.isArray(value) && value.length > 0) {
      const names = value.slice(0, 2).filter((v) => typeof v === 'string').join(', ');
      return `Not listed on: ${names}`;
    }
    if (key === 'techStack' && typeof value === 'object' && !Array.isArray(value)) {
      const tools = Object.keys(value as Record<string, unknown>).slice(0, 2).join(', ');
      if (tools.length > 0) return `Runs: ${tools}`;
    }
    if (key === 'expansion' && typeof value === 'string') return `Expansion: ${value}`;
  }
  return null;
};

const summarizeAllSignals = (signals: Prisma.JsonValue): string => {
  if (signals === null || typeof signals !== 'object' || Array.isArray(signals)) {
    return '_(no signals captured)_';
  }
  const s = signals as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of Object.keys(s)) {
    const v = s[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    lines.push(`- **${key}:** ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return lines.length === 0 ? '_(no signals captured)_' : lines.join('\n');
};

const recentTouchesForKind = (kind: VoicemailBridgeKind): string[] => {
  if (kind === 'voicemail-2') {
    return [
      '- Cold email sent earlier this week',
      '- First voicemail dropped ~3 business days ago',
    ];
  }
  return [
    '- Cold email sent earlier this week',
    '- First live connect — may be gatekeeper or owner',
  ];
};

const pitchAngleForKind = (kind: VoicemailBridgeKind): string[] => {
  if (kind === 'voicemail-2') {
    return [
      '## Pitch angle',
      '- Open with the signal above (intake/census language, never "visibility")',
      '- They got your voicemail — acknowledge it briefly, ask if they had a sec to listen',
      '- Soft ask: 10-min walkthrough this week or next',
    ];
  }
  return [
    '## Pitch angle',
    '- Open with the signal above (intake/census language, never "visibility")',
    '- Brief intro: Sobriety Select connects families searching for treatment with centers that have open beds',
    '- Soft ask: 10-min walkthrough this week or next',
  ];
};

export const buildPrepBriefEmail = (
  lead: Lead,
  enrichment: Enrichment | null,
  kind: VoicemailBridgeKind,
): { subject: string; body: string } => {
  const phoneDisplay = lead.phoneE164 === null ? '—' : formatPhoneForDisplay(lead.phoneE164);
  const ownerLine = enrichment === null || enrichment.ownerName === null
    ? '_(owner not enriched — ask "who handles marketing or partnerships?")_'
    : `**${enrichment.ownerName}**${enrichment.ownerTitle === null ? '' : ` — ${enrichment.ownerTitle}`}${enrichment.ownerLinkedIn === null ? '' : ` · ${enrichment.ownerLinkedIn}`}`;

  const signalsBlock = enrichment === null
    ? '_(no enrichment)_'
    : summarizeAllSignals(enrichment.signals);

  const touchLabel = kind === 'voicemail-2' ? 'Second call' : 'First call';
  const subject = `📞 Live now (${touchLabel}): ${lead.name} (${lead.city}, ${lead.state})`;
  const body = [
    `# ${lead.name}`,
    `**${lead.city}, ${lead.state}** · ${phoneDisplay}`,
    '',
    "## Who you're talking to",
    ownerLine,
    '',
    '## Snapshot',
    `- Google reviews: ${lead.googleReviews ?? '—'} (rating ${lead.googleRating ?? '—'})`,
    `- Website: ${lead.website ?? '—'}`,
    `- Services: ${lead.services.length === 0 ? '—' : lead.services.slice(0, 6).join(', ')}`,
    '',
    '## Signals',
    signalsBlock,
    '',
    '## Recent touches',
    ...recentTouchesForKind(kind),
    '',
    ...pitchAngleForKind(kind),
    '',
    '## If receptionist / gatekeeper',
    '- Ask for owner by name if known above; otherwise "who handles marketing or partnerships?"',
    '- If they take a verbal message: 15-second pitch + your callback number',
    '- If they transfer you to VM: you\'re live — leave a personalized message yourself',
  ].join('\n');
  return { subject, body };
};

export const buildWhisperText = (
  lead: Lead,
  enrichment: Enrichment | null,
  kind: VoicemailBridgeKind,
): string => {
  const owner = enrichment?.ownerName ?? 'the owner';
  const signal = enrichment === null ? null : summarizeOneSignal(enrichment.signals);
  const signalSentence = signal === null ? '' : `${signal}. `;
  if (kind === 'voicemail-2') {
    return `Connecting ${owner} from ${lead.name} in ${lead.city}. ${signalSentence}They got your voicemail earlier this week. Go.`;
  }
  return `Connecting ${owner} from ${lead.name} in ${lead.city}. ${signalSentence}First live connect. Go.`;
};
