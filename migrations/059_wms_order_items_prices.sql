-- Migration: 059_wms_order_items_prices
-- Adds per-line price columns to wms.order_items.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.2, §6 Group A Commit 3.
--
-- Purpose:
--   wms.order_items currently has no price columns at all (see
--   shared/schema/orders.schema.ts:168-202). The ShipStation push and any
--   other WMS-only reader must be able to resolve per-line prices without
--   reaching back into OMS. This commit adds three bigint cents columns
--   that the OMS→WMS sync (Group B) will snapshot at creation time; WMS
--   owns them thereafter. No data migration / backfill happens here.
--
--   Column semantics mirror oms.oms_order_lines (oms.schema.ts:109-110):
--     unit_price_cents  — per-unit price paid (what SS expects as unitPrice)
--     paid_price_cents  — per-unit paid after discounts (matches OMS paidPriceCents)
--     total_price_cents — line extended total (unit × qty, post-discount;
--                         matches OMS totalPriceCents)
--
-- Safety:
--   - Fully idempotent: every column uses ADD COLUMN IF NOT EXISTS.
--   - Zero data risk: no existing code reads these columns; defaults of 0
--     are inert until Group B sync writes real values.
--   - Reverse migration: migrations/reverse/059_wms_order_items_prices.sql
--     drops each column with DROP COLUMN IF EXISTS.
--   - Designed for Heroku release phase execution.

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS unit_price_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS paid_price_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE wms.order_items
  ADD COLUMN IF NOT EXISTS total_price_cents bigint NOT NULL DEFAULT 0;
