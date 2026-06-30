-- CreateEnum
CREATE TYPE "CampaignDeployStatus" AS ENUM ('PENDING', 'DEPLOYING_TOKEN', 'DEPLOYING_CAMPAIGN', 'WIRING', 'LIVE', 'FAILED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "deploy_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deploy_error" TEXT,
ADD COLUMN     "deploy_status" "CampaignDeployStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "wire_tx_hash" VARCHAR(64);

-- AlterTable
ALTER TABLE "project_tokens" ADD COLUMN     "deploy_tx_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_deploy_tx_hash_key" ON "campaigns"("deploy_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_wire_tx_hash_key" ON "campaigns"("wire_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "project_tokens_deploy_tx_hash_key" ON "project_tokens"("deploy_tx_hash");

