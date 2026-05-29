import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { invalidateEngagementCache } from '../outreach/emailEngagementStats.js';
import { verifyOpenTrackToken } from '../shared/openTrackToken.js';

const OPEN_ACTION = 'email.opened';
const USER_AGENT_MAX = 240;
// Standard 1×1 transparent GIF — returned even on bad requests so clients
// don't retry aggressively on broken pixels.
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const openTrackRouter = express.Router();

const sendPixel = (res: express.Response): void => {
  res
    .status(200)
    .type('gif')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate')
    .send(TRANSPARENT_GIF);
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

openTrackRouter.get('/track/open/:draftId', async (req, res) => {
  const draftId = req.params.draftId;
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (typeof draftId !== 'string' || draftId === '' || !verifyOpenTrackToken(draftId, sig)) {
    sendPixel(res);
    return;
  }

  const existing = await prisma.auditLog.findFirst({
    where: { action: OPEN_ACTION, entity: 'Draft', entityId: draftId },
    select: { id: true },
  });

  if (existing === null) {
    const draft = await prisma.draft.findUnique({
      where: { id: draftId },
      select: { id: true, leadId: true, kind: true, status: true },
    });
    if (draft !== null && (draft.status === 'sent' || draft.status === 'auto-sent')) {
      const userAgent = truncate(String(req.headers['user-agent'] ?? ''), USER_AGENT_MAX);
      await prisma.auditLog.create({
        data: {
          action: OPEN_ACTION,
          entity: 'Draft',
          entityId: draftId,
          meta: {
            leadId: draft.leadId,
            kind: draft.kind,
            userAgent,
            openedAt: new Date().toISOString(),
          },
        },
      });
      invalidateEngagementCache();
    }
  }

  sendPixel(res);
});
