-- Rename EntrepreneurProfile -> KycProfile (one KYC per user, role-agnostic).
-- Done as in-place renames so existing rows are preserved.
ALTER TABLE "entrepreneur_profiles" RENAME TO "kyc_profiles";

ALTER TABLE "kyc_profiles" RENAME CONSTRAINT "entrepreneur_profiles_pkey" TO "kyc_profiles_pkey";
ALTER TABLE "kyc_profiles" RENAME CONSTRAINT "entrepreneur_profiles_user_id_fkey" TO "kyc_profiles_user_id_fkey";
ALTER TABLE "kyc_profiles" RENAME CONSTRAINT "entrepreneur_profiles_reviewed_by_id_fkey" TO "kyc_profiles_reviewed_by_id_fkey";

ALTER INDEX "entrepreneur_profiles_user_id_key" RENAME TO "kyc_profiles_user_id_key";
ALTER INDEX "entrepreneur_profiles_national_id_key" RENAME TO "kyc_profiles_national_id_key";
ALTER INDEX "entrepreneur_profiles_status_idx" RENAME TO "kyc_profiles_status_idx";
