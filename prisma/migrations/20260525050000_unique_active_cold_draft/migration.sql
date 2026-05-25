CREATE UNIQUE INDEX "unique_active_cold_draft"
ON "Draft" ("leadId", "kind")
WHERE status != 'rejected' AND kind = 'cold';
