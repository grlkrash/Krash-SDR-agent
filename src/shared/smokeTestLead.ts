// Smoke-test lead bypass for operator VM validation on a personal/VoIP number.
// Set SMOKE_TEST_LEAD_ID on web + cron to the Lead.id of the test facility.

const smokeTestLeadId = (): string | null => {
  const raw = process.env.SMOKE_TEST_LEAD_ID?.trim() ?? '';
  return raw === '' ? null : raw;
};

export const isSmokeTestLead = (leadId: string): boolean => {
  const configured = smokeTestLeadId();
  return configured !== null && configured === leadId;
};
