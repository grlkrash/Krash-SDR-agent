export type FollowUpContext = {
  facility: string;
  googleReviews?: number;
  nextQ?: string;
  phone?: string;
  signals?: unknown;
  bookingUrl?: string;
};

export type FollowUpTemplate = (ctx: FollowUpContext) => {
  subject: string;
  body: string;
};

export const FOLLOWUP_TEMPLATES: Record<number, FollowUpTemplate> = {
  // Step 2 (~Day 3): warm follow-up with product reminder + demo ask
  2: (ctx) => ({
    subject: 'quick bump',
    body:
      ctx.bookingUrl !== undefined
        ? `Hi, I wanted to follow up and see if you had a chance to review my note about Sobriety Select. We help facilities like ${ctx.facility} connect with individuals and families actively searching for care, with rich profiles that show insurance, services, and verified reviews so inquiries are better aligned.\n\nEven a quick 10-15 minute demo can give you a clear sense of what that looks like for your team. Would you be open to connecting this week? Grab a time here: ${ctx.bookingUrl}\n\nOr just reply with a time that works. Happy to work around your schedule.`
        : `Hi, I wanted to follow up and see if you had a chance to review my note about Sobriety Select. We help facilities like ${ctx.facility} connect with individuals and families actively searching for care, with rich profiles that show insurance, services, and verified reviews so inquiries are better aligned.\n\nEven a quick 10-15 minute demo can give you a clear sense of what that looks like for your team. Would you be open to connecting this week? Just reply with a time that works.`,
  }),
  // Step 3: social proof + census framing
  3: (ctx) => ({
    subject: 'two quick things',
    body:
      ctx.bookingUrl !== undefined
        ? `Last week I reached out about ${ctx.facility}. Two things worth knowing: centers your size typically see 8-15 new family inquiries per month when families searching in their market can actually reach them. Sobriety Select profiles go beyond a basic listing (insurance details, program philosophy, verified reviews) so those inquiries are better aligned from the start.\n\nWith ${ctx.googleReviews ?? 'your'} Google reviews, ${ctx.facility} already has credibility families trust. A stronger directory presence helps convert that trust into intake calls. If a brief look makes sense: ${ctx.bookingUrl}`
        : `Last week I reached out about ${ctx.facility}. Two things worth knowing: centers your size typically see 8-15 new family inquiries per month when families searching in their market can actually reach them. Sobriety Select profiles go beyond a basic listing (insurance details, program philosophy, verified reviews) so those inquiries are better aligned from the start.\n\nWith ${ctx.googleReviews ?? 'your'} Google reviews, ${ctx.facility} already has credibility families trust. A stronger directory presence helps convert that trust into intake calls. Open to a brief look this week?`,
  }),
  // Step 4: breakup with permission to defer
  4: (ctx) => ({
    subject: 'should i circle back',
    body: `Should I assume improving how families find ${ctx.facility} online isn't a priority right now? Totally understand if timing isn't right. Intake teams are stretched thin.\n\nHappy to circle back in ${ctx.nextQ ?? 'a few weeks'} if that's better. Just say "later" and I'll follow up then. If anything changes on your listing or intake strategy before then, my line is always open.`,
  }),
  // Step 5: final close-the-loop
  5: (ctx) => ({
    subject: 'closing the loop',
    body: `Closing the loop on this thread. If anything changes on ${ctx.facility}'s intake or listing strategy down the road, feel free to reach out anytime.\n\nMy direct line: ${ctx.phone ?? '(reply to this email)'}. Wishing you and the team a strong quarter.`,
  }),
};
