-- Dropship returns policy foundation (B1).
-- Spec: dropship-returns-design-spec.md (D1, D2, D2a, D-governing) +
--       dropship-returns-build-spec.md.
--
-- All return policy behavior is versioned, immutable config. Once a policy
-- row's effective_from passes, its money fields never mutate; changes are new
-- versions. Resolution is hierarchical: vendor+store > vendor > store > global,
-- tie-break priority DESC then id DESC. Exactly one active global row exists.

-- 1. Hierarchical return window policies (replaces dropship_return_policy_config
--    as the read source; the legacy table stays readable for release-phase
--    safety but is DEPRECATED — do not write new rows to it).

CREATE TABLE IF NOT EXISTS dropship.dropship_return_policies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL DEFAULT 1,
  return_window_days integer NOT NULL DEFAULT 30,
  vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_return_policies_version_chk CHECK (version > 0),
  CONSTRAINT dropship_return_policies_window_chk CHECK (return_window_days > 0 AND return_window_days <= 365),
  CONSTRAINT dropship_return_policies_effective_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT dropship_return_policies_scope_chk CHECK (
    vendor_id IS NOT NULL OR store_connection_id IS NULL
  )
);

-- Exactly one active global row (vendor_id IS NULL AND store_connection_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS dropship_return_policies_one_active_global_idx
  ON dropship.dropship_return_policies((true))
  WHERE vendor_id IS NULL AND store_connection_id IS NULL AND is_active;

CREATE INDEX IF NOT EXISTS dropship_return_policies_scope_idx
  ON dropship.dropship_return_policies(vendor_id, store_connection_id, is_active, effective_from);

-- Seed the global 30-day default row (version 1, active) if no active global
-- row exists yet. Window semantics migrate from the legacy
-- dropship_return_policy_config: if a legacy active row exists, its window is
-- carried over; otherwise the §12 default of 30 days is used.
INSERT INTO dropship.dropship_return_policies (
  version, return_window_days, vendor_id, store_connection_id, priority, is_active, effective_from
)
SELECT
  1,
  COALESCE((
    SELECT rpc.return_window_days
    FROM dropship.dropship_return_policy_config rpc
    WHERE rpc.is_active = true
      AND rpc.effective_from <= now()
      AND (rpc.effective_to IS NULL OR rpc.effective_to > now())
    ORDER BY rpc.effective_from DESC, rpc.id DESC
    LIMIT 1
  ), 30),
  NULL,
  NULL,
  0,
  true,
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM dropship.dropship_return_policies p
  WHERE p.vendor_id IS NULL
    AND p.store_connection_id IS NULL
    AND p.is_active = true
);

-- 2. Return fee schedule. Rows encode fee amount per (fee_type, fault_category)
--    with the same hierarchical scoping as return policies.
--    NOTE for return_shipping_fee rows: the row encodes WHO PAYS per fault
--    category (the row's existence for a fault category means the vendor pays;
--    absence means Card Shellz / pool absorbs). amount is irrelevant for
--    shipping — the actual label cost comes from the channel adapter evidence —
--    so shipping rows use amount = 0, amount_type = 'flat_cents'.

CREATE TABLE IF NOT EXISTS dropship.dropship_return_fee_schedule (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  version integer NOT NULL DEFAULT 1,
  fee_type varchar(40) NOT NULL,
  fault_category varchar(40) NOT NULL,
  amount_type varchar(20) NOT NULL DEFAULT 'flat_cents',
  amount numeric(12,2) NOT NULL DEFAULT 0,
  vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_return_fee_version_chk CHECK (version > 0),
  CONSTRAINT dropship_return_fee_type_chk CHECK (fee_type IN ('restocking_fee','processing_fee','return_shipping_fee')),
  CONSTRAINT dropship_return_fee_fault_chk CHECK (fault_category IN ('card_shellz','vendor','customer','marketplace','carrier')),
  CONSTRAINT dropship_return_fee_amount_type_chk CHECK (amount_type IN ('flat_cents','percent')),
  CONSTRAINT dropship_return_fee_amount_chk CHECK (amount >= 0),
  CONSTRAINT dropship_return_fee_effective_chk CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT dropship_return_fee_scope_chk CHECK (
    vendor_id IS NOT NULL OR store_connection_id IS NULL
  )
);

CREATE INDEX IF NOT EXISTS dropship_return_fee_schedule_scope_idx
  ON dropship.dropship_return_fee_schedule(vendor_id, store_connection_id, fee_type, fault_category, is_active, effective_from);

-- 3. RMA rows record the policy version that decided them (D-governing) and
--    carry the no-inspection evidence pack (D3).

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS policy_version_id integer REFERENCES dropship.dropship_return_policies(id) ON DELETE SET NULL;

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS no_inspection_evidence jsonb;

-- 4. RMA status enum extension (D4): add no_inspection_review + disputed to the
--    status checks. Existing rows keep their statuses; the state machine maps
--    them on read (pre-enforcement rows are all in the original 8 statuses).

ALTER TABLE dropship.dropship_rmas
  DROP CONSTRAINT IF EXISTS dropship_rma_status_chk;
ALTER TABLE dropship.dropship_rmas
  ADD CONSTRAINT dropship_rma_status_chk CHECK (status IN (
    'requested','in_transit','received','inspecting','approved','rejected',
    'disputed','credited','closed','no_inspection_review'
  ));

ALTER TABLE dropship.dropship_rma_status_updates
  DROP CONSTRAINT IF EXISTS dropship_rma_status_update_previous_chk;
ALTER TABLE dropship.dropship_rma_status_updates
  ADD CONSTRAINT dropship_rma_status_update_previous_chk CHECK (previous_status IN (
    'requested','in_transit','received','inspecting','approved','rejected',
    'disputed','credited','closed','no_inspection_review'
  ));

ALTER TABLE dropship.dropship_rma_status_updates
  DROP CONSTRAINT IF EXISTS dropship_rma_status_update_status_chk;
ALTER TABLE dropship.dropship_rma_status_updates
  ADD CONSTRAINT dropship_rma_status_update_status_chk CHECK (status IN (
    'requested','in_transit','received','inspecting','approved','rejected',
    'disputed','credited','closed','no_inspection_review'
  ));

-- 5. DEPRECATION NOTE: dropship.dropship_return_policy_config is superseded by
--    dropship.dropship_return_policies. Reads have switched to the new table.
--    The legacy table is intentionally NOT dropped (release-phase safety).
COMMENT ON TABLE dropship.dropship_return_policy_config IS
  'DEPRECATED by migration 186: superseded by dropship.dropship_return_policies. Kept for release-phase safety; do not write new rows.';
