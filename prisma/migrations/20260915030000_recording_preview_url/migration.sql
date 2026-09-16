-- A ~30 second preview a provider serves for the track, plus when we last
-- looked. The timestamp matters as much as the URL: without it, every track
-- that has no preview would be re-queried on every render, making the
-- expensive case the common one.
ALTER TABLE "recording_external_ids" ADD COLUMN "preview_url" TEXT;
ALTER TABLE "recording_external_ids" ADD COLUMN "preview_checked_at" TIMESTAMPTZ(6);
