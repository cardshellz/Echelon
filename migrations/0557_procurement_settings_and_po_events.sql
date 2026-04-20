-- 0557_procurement_settings_and_po_events.sql
-- Spec A (PO Create & Send) — skeleton groundwork.
--
-- (a) Add 9 per-setting toggles to inventory.warehouse_settings. These
--     power the "solo-operator defaults, per-setting flexibility" model.
--     Only `require_approval` and `auto_send_on_approve` are consumed by
--     Spec A directly; the rest are scaffolded for Specs B and C so all
--     procurement settings are managed from one UI from day one.
--
-- (b) Create procurement.po_events — an append-only audit stream for PO
--     lifecycle events (created / submitted / approved / sent_to_vendor
--     / edited / duplicated_from). Separate from po_status_history so
--     non-status events (edits, sends, duplicates) have somewhere to
--     live without polluting the status machine table.
--
-- Safe to re-run: IF NOT EXISTS on every column + table + index.

-- ---------------------------------------------------------------------
-- (a) procurement settings columns on warehouse_settings
-- ---------------------------------------------------------------------

ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS require_approval                    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS auto_send_on_approve                BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS require_acknowledge_before_receive  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS hide_incoterms_domestic             BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS enable_shipment_tracking            BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_putaway_location               BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_close_on_reconcile             BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS one_click_receive_start             BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS use_new_po_editor                   BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------
-- (b) procurement.po_events — PO lifecycle audit trail
-- ---------------------------------------------------------------------
-- actor_type: 'user' | 'agent' | 'system'
--   user   — a logged-in human performed the action
--   agent  — an AI/automation agent
--   system — no explicit actor (cron jobs, auto-advance, etc.)
-- actor_id: users.id for 'user'; free-form string for agents/systems
--           (e.g. 'system:auto', 'agent:auto-draft-job').
-- payload_json: event-specific structured context. Never PII.

CREATE TABLE IF NOT EXISTS procurement.po_events (
  id           BIGSERIAL PRIMARY KEY,
  po_id        INTEGER NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
  event_type   VARCHAR(40) NOT NULL,
  actor_type   VARCHAR(20) NOT NULL,
  actor_id     VARCHAR(100),
  payload_json JSONB,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT po_events_actor_type_check
    CHECK (actor_type IN ('user', 'agent', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_po_events_po_id_created_at
  ON procurement.po_events (po_id, created_at DESC);
