-- Migration: 061_shipment_tracking_history
-- Creates a new audit table wms.shipment_tracking_history to record every
-- tracking number that has ever been assigned to a wms.outbound_shipments
-- row, including voided / replaced historical values.
--
-- Plan reference: shipstation-flow-refactor-plan.md §4.4, §6 Group A
-- Commit 5, §7 (migration table).
--
-- Purpose:
--   When ShipStation voids a label and reprints a new one (e.g. address
--   correction, damaged label, carrier change), the current tracking on
--   wms.outbound_shipments is overwritten. Customer support and ops need
--   the full trail: every tracking number the shipment ever carried,
--   when each was voided, why, and which new tracking replaced it.
--
-- Safety notes:
--   - NEW table only. No existing table is altered.
--   - No backfill: zero historical rows are inserted; the table is empty
--     at release.
--   - No reader yet: Group D will add the writer (on void/replace) and
--     the lookup. Until that lands this table is inert.
--   - Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS
--     so re-running is a no-op.
--   - Data risk: zero (new table, no reader, no writer at this commit).
--
-- Reverse migration: migrations/reverse/061_shipment_tracking_history.sql
--   Drops the table (and therefore the index) with CASCADE. Safe to run
--   now; dangerous once Group D starts writing (audit history is lost).

CREATE TABLE IF NOT EXISTS wms.shipment_tracking_history (
  id                            bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_id                   integer      NOT NULL REFERENCES wms.outbound_shipments(id) ON DELETE CASCADE,
  tracking_number               varchar(200) NOT NULL,
  carrier                       varchar(100),
  voided_at                     timestamp,
  voided_reason                 varchar(200),
  replaced_at                   timestamp,
  replaced_by_tracking_number   varchar(200),
  created_at                    timestamp    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipment_tracking_history_shipment_id
  ON wms.shipment_tracking_history(shipment_id);
