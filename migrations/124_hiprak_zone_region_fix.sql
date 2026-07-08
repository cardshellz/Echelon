-- Fix: HIPRAK zone rules never matched at resolution time.
--
-- resolveZone (domain/zones.ts) deliberately skips region-scoped rules — it
-- has no region input to verify, mirroring the dropship SQL where a NULL
-- region parameter never matches a region-scoped row. Migration 119 seeded
-- the AK/HI/PR/VI prefix rules WITH destination_region set as an
-- informational label, which made every US-HIPRAK rule permanently
-- unmatchable: all HI/AK/PR destinations fell through to the US-48 default.
-- Caught by quoting through the real engine code against the draft tables.
--
-- The state label belongs nowhere; NULL it so the prefix rules participate.
UPDATE shipping.zone_rules
SET destination_region = NULL, updated_at = now()
WHERE zone = 'US-HIPRAK' AND destination_region IS NOT NULL;
