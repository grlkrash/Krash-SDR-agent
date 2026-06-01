// SDR daily brief — orchestrates section modules under ./brief/.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/objects/meetings/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';
import { MS_PER_HOUR, formatBriefDate } from './brief/shared.js';
import { dedupeLatestScores, enrichDeals, type ScoreFacts } from './brief/deals.js';
import { buildReplyRows, renderNewReplies } from './brief/replies.js';
import { buildHiringSpikeRows, renderHiringSpikes } from './brief/hiringSpikes.js';
import { parseStalledDays, renderAtRisk, renderHotLeads } from './brief/scoring.js';
import { buildCallList, renderCallList } from './brief/callList.js';
import {
  MANUAL_VM_BRIEF_LIMIT,
  buildManualVoicemailRows,
  countOpenManualVm,
  renderManualVoicemailRequired,
} from './brief/manualVm.js';
import {
  RENEWALS_CALL_BRIEF_LIMIT,
  renderRenewalsToCall,
} from './brief/renewalsCall.js';
import {
  REACTIVATIONS_CALL_BRIEF_LIMIT,
  renderReactivationsToCall,
} from './brief/reactivationsCall.js';
import {
  COLD_CALLS_BRIEF_LIMIT,
  renderColdCallsToMake,
} from './brief/coldCalls.js';
import {
  MEETING_FOLLOWUPS_BRIEF_LIMIT,
  renderMeetingFollowups,
} from './brief/meetingFollowups.js';
import { buildRenewalCallRows, countOpenRenewalCalls } from './renewalCallFlag.js';
import {
  buildReactivationCallRows,
  countOpenReactivationCalls,
} from './reactivationCallFlag.js';
import { buildColdCallRows, countOpenColdCalls } from './coldCallFlag.js';
import {
  buildMeetingFollowupRows,
  countOpenMeetingFollowups,
} from './meetingFollowup.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const LOOKBACK_MS = 24 * MS_PER_HOUR;
const HOT_LEADS_LIMIT = 5;
const AT_RISK_LIMIT = 3;
const CALL_LIST_CANDIDATE_POOL = 25;
const REPLY_FEED_LIMIT = 10;
const MEETINGS_SEARCH_LIMIT = 1;

const countMeetingsBookedSince = async (since: Date): Promise<number> => {
  try {
    const res = await hsRetry(() =>
      hs.crm.objects.meetings.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'hs_createdate',
            operator: FilterOperatorEnum.Gte,
            value: String(since.getTime()),
          }],
        }],
        properties: ['hs_createdate'],
        limit: MEETINGS_SEARCH_LIMIT,
      }),
    );
    return res.total ?? 0;
  } catch {
    return 0;
  }
};

export const sendDailyBrief = async (): Promise<void> => {
  const recipient = process.env.BRIEF_RECIPIENT ?? '';
  if (recipient === '') throw new Error('BRIEF_RECIPIENT is not set');
  const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');

  const now = new Date();
  const date = formatBriefDate(now);
  const cutoff = new Date(now.getTime() - LOOKBACK_MS);

  const [
    scoreRows,
    repliedDrafts,
    pendingCount,
    sentCount,
    repliesCount,
    meetingsCount,
    openManualVmCount,
    openRenewalCallCount,
    openReactivationCallCount,
    openColdCallCount,
    openMeetingFollowupCount,
  ] = await Promise.all([
    prisma.score.findMany({
      where: { scoredAt: { gte: cutoff } },
      orderBy: { scoredAt: 'desc' },
      select: {
        hubspotDealId: true,
        score: true,
        expectedCommission: true,
        reasons: true,
        scoredAt: true,
      },
    }),
    prisma.draft.findMany({
      where: { kind: 'replied', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: REPLY_FEED_LIMIT,
      include: { lead: { include: { enrichment: true } } },
    }),
    prisma.draft.count({ where: { status: 'pending' } }),
    prisma.draft.count({
      where: {
        status: { in: ['sent', 'auto-sent'] },
        sentAt: { gte: cutoff },
      },
    }),
    prisma.draft.count({
      where: { kind: 'replied', createdAt: { gte: cutoff } },
    }),
    countMeetingsBookedSince(cutoff),
    countOpenManualVm(),
    countOpenRenewalCalls(),
    countOpenReactivationCalls(),
    countOpenColdCalls(),
    countOpenMeetingFollowups(),
  ]);

  const latestScores = dedupeLatestScores(scoreRows);
  const hotByValue = [...latestScores].sort(
    (a, b) => b.score * b.expectedCommission - a.score * a.expectedCommission,
  );
  // "Hot" is sorted by score × commission, so a $0 weighted lead is not hot —
  // exclude it from the Top 5. The unfiltered hotByValue still feeds the call
  // list below, which prioritizes by score rather than weighted value.
  const hotTop = hotByValue
    .filter((s) => s.score * s.expectedCommission > 0)
    .slice(0, HOT_LEADS_LIMIT);

  const atRiskCandidates = latestScores
    .map((s) => ({ score: s, stalledDays: parseStalledDays(s.reasons) }))
    .filter((x): x is { score: ScoreFacts; stalledDays: number } => x.stalledDays !== null)
    .sort((a, b) => b.stalledDays - a.stalledDays);
  const atRiskTop = atRiskCandidates.slice(0, AT_RISK_LIMIT);

  const callCandidates = hotByValue.slice(0, CALL_LIST_CANDIDATE_POOL);

  const allDealIds = new Set<string>();
  for (const s of hotTop) allDealIds.add(s.hubspotDealId);
  for (const r of atRiskTop) allDealIds.add(r.score.hubspotDealId);
  for (const s of callCandidates) allDealIds.add(s.hubspotDealId);
  const enriched = await enrichDeals([...allDealIds]);

  const callList = buildCallList(callCandidates, enriched);
  const replyRows = await buildReplyRows(repliedDrafts, now);
  const hiringSpikeRows = await buildHiringSpikeRows(cutoff);
  const manualVoicemailRows = await buildManualVoicemailRows({
    since: cutoff,
    limit: MANUAL_VM_BRIEF_LIMIT,
  });
  const renewalCallRows = await buildRenewalCallRows({ limit: RENEWALS_CALL_BRIEF_LIMIT });
  const reactivationCallRows = await buildReactivationCallRows({
    limit: REACTIVATIONS_CALL_BRIEF_LIMIT,
  });
  const coldCallRows = await buildColdCallRows({ limit: COLD_CALLS_BRIEF_LIMIT });
  const meetingFollowupRows = await buildMeetingFollowupRows({
    limit: MEETING_FOLLOWUPS_BRIEF_LIMIT,
  });

  const body = [
    `# 📊 Pipeline brief — ${date}`,
    '',
    renderNewReplies(replyRows, publicUrl),
    '',
    renderHiringSpikes(hiringSpikeRows),
    '',
    renderHotLeads(hotTop, enriched),
    '',
    renderAtRisk(atRiskTop, enriched),
    '',
    renderCallList(callList),
    '',
    renderRenewalsToCall(renewalCallRows, publicUrl, openRenewalCallCount),
    '',
    renderReactivationsToCall(reactivationCallRows, openReactivationCallCount),
    '',
    renderColdCallsToMake(coldCallRows, openColdCallCount),
    '',
    renderMeetingFollowups(meetingFollowupRows, openMeetingFollowupCount),
    '',
    renderManualVoicemailRequired(manualVoicemailRows, publicUrl, openManualVmCount),
    '',
    `## 📥 Queue: ${pendingCount} pending`,
    `## 📈 Yesterday: sent ${sentCount} | replies ${repliesCount} | meetings ${meetingsCount}`,
    '',
  ].join('\n');

  const baseSubject = `📊 Pipeline brief — ${date}`;
  const replyNoun = replyRows.length === 1 ? 'reply' : 'replies';
  const subject = replyRows.length === 0
    ? baseSubject
    : `📬 ${replyRows.length} new ${replyNoun} | ${baseSubject}`;

  await sendEmail({ to: recipient, subject, body, bodyFormat: 'markdown' });

  await prisma.auditLog.create({
    data: {
      action: 'dailyBrief.sent',
      entity: 'dailyBrief',
      meta: {
        date,
        recipient,
        replyCount: replyRows.length,
        hiringSpikeCount: hiringSpikeRows.length,
        hotCount: hotTop.length,
        atRiskCount: atRiskTop.length,
        callListCount: callList.length,
        manualVoicemailCount: manualVoicemailRows.length,
        openManualVmCount,
        openRenewalCallCount,
        openReactivationCallCount,
        openColdCallCount,
        openMeetingFollowupCount,
        pendingCount,
        sentCount,
        repliesCount,
        meetingsCount,
      },
    },
  });
};
