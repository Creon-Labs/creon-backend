-- CreateEnum
CREATE TYPE "ProposalMediaKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateTable
CREATE TABLE "proposal_media" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "campaign_id" UUID,
    "kind" "ProposalMediaKind" NOT NULL,
    "object_key" TEXT NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "original_name" TEXT,
    "size_bytes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "proposal_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proposal_media_proposal_id_kind_idx" ON "proposal_media"("proposal_id", "kind");

-- CreateIndex
CREATE INDEX "proposal_media_campaign_id_idx" ON "proposal_media"("campaign_id");

-- AddForeignKey
ALTER TABLE "proposal_media" ADD CONSTRAINT "proposal_media_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_media" ADD CONSTRAINT "proposal_media_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
