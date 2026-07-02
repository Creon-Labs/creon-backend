-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('DRAFT', 'PENDING', 'VOTING', 'APPROVED', 'RELEASING', 'RELEASED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "VoteChoice" AS ENUM ('APPROVE', 'REJECT');

-- CreateTable
CREATE TABLE "milestones" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "campaign_id" UUID,
    "order" INTEGER NOT NULL,
    "onchain_index" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(28,7) NOT NULL,
    "status" "MilestoneStatus" NOT NULL DEFAULT 'DRAFT',
    "proof_key" TEXT,
    "voting_started_at" TIMESTAMPTZ,
    "voting_ends_at" TIMESTAMPTZ,
    "voting_extended" BOOLEAN NOT NULL DEFAULT false,
    "snapshot_total_supply" DECIMAL(28,7),
    "release_tx_hash" VARCHAR(64),
    "release_error" TEXT,
    "release_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_votes" (
    "id" UUID NOT NULL,
    "milestone_id" UUID NOT NULL,
    "investor_id" UUID NOT NULL,
    "weight" DECIMAL(28,7) NOT NULL,
    "choice" "VoteChoice" NOT NULL,
    "voted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "milestone_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "milestones_release_tx_hash_key" ON "milestones"("release_tx_hash");

-- CreateIndex
CREATE INDEX "milestones_campaign_id_status_idx" ON "milestones"("campaign_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "milestones_proposal_id_order_key" ON "milestones"("proposal_id", "order");

-- CreateIndex
CREATE INDEX "milestone_votes_investor_id_idx" ON "milestone_votes"("investor_id");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_votes_milestone_id_investor_id_key" ON "milestone_votes"("milestone_id", "investor_id");

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_votes" ADD CONSTRAINT "milestone_votes_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "milestone_votes" ADD CONSTRAINT "milestone_votes_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
