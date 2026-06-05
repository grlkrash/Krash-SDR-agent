// Shared outbound copy voice — CEO feedback: plain human tone, no em dashes,
// ~8th-grade reading level, proof names/numbers against prospect facts.

export const DRAFT_VOICE_RULES = `VOICE AND READABILITY (non-negotiable):
- Write at an 8th-grade reading level. Short sentences. Plain everyday words. No jargon unless the prospect already uses it.
- Sound like a real person emailing a colleague — not a marketing template, not an AI draft.
- NEVER use em dashes (—). Minimize en dashes (–) and dash-as-punctuation ("word - word"). Use periods, commas, or two short sentences instead. Hyphens inside compound words and number ranges (10-15, year-over-year) are fine.
- Before outputting, proofread against the prospect facts: facility name, city, owner name, review counts, and any numbers must be spelled exactly as given. Fix typos and wrong names.`;

export const DRAFT_VOICE_SELF_CHECK = `(voice) No em/en dashes or dash-heavy punctuation? ~8th-grade reading level? Facility name, city, owner, and numbers match prospect facts exactly?`;
