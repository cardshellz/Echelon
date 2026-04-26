-- 0564_po_lines_nullable_product_refs.sql
-- Make product_id + product_variant_id nullable on procurement.purchase_order_lines.
--
-- Migration 0563 introduced typed PO lines (product / discount / fee / tax /
-- rebate / adjustment). Non-product lines have no associated product or
-- variant; they reference free-text descriptions instead. The original
-- schema declared product_id and product_variant_id as NOT NULL because
-- every line was assumed to be a product line.
--
-- This migration relaxes that constraint so non-product lines can be
-- inserted with NULL product_id and product_variant_id, matching what the
-- service layer (purchasing.service.createPurchaseOrderWithLines) already
-- emits for typed lines.
--
-- Existing rows are unaffected — they all have a non-null product_id and
-- product_variant_id (since every pre-0563 line was a product). The
-- service-level type-aware validator continues to require both columns on
-- product lines and forbid them on non-product lines, so the constraint is
-- effectively still enforced where it matters.
--
-- Safe to re-run: ALTER COLUMN ... DROP NOT NULL is idempotent.

ALTER TABLE procurement.purchase_order_lines
  ALTER COLUMN product_id DROP NOT NULL,
  ALTER COLUMN product_variant_id DROP NOT NULL;
