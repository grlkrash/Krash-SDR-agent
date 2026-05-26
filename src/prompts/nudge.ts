// Nudge drafter prompt. The lead corresponded with us recently — either we
// sent them a cold email that they never replied to (awaiting-reply path),
// or Sonia paused an active draft mid-sequence and now wants to re-engage
// from a different angle (paused-undo path). Either way the prior thread is
// referenced vaguely and the email leads with one concrete fact about THEIR
// facility. No greeting fluff, no "just checking in," no pricing.

import type { Enrichment, Lead, Prisma } from '@prisma/client';
import { z } from 'zod';

export const NUDGE_SYSTEM = `Write a short check-in to a treatment-center prospect we recently corresponded with but who has gone quiet. Reference the prior thread vaguely ('after our chat last week', 'following up on my note'). One specific value-prop hook tied to a known fact about THEIR facility (named missing directory, hiring role, detected tech, owner name). End with a clear ask: 15-min call OR a yes/no question. 60 words max. No greeting fluff. No 'just checking in'. No pricing, no tier names ('Claimed', 'Select', 'Premium'), no dollar amounts.

Output ONLY valid JSON. No preamble, no markdown fences. Schema: { "subject": string, "body": string }`;

// Internal signal-priority for picking the 1-2 strongest hooks to surface to
// the drafter. Mirrors queue.ts's SignalsSchema but local-only — the prompt
// builder should not import UI rendering code.
const SignalsSchema = z
  .object({
    competingDirectories: z
      .object({ missingFromAll: z.boolean().optional() })
      .partial()
      .optional(),
    hiring: z
      .object({
        active: z.boolean().optional(),
        roleTitles: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    techStack: z
      .object({ bigSpenderScore: z.number().optional() })
      .partial()
      .optional(),
  })
  .partial();

const TOP_SIGNALS = 2;
const HIRING_ROLE_CAP = 2;
const BIG_SPENDER_FLOOR = 2;

const extractTopSignals = (signalsJson: Prisma.JsonValue): string[] => {
  const parsed = SignalsSchema.safeParse(signalsJson);
  if (!parsed.success) return [];
  const s = parsed.data;
  const out: string[] = [];
  if (s.competingDirectories?.missingFromAll === true) {
    out.push('missing from Psychology Today + Rehabs.com + Recovery.com');
  }
  if (s.hiring?.active === true) {
    const titles = (s.hiring.roleTitles ?? []).slice(0, HIRING_ROLE_CAP).join(', ');
    out.push(titles === '' ? 'actively hiring' : `actively hiring: ${titles}`);
  }
  const score = s.techStack?.bigSpenderScore ?? 0;
  if (score >= BIG_SPENDER_FLOOR) {
    out.push(`marketing tech stack score ${score} (big spender)`);
  }
  return out.slice(0, TOP_SIGNALS);
};

export const buildNudgeUser = (
  lead: Lead,
  enrichment: Enrichment,
  priorDraftBody: string,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
  ];
  if (enrichment.ownerName !== null) {
    lines.push(`owner: ${enrichment.ownerName}`);
  }
  const signals = extractTopSignals(enrichment.signals);
  if (signals.length > 0) {
    lines.push('signals:');
    for (const sig of signals) lines.push(`  - ${sig}`);
  }
  return [
    lines.join('\n'),
    '',
    'Prior thread tone reference:',
    priorDraftBody,
  ].join('\n');
};
