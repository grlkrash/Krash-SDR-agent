import { hs, hsRetry } from './hubspot.js';
import { findDealForCompany } from './ensureHubspotDeal.js';

const DEFAULT_PIPELINE = 'default';
const CACHE_MS = 300_000;

export type DealStageOption = {
  id: string;
  label: string;
  pipelineId: string;
};

let cachedStages: DealStageOption[] | null = null;
let cachedAt = 0;

export const loadDealStageOptions = async (): Promise<DealStageOption[]> => {
  const now = Date.now();
  if (cachedStages !== null && now - cachedAt < CACHE_MS) return cachedStages;

  const pipelines = await hsRetry(() => hs.crm.pipelines.pipelinesApi.getAll('deals'));
  const options: DealStageOption[] = [];
  for (const pipeline of pipelines.results) {
    for (const stage of pipeline.stages) {
      if (stage.archived === true) continue;
      options.push({
        id: stage.id,
        label: `${pipeline.label} → ${stage.label}`,
        pipelineId: pipeline.id,
      });
    }
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  cachedStages = options;
  cachedAt = now;
  return options;
};

export const updateDealStage = async (opts: {
  dealId: string;
  stageId: string;
  pipelineId?: string;
}): Promise<void> => {
  const pipelineId = opts.pipelineId ?? DEFAULT_PIPELINE;
  await hsRetry(() =>
    hs.crm.deals.basicApi.update(opts.dealId, {
      properties: {
        dealstage: opts.stageId,
        pipeline: pipelineId,
      },
    }),
  );
};

export const getDealStageForLead = async (opts: {
  leadId: string;
  companyId: string | null;
}): Promise<{ dealId: string | null; stageId: string | null }> => {
  if (opts.companyId === null) return { dealId: null, stageId: null };
  const dealId = await findDealForCompany(opts.companyId);
  if (dealId === null) return { dealId: null, stageId: null };
  const deal = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(dealId, ['dealstage']),
  );
  return { dealId, stageId: deal.properties.dealstage ?? null };
};
