-- CreateEnum
CREATE TYPE "WhitelistStatus" AS ENUM ('NOT_SYNCED', 'ADDING', 'WHITELISTED', 'REMOVING', 'REMOVED', 'FAILED');

-- AlterEnum
ALTER TYPE "KycStatus" ADD VALUE 'REVOKED';

-- AlterTable
ALTER TABLE "kyc_profiles" ADD COLUMN     "whitelist_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "whitelist_error" TEXT,
ADD COLUMN     "whitelist_remove_tx_hash" VARCHAR(64),
ADD COLUMN     "whitelist_status" "WhitelistStatus" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "whitelist_tx_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_whitelist_tx_hash_key" ON "kyc_profiles"("whitelist_tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "kyc_profiles_whitelist_remove_tx_hash_key" ON "kyc_profiles"("whitelist_remove_tx_hash");

-- CreateIndex
CREATE INDEX "kyc_profiles_whitelist_status_idx" ON "kyc_profiles"("whitelist_status");

