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
  2: (ctx) => ({
    subject: 'quick bump',
    body:
      ctx.bookingUrl !== undefined
        ? `Bumping this up — saw ${ctx.facility} has ${ctx.googleReviews ?? 'limited'} Google reviews, which makes getting more intake inquiries from family searches worth a quick look.\n\nGrab a time here if helpful: ${ctx.bookingUrl}`
        : `Bumping this up — saw ${ctx.facility} has ${ctx.googleReviews ?? 'limited'} Google reviews, which makes getting more intake inquiries from family searches worth a quick look.\n\nWorth 10 mins this week?`,
  }),
  3: (ctx) => ({
    subject: 'two quick things',
    body:
      ctx.bookingUrl !== undefined
        ? `Last week pinged you about ${ctx.facility}. For context: centers your size typically add 8-15 new family inquiries/month when families searching in your market can actually reach them.\n\nIf a brief look makes sense: ${ctx.bookingUrl}`
        : `Last week pinged you about ${ctx.facility}. For context: centers your size typically add 8-15 new family inquiries/month when families searching in your market can actually reach them.\n\nOpen to a brief look?`,
  }),
  4: (ctx) => ({
    subject: 'should i circle back',
    body: `Should I assume directory visibility isn't a priority right now? Happy to circle back in ${ctx.nextQ ?? 'a few weeks'} — totally fine to say "later."`,
  }),
  5: (ctx) => ({
    subject: 'closing the loop',
    body: `Closing the loop on this. If anything changes on ${ctx.facility}'s listing strategy, my line is open: ${ctx.phone ?? '(reply to this email)'}.`,
  }),
};
