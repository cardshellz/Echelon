-- The allowed values of channels.channels.sync_mode. Production has this check
-- only because the legacy schema fallback in server/db.ts added it; no tracked
-- migration declared it, so a database built from migrations alone would lack
-- it. The fallback block is retired in the same change (REFACTOR-PLAN P4.1).
--
-- In production the constraint already exists, so this changes nothing there.
-- The table is schema-qualified on purpose: the fallback's unqualified
-- "channels" could resolve to a leftover public.channels.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'channels.channels'::regclass
      AND conname = 'channels_sync_mode_check'
  ) THEN
    ALTER TABLE channels.channels
      ADD CONSTRAINT channels_sync_mode_check
      CHECK (sync_mode IN ('live', 'dry_run'));
  END IF;
END $$;
