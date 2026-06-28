-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ENTREPRENEUR', 'INVESTOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('PENDING_DEPLOYMENT', 'ACTIVE', 'LOCKED', 'GOAL_REACHED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('PENDING', 'FUNDING', 'LOCKED', 'RELEASED', 'SETTLED');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'CLAIMED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "wallet_address" VARCHAR(56) NOT NULL,
    "email" TEXT,
    "display_name" TEXT,
    "roles" "Role"[] DEFAULT ARRAY['INVESTOR']::"Role"[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" UUID NOT NULL,
    "entrepreneur_id" UUID NOT NULL,
    "business_name" TEXT NOT NULL,
    "business_description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "location" TEXT,
    "requested_amount" DECIMAL(28,7) NOT NULL,
    "lock_period_days" INTEGER NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_reviews" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "admin_id" UUID NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "notes" TEXT,
    "reviewed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "contract_address" VARCHAR(56),
    "goal_amount" DECIMAL(28,7) NOT NULL,
    "raised_amount" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "status" "CampaignStatus" NOT NULL DEFAULT 'PENDING_DEPLOYMENT',
    "lock_start_at" TIMESTAMPTZ,
    "lock_end_at" TIMESTAMPTZ,
    "start_at" TIMESTAMPTZ,
    "end_at" TIMESTAMPTZ,
    "deploy_tx_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tokens" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "asset_code" VARCHAR(12) NOT NULL,
    "issuer_address" VARCHAR(56),
    "contract_address" VARCHAR(56),
    "total_supply" DECIMAL(28,7),
    "is_transferable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "project_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_vaults" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "contract_address" VARCHAR(56),
    "total_deposited" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "released_to_business" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "lock_start_at" TIMESTAMPTZ,
    "lock_end_at" TIMESTAMPTZ,
    "status" "VaultStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "campaign_vaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "investments" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "investor_id" UUID NOT NULL,
    "amount" DECIMAL(28,7) NOT NULL,
    "lp_tokens" DECIMAL(28,7),
    "tx_hash" VARCHAR(64),
    "status" "InvestmentStatus" NOT NULL DEFAULT 'PENDING',
    "invested_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "investments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_holdings" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "holder_id" UUID,
    "holder_address" VARCHAR(56) NOT NULL,
    "balance" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "updated_ledger" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "token_holdings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profit_distributions" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "total_amount" DECIMAL(28,7) NOT NULL,
    "total_shares" DECIMAL(28,7) NOT NULL,
    "reward_per_share" DECIMAL(38,18) NOT NULL,
    "total_claimed" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "merkle_root" VARCHAR(66),
    "snapshot_ledger" BIGINT,
    "deposit_tx_hash" VARCHAR(64),
    "status" "DistributionStatus" NOT NULL DEFAULT 'PENDING',
    "distributed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "profit_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distribution_claims" (
    "id" UUID NOT NULL,
    "distribution_id" UUID NOT NULL,
    "investor_id" UUID NOT NULL,
    "share_amount" DECIMAL(28,7) NOT NULL,
    "amount" DECIMAL(28,7) NOT NULL,
    "merkle_proof" TEXT[],
    "leaf_index" INTEGER,
    "claim_tx_hash" VARCHAR(64),
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "distribution_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_wallet_address_key" ON "users"("wallet_address");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "proposals_status_idx" ON "proposals"("status");

-- CreateIndex
CREATE INDEX "proposals_entrepreneur_id_idx" ON "proposals"("entrepreneur_id");

-- CreateIndex
CREATE INDEX "proposal_reviews_proposal_id_idx" ON "proposal_reviews"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_proposal_id_key" ON "campaigns"("proposal_id");

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");

-- CreateIndex
CREATE UNIQUE INDEX "project_tokens_campaign_id_key" ON "project_tokens"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_vaults_campaign_id_key" ON "campaign_vaults"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "investments_tx_hash_key" ON "investments"("tx_hash");

-- CreateIndex
CREATE INDEX "investments_campaign_id_status_idx" ON "investments"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "investments_investor_id_idx" ON "investments"("investor_id");

-- CreateIndex
CREATE INDEX "token_holdings_holder_id_idx" ON "token_holdings"("holder_id");

-- CreateIndex
CREATE UNIQUE INDEX "token_holdings_campaign_id_holder_address_key" ON "token_holdings"("campaign_id", "holder_address");

-- CreateIndex
CREATE UNIQUE INDEX "profit_distributions_deposit_tx_hash_key" ON "profit_distributions"("deposit_tx_hash");

-- CreateIndex
CREATE INDEX "profit_distributions_campaign_id_idx" ON "profit_distributions"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_claims_claim_tx_hash_key" ON "distribution_claims"("claim_tx_hash");

-- CreateIndex
CREATE INDEX "distribution_claims_investor_id_idx" ON "distribution_claims"("investor_id");

-- CreateIndex
CREATE UNIQUE INDEX "distribution_claims_distribution_id_investor_id_key" ON "distribution_claims"("distribution_id", "investor_id");

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_entrepreneur_id_fkey" FOREIGN KEY ("entrepreneur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_reviews" ADD CONSTRAINT "proposal_reviews_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_reviews" ADD CONSTRAINT "proposal_reviews_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tokens" ADD CONSTRAINT "project_tokens_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_vaults" ADD CONSTRAINT "campaign_vaults_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "investments" ADD CONSTRAINT "investments_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_holdings" ADD CONSTRAINT "token_holdings_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_holdings" ADD CONSTRAINT "token_holdings_holder_id_fkey" FOREIGN KEY ("holder_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_distributions" ADD CONSTRAINT "profit_distributions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_claims" ADD CONSTRAINT "distribution_claims_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "profit_distributions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "distribution_claims" ADD CONSTRAINT "distribution_claims_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
