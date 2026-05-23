-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "street" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT,
    "addressHash" TEXT NOT NULL,
    "phoneE164" TEXT,
    "website" TEXT,
    "googleRating" DOUBLE PRECISION,
    "googleReviews" INTEGER,
    "services" TEXT[],
    "sourceMeta" JSONB NOT NULL,
    "hubspotCompanyId" TEXT,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrichment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ownerName" TEXT,
    "ownerTitle" TEXT,
    "ownerEmail" TEXT,
    "ownerLinkedIn" TEXT,
    "teamSizeSignal" TEXT,
    "expectedProduct" TEXT,
    "painPoints" JSONB NOT NULL,
    "signals" JSONB NOT NULL DEFAULT '{}',
    "legitscriptStatus" TEXT,
    "evidenceQuote" TEXT,
    "enrichedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrichment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audioMp3" BYTEA,
    "personalizationPct" INTEGER,
    "specificFacts" TEXT[],
    "status" TEXT NOT NULL,
    "rejectReason" TEXT,
    "approvedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "gmailMessageId" TEXT,
    "hubspotEmailId" TEXT,
    "twilioCallSid" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "email" TEXT NOT NULL DEFAULT '',
    "phoneE164" TEXT NOT NULL DEFAULT '',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("email","phoneE164")
);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "hubspotDealId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "expectedCommission" INTEGER NOT NULL,
    "reasons" TEXT[],
    "scoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KBChunk" (
    "id" TEXT NOT NULL,
    "docPath" TEXT NOT NULL,
    "chunkIdx" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "KBChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_state_city_idx" ON "Lead"("state", "city");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_nameNormalized_addressHash_key" ON "Lead"("nameNormalized", "addressHash");

-- CreateIndex
CREATE UNIQUE INDEX "Enrichment_leadId_key" ON "Enrichment"("leadId");

-- CreateIndex
CREATE INDEX "Draft_status_createdAt_idx" ON "Draft"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Draft_leadId_kind_idx" ON "Draft"("leadId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "KBChunk_docPath_chunkIdx_key" ON "KBChunk"("docPath", "chunkIdx");

-- AddForeignKey
ALTER TABLE "Enrichment" ADD CONSTRAINT "Enrichment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
