-- Dropship V2 shipping quote foundation.
-- Canonical design: DROPSHIP-V2-CONSOLIDATED-DESIGN.md

CREATE TABLE IF NOT EXISTS dropship.dropship_shipping_markup_config (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name varchar(120) NOT NULL,
  markup_bps integer NOT NULL DEFAULT 0,
  fixed_markup_cents bigint NOT NULL DEFAULT 0,
  min_markup_cents bigint,
  max_markup_cents bigint,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_shipping_markup_bps_chk CHECK (markup_bps >= 0 AND markup_bps <= 10000),
  CONSTRAINT dropship_shipping_markup_bounds_chk CHECK (
    fixed_markup_cents >= 0
    AND (min_markup_cents IS NULL OR min_markup_cents >= 0)
    AND (max_markup_cents IS NULL OR max_markup_cents >= 0)
    AND (min_markup_cents IS NULL OR max_markup_cents IS NULL OR max_markup_cents >= min_markup_cents)
  )
);

ALTER TABLE dropship.dropship_shipping_quote_snapshots
  ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200),
  ADD COLUMN IF NOT EXISTS request_hash varchar(128);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_shipping_quote_vendor_idem_idx
  ON dropship.dropship_shipping_quote_snapshots(vendor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
