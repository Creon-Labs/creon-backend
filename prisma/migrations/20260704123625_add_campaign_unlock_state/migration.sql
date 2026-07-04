-- CreateEnum
CREATE TYPE "UnlockStatus" AS ENUM ('PENDING', 'UNLOCKING', 'UNLOCKED', 'FAILED');

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "unlock_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unlock_error" TEXT,
ADD COLUMN     "unlock_status" "UnlockStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "unlock_tx_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_unlock_tx_hash_key" ON "campaigns"("unlock_tx_hash");
