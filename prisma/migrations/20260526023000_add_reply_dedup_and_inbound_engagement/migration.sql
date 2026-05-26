-- AlterTable
ALTER TABLE "Draft" ADD COLUMN     "hubspotInboundEmailId" TEXT,
ADD COLUMN     "inboundGmailMessageId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Draft_inboundGmailMessageId_key" ON "Draft"("inboundGmailMessageId");
