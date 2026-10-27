-- A saved receipt configuration supersedes PO pack preferences and catalog
-- classifications. Retire those advisory classifications without approving a
-- cost variance, certifying stock history or changing any quantity or amount.
BEGIN;

-- Prevent an older application worker from inserting another obsolete warning
-- between retirement and installation of the archival-only constraint.
LOCK TABLE procurement.po_exceptions IN SHARE ROW EXCLUSIVE MODE;

WITH obsolete AS (
  SELECT exception.id, exception.po_id, po.status AS po_status,
         to_jsonb(exception) AS before_state
  FROM procurement.po_exceptions exception
  JOIN procurement.purchase_orders po ON po.id=exception.po_id
  WHERE exception.kind IN (
    'receive_uom_disagreement', 'receive_base_unit_pack_conflict',
    'receive_variant_base_unit_misconfig', 'receive_variant_missing_parent'
  ) AND exception.status IN ('open', 'acknowledged')
  FOR UPDATE OF exception
), retired AS (
  UPDATE procurement.po_exceptions exception
  SET status='dismissed', dismissed_at=transaction_timestamp(),
      dismissed_by='system:receipt-config-authority',
      dismiss_note='Obsolete receiving-pack comparison retired. The saved receipt configuration owns conversion. No quantity, cost or financial approval was changed.',
      updated_at=transaction_timestamp()
  FROM obsolete
  WHERE exception.id=obsolete.id
  RETURNING exception.id, exception.po_id, obsolete.po_status,
            obsolete.before_state, to_jsonb(exception) AS after_state
)
INSERT INTO procurement.po_status_history
  (purchase_order_id, from_status, to_status, changed_by, changed_at, notes)
SELECT po_id, po_status, po_status, NULL, transaction_timestamp(),
       jsonb_build_object(
         'action', 'retire_obsolete_receive_pack_warning',
         'actor', 'system:receipt-config-authority',
         'exceptionId', id, 'before', before_state, 'after', after_state,
         'reason', 'The saved receipt configuration is authoritative; this advisory classification is retired.'
       )::text
FROM retired;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='procurement.po_exceptions'::regclass
      AND conname='retired_receive_pack_warnings_archival_only_chk'
  ) THEN
    ALTER TABLE procurement.po_exceptions
      ADD CONSTRAINT retired_receive_pack_warnings_archival_only_chk CHECK (
        kind NOT IN (
          'receive_uom_disagreement', 'receive_base_unit_pack_conflict',
          'receive_variant_base_unit_misconfig', 'receive_variant_missing_parent'
        ) OR status IN ('resolved', 'dismissed')
      );
  END IF;
END $$;

COMMIT;
