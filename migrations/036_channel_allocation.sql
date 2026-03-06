-- Channel allocation: per-channel inventory allocation + variant hard overrides
-- Run manually: psql $DATABASE_URL -f migrations/036_channel_allocation.sql

-- Channel-level allocation (% of pool or fixed qty)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS allocation_pct INTEGER;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS allocation_fixed_qty INTEGER;

-- Variant-level hard override (push exactly this qty; 0 = force zero; null = use calculated)
ALTER TABLE channel_reservations ADD COLUMN IF NOT EXISTS override_qty INTEGER;
