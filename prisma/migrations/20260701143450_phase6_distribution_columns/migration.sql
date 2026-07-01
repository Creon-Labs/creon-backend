-- AlterEnum
ALTER TYPE "DistributionStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "profit_distributions" ADD COLUMN     "distribution_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "distribution_error" TEXT,
ADD COLUMN     "onchain_id" INTEGER NOT NULL,
ADD COLUMN     "set_distribution_tx_hash" VARCHAR(64),
ALTER COLUMN "total_shares" DROP NOT NULL,
ALTER COLUMN "reward_per_share" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "profit_distributions_set_distribution_tx_hash_key" ON "profit_distributions"("set_distribution_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "profit_distributions_campaign_id_onchain_id_key" ON "profit_distributions"("campaign_id", "onchain_id");
