-- 0562_receiving_lines_unit_cost_mills.sql
-- 4-decimal per-unit cost precision for procurement.receiving_lines.
--
-- Follow-up to 0561_unit_cost_mills.sql. That migration intentionally skipped
-- receiving_lines because the table uses the column name `unit_cost` (not
-- `unit_cost_cents`). Per Overlord 2026-04-22: receiving MUST be able to
-- record actual per-unit cost at 4-decimal precision — not just inherit from
-- the PO line. Cases include damaged-unit write-offs, freight allocation
-- adjustments, and any receive-time cost override that differs from the PO.
--
-- Invariants:
--   * `unit_cost` (cents) is NOT dropped or renamed. It stays populated by
--     the service layer (rounded half-up from mills) for back-compat with
--     any consumer that hasn't migrated yet.
--   * `unit_cost_mills` is the authoritative 4-decimal source when present.
--   * No data migration needed — column starts NULL and is filled by the
--     updated receiving.service.ts code paths going forward.
--
-- Safe to re-run: column uses IF NOT EXISTS.

ALTER TABLE procurement.receiving_lines
  ADD COLUMN IF NOT EXISTS unit_cost_mills BIGINT;

COMMENT ON COLUMN procurement.receiving_lines.unit_cost_mills IS
  'Per-unit receive-time cost in mills (1/10000 of a dollar). Authoritative when present; unit_cost (cents) is kept in sync (rounded half-up) for back-compat. Source priority: manual override > purchase_order_lines.unit_cost_mills > centsToMills(purchase_order_lines.unit_cost_cents).';
