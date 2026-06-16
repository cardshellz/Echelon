-- Migration 105: Shipping groups (fulfillment equivalence classes)
--
-- Introduces catalog.shipping_groups — the "can this item ship with that item"
-- partition — plus catalog.products.shipping_group_id. A shipping group is
-- distinct from category/product_type: it answers how a product is packed and
-- mailed, and (later) which storefront free-shipping threshold it counts toward.
-- Storage boxes ship flat in materially different mailers and can't be combined
-- with boxed plastic protection, so they need their own group.
--
-- INERT at this phase: no storefront/sync code reads shipping_group_id yet. The
-- Echelon admin (ProductDetail "Fulfillment characteristics" card) and the
-- list endpoint are the only consumers; thresholds remain uniform until a later
-- step wires the per-group threshold through plan_benefits + the cart/Function.
-- Stamping the backfill now is therefore behavior-preserving on the storefront.
--
-- Safety notes:
--   - NEW table + ADDITIVE nullable column + data backfill only; no existing
--     column is altered or dropped.
--   - Idempotent: CREATE TABLE / INDEX / ADD COLUMN use IF NOT EXISTS; the FK is
--     added in a guarded DO-block (pg_constraint check); the seed uses ON CONFLICT
--     (code) DO NOTHING; both backfills are IS NULL-guarded — so a re-run (and the
--     server/db.ts startup-fallback mirror) is a no-op.
--   - Backfill scope is deliberately narrow on the storage-box side: only the
--     real storage boxes (product_type='storage-boxes', or the Tough Box / Quad
--     Box categories) are tagged storage_boxes. This avoids the %box% trap that
--     would mislabel sealed wax "Hobby Box" SKUs and "...Box Treads" accessories.
--     Everything else falls to protection (boxed/combinable — today's behavior).
--   - SIOC / ships-in-own-container is a SEPARATE packaging attribute and is NOT
--     modeled here; it is deferred.
--   - Reverse migration: migrations/reverse/105_shipping_groups.sql.

-- ── Table ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog.shipping_groups (
  id          integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        varchar(50)  NOT NULL UNIQUE,
  name        varchar(100) NOT NULL,
  description text,
  sort_order  integer      DEFAULT 0,
  is_active   boolean      NOT NULL DEFAULT true,
  created_at  timestamp    NOT NULL DEFAULT now(),
  updated_at  timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipping_groups_active_sort
  ON catalog.shipping_groups (is_active, sort_order, name);

-- ── Product FK ───────────────────────────────────────────────────────────────
-- Add the column, then the FK in a guarded DO-block — mirroring
-- 0108_catalog_product_categories.sql. The explicit constraint name matches
-- Drizzle's auto-generated FK name (<table>_<col>_<reftable>_<refcol>_fk) so
-- `drizzle-kit push` sees no drift, and the pg_constraint guard keeps the FK
-- add idempotent on re-run.
ALTER TABLE catalog.products
  ADD COLUMN IF NOT EXISTS shipping_group_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_shipping_group_id_shipping_groups_id_fk'
  ) THEN
    ALTER TABLE catalog.products
      ADD CONSTRAINT products_shipping_group_id_shipping_groups_id_fk
      FOREIGN KEY (shipping_group_id)
      REFERENCES catalog.shipping_groups(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_products_shipping_group
  ON catalog.products (shipping_group_id);

-- ── Seed groups ──────────────────────────────────────────────────────────────
INSERT INTO catalog.shipping_groups (code, name, description, sort_order)
VALUES
  ('protection',    'Protection',    'Boxed plastic protection and general merchandise — combinable in a standard box.', 0),
  ('storage_boxes', 'Storage Boxes', 'Tough Box / Quad Box storage — ship flat in dedicated mailers, cannot combine with boxed protection.', 1)
ON CONFLICT (code) DO NOTHING;

-- ── Backfill: storage boxes first ────────────────────────────────────────────
-- product_type='storage-boxes' is the clean, verified signal (3 products); the
-- Tough Box / Quad Box categories are belt-and-suspenders in case product_type
-- is unset on a row. LOWER() guards against category case variance (the import
-- service stores products.category case-preserved, unlike product_type).
UPDATE catalog.products p
SET shipping_group_id = sg.id, updated_at = now()
FROM catalog.shipping_groups sg
WHERE sg.code = 'storage_boxes'
  AND p.shipping_group_id IS NULL
  AND (p.product_type = 'storage-boxes' OR LOWER(p.category) IN ('tough box', 'quad box'));

-- ── Backfill: everything else → protection (today's uniform behavior) ─────────
-- Safe to blanket-default: shipping_group_id is inert (no storefront/sync reader
-- yet), so this adds zero behavior change until a later step wires per-group
-- thresholds through plan_benefits + the cart/Function.
UPDATE catalog.products p
SET shipping_group_id = sg.id, updated_at = now()
FROM catalog.shipping_groups sg
WHERE sg.code = 'protection'
  AND p.shipping_group_id IS NULL;
