ALTER TABLE "proposals" ADD COLUMN "funding_duration_days" INTEGER NOT NULL DEFAULT 30;

-- Existing proposals predate a funding deadline. The default only backfills the
-- required proposal column; their already-created campaigns keep end_at NULL.
