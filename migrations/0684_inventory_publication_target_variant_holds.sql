-- SKU-level publication hold on a live canonical inventory publication target.
--
-- A destination hold (migration 0677, inventory_publication_targets.hold_*)
-- zeroes every SKU a target publishes. A row in this table holds ONE SKU of a
-- target: the target stays live and keeps publishing the rest of its catalog
-- as planned, while the held SKU publishes zero for as long as the row exists.
-- The first use is the Dropship listing tiers: a vendor whose wallet is below
-- the case-tier minimum keeps selling packs while their case listings show
-- nothing for sale.
--
-- The row is the hold; releasing deletes it. A hold on a SKU the target has no
-- mapping for is kept: if the SKU is listed later, it publishes zero from its
-- first plan. Every hold and release bumps the target revision, like a
-- destination hold, so an operator command carrying a stale revision is
-- refused like any other change.

CREATE TABLE IF NOT EXISTS inventory.inventory_publication_target_variant_holds (
  publication_target_id INTEGER NOT NULL
    REFERENCES inventory.inventory_publication_targets(id) ON DELETE CASCADE,
  product_variant_id INTEGER NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  hold_reason VARCHAR(120) NOT NULL,
  held_at TIMESTAMPTZ NOT NULL,
  held_by VARCHAR(100) NOT NULL,
  CONSTRAINT inventory_publication_target_variant_holds_pkey
    PRIMARY KEY (publication_target_id, product_variant_id),
  CONSTRAINT inventory_publication_target_variant_holds_reason_chk
    CHECK (hold_reason = btrim(hold_reason) AND hold_reason <> ''),
  CONSTRAINT inventory_publication_target_variant_holds_actor_chk
    CHECK (held_by = btrim(held_by) AND held_by <> '')
);

CREATE INDEX IF NOT EXISTS inventory_publication_target_variant_holds_variant_idx
  ON inventory.inventory_publication_target_variant_holds (product_variant_id);

COMMENT ON TABLE inventory.inventory_publication_target_variant_holds IS
  'SKU-level publication hold: while the row exists the live target publishes zero for this SKU only. Release deletes the row.';
COMMENT ON COLUMN inventory.inventory_publication_target_variant_holds.hold_reason IS
  'Why the SKU is held, as the command that held it stated (e.g. a Dropship listing tier below its minimum).';
COMMENT ON COLUMN inventory.inventory_publication_target_variant_holds.held_by IS
  'The operator or system actor that placed the hold.';
