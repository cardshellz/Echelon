-- Dropship listing tiers: what each vendor currently has taken off sale.
--
-- A vendor's catalog sells in two tiers, each with a minimum wallet balance on
-- the wallet policy (0683): packs (the policy floor) and cases
-- (case_tier_minimum_cents). The hourly maintenance tick decides per vendor
-- which tiers are held (pack: the minimum is not kept; case: the balance,
-- counting pending credits, is below the case minimum) and asks inventory
-- planning to publish zero for the listed SKUs of a held tier
-- (0684, SKU-level publication hold).
--
-- This row records the decision and whether the planner has applied it. The
-- decision is the fact; applying it is a side effect that may be deferred (a
-- provider quantity request in flight) and is retried on the next tick until
-- `applied` is true. `revision` bumps on every change of held tiers and keys
-- the hold/release commands and the vendor notices, so a retry replays
-- instead of repeating. One row per vendor; the audit trail of each change is
-- a dropship_audit_events row written in the same transaction.

CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_listing_tier_holds (
  vendor_id integer PRIMARY KEY REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  held_tiers text[] NOT NULL DEFAULT '{}',
  revision integer NOT NULL DEFAULT 0,
  applied boolean NOT NULL DEFAULT false,
  detail text,
  evaluated_at timestamptz NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_vendor_listing_tier_holds_tiers_chk
    CHECK (held_tiers <@ ARRAY['pack', 'case']::text[]),
  CONSTRAINT dropship_vendor_listing_tier_holds_revision_chk
    CHECK (revision >= 0)
);

CREATE INDEX IF NOT EXISTS dropship_vendor_listing_tier_holds_unapplied_idx
  ON dropship.dropship_vendor_listing_tier_holds (evaluated_at)
  WHERE applied = false;

COMMENT ON TABLE dropship.dropship_vendor_listing_tier_holds IS
  'Per-vendor listing tiers currently taken off sale (pack, case) and whether inventory planning has applied the matching SKU holds.';
COMMENT ON COLUMN dropship.dropship_vendor_listing_tier_holds.held_tiers IS
  'Tiers whose listed SKUs must publish zero; empty when every tier is on sale.';
COMMENT ON COLUMN dropship.dropship_vendor_listing_tier_holds.revision IS
  'Bumped on every change of held_tiers; keys the planner commands and the vendor notices.';
COMMENT ON COLUMN dropship.dropship_vendor_listing_tier_holds.applied IS
  'True once every store connection carries the SKU holds and releases this revision asks for.';
