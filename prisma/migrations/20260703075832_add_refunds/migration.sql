-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "RefundClaimStatus" AS ENUM ('PENDING', 'CLAIMED', 'FAILED');

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "reason" TEXT,
    "total_amount" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "total_shares" DECIMAL(28,7),
    "total_claimed" DECIMAL(28,7) NOT NULL DEFAULT 0,
    "merkle_root" VARCHAR(66),
    "snapshot_ledger" BIGINT,
    "cancel_tx_hash" VARCHAR(64),
    "set_refund_tx_hash" VARCHAR(64),
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "refund_error" TEXT,
    "refund_attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_claims" (
    "id" UUID NOT NULL,
    "refund_id" UUID NOT NULL,
    "investor_id" UUID NOT NULL,
    "share_amount" DECIMAL(28,7) NOT NULL,
    "amount" DECIMAL(28,7) NOT NULL,
    "merkle_proof" TEXT[],
    "leaf_index" INTEGER,
    "claim_tx_hash" VARCHAR(64),
    "status" "RefundClaimStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "refund_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_campaign_id_key" ON "refunds"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_cancel_tx_hash_key" ON "refunds"("cancel_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_set_refund_tx_hash_key" ON "refunds"("set_refund_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refund_claims_claim_tx_hash_key" ON "refund_claims"("claim_tx_hash");

-- CreateIndex
CREATE INDEX "refund_claims_investor_id_idx" ON "refund_claims"("investor_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_claims_refund_id_investor_id_key" ON "refund_claims"("refund_id", "investor_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_claims" ADD CONSTRAINT "refund_claims_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_claims" ADD CONSTRAINT "refund_claims_investor_id_fkey" FOREIGN KEY ("investor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
