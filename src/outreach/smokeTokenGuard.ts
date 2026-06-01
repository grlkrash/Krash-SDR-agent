// Hard gate against smoke-test leakage. Drafts seeded by seedSmokeTestLanes.ts
// carry deliberate identifying tokens — the all-caps "SMOKE " name prefix and
// "smoke test" markers in subjects/bodies. Those tokens are useful for spotting
// test mail in the operator's own inbox, but must NEVER reach a real prospect.
//
// This is the binary send-time gate: if a draft carries a smoke token and the
// recipient is not the operator's own smoke-test/brief inbox, the sender
// refuses to deliver it. Detection (not scrubbing) is intentional — stripping
// "SMOKE " out of "SMOKE Cold Test Recovery LLC" would mangle the company name
// and ship broken copy; a token-bearing draft headed for a real inbox is a bug
// to surface, not silently rewrite.

const SMOKE_TOKEN_PATTERNS: ReadonlyArray<{ label: string; rx: RegExp }> = [
  { label: 'SMOKE name prefix', rx: /\bSMOKE\s/ },
  { label: 'smoke-test marker', rx: /smoke[\s-]?test/i },
];

export const findSmokeTokens = (text: string): string[] =>
  SMOKE_TOKEN_PATTERNS.flatMap((p) => (p.rx.test(text) ? [p.label] : []));

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

// The only addresses a token-bearing draft may go to: the operator's own
// smoke-test inbox or the daily-brief recipient (both are Sonia's own mailbox).
export const isSmokeTestRecipient = (email: string): boolean => {
  const target = normalizeEmail(email);
  if (target === '') return false;
  const allow = [process.env.SMOKE_TEST_EMAIL, process.env.BRIEF_RECIPIENT]
    .map((e) => normalizeEmail(e ?? ''))
    .filter((e) => e !== '');
  return allow.includes(target);
};
