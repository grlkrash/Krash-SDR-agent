-- AlterTable
ALTER TABLE "Lead" ADD COLUMN "priorWrittenConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lead" ADD COLUMN "priorWrittenConsentAt" TIMESTAMP(3);
