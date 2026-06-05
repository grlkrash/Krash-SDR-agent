// Sonia's live outbound cadence — call-first, then email, then demo-book call.
// State lives in AuditLog (no Sequence table). See outboundSequence.ts.

export const OUTBOUND_STEPS = [
  'cold-call-1',
  'voicemail-1',
  'cold-email',
  'cold-call-2',
  'demo',
  'follow-up',
] as const;

export type OutboundStep = (typeof OUTBOUND_STEPS)[number];

export const OUTBOUND_STEP_LABELS: Record<OutboundStep, string> = {
  'cold-call-1': 'Cold call 1',
  'voicemail-1': 'Voicemail 1',
  'cold-email': 'Cold email 1',
  'cold-call-2': 'Cold call 2 (demo book)',
  demo: 'Demo',
  'follow-up': 'Follow-up',
};

export const OUTBOUND_STEP_HINTS: Record<OutboundStep, string> = {
  'cold-call-1': 'Intro call — offer the free Sobriety Select profile. Log notes in HubSpot.',
  'voicemail-1': 'Leave a short VM if no answer on call 1. Cold email drafts after this step.',
  'cold-email': 'Approve the cold draft on /queue — sends automatically after approval.',
  'cold-call-2': 'Book the discovery demo on the call. Use Book demo when they agree on a time.',
  demo: 'Pull prep brief before the meeting. Meeting should be on your calendar.',
  'follow-up': 'Send recap or reschedule from /queue after the demo.',
};

export const stepIndex = (step: OutboundStep): number => OUTBOUND_STEPS.indexOf(step);
