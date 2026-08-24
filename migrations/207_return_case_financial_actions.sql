-- Canonical financial actions for Return Cases.
-- Retail customer refunds and dropship vendor settlements are deliberately
-- separate evidence streams. Neither table owns physical return handling.

CREATE TABLE returns.return_case_customer_refunds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL REFERENCES returns.return_cases(id),
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  provider varchar(30) NOT NULL,
  external_order_id varchar(100) NOT NULL,
  currency varchar(3) NOT NULL,
  amount_cents bigint NOT NULL,
  maximum_refundable_cents bigint NOT NULL,
  status varchar(24) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  quote_hash varchar(64) NOT NULL,
  quote jsonb NOT NULL,
  notify_customer boolean NOT NULL,
  requested_by varchar(255) NOT NULL,
  notes text,
  provider_refund_id varchar(160),
  provider_result jsonb,
  failure_code varchar(160),
  failure_message text,
  requested_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_customer_refunds_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT return_case_customer_refunds_provider_chk CHECK (provider = 'shopify'),
  CONSTRAINT return_case_customer_refunds_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT return_case_customer_refunds_amount_chk CHECK (
    amount_cents > 0
    AND maximum_refundable_cents >= amount_cents
  ),
  CONSTRAINT return_case_customer_refunds_status_chk CHECK (status IN ('pending','completed','failed')),
  CONSTRAINT return_case_customer_refunds_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND quote_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT return_case_customer_refunds_quote_chk CHECK (jsonb_typeof(quote) = 'object'),
  CONSTRAINT return_case_customer_refunds_actor_chk CHECK (btrim(requested_by) <> ''),
  CONSTRAINT return_case_customer_refunds_completion_chk CHECK (
    (status = 'pending'
      AND provider_refund_id IS NULL
      AND provider_result IS NULL
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND completed_at IS NULL)
    OR (status = 'completed'
      AND provider_refund_id IS NOT NULL
      AND provider_result IS NOT NULL
      AND failure_code IS NULL
      AND failure_message IS NULL
      AND completed_at IS NOT NULL)
    OR (status = 'failed'
      AND provider_refund_id IS NULL
      AND provider_result IS NULL
      AND failure_code IS NOT NULL
      AND failure_message IS NOT NULL
      AND completed_at IS NOT NULL)
  ),
  CONSTRAINT return_case_customer_refunds_time_chk CHECK (completed_at IS NULL OR completed_at >= requested_at)
);

CREATE UNIQUE INDEX return_case_customer_refunds_pending_uq
  ON returns.return_case_customer_refunds (return_case_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX return_case_customer_refunds_completed_uq
  ON returns.return_case_customer_refunds (return_case_id)
  WHERE status = 'completed';
CREATE INDEX return_case_customer_refunds_case_idx
  ON returns.return_case_customer_refunds (return_case_id, requested_at, id);
CREATE UNIQUE INDEX return_case_customer_refunds_provider_id_uq
  ON returns.return_case_customer_refunds (channel_id, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

CREATE TABLE returns.return_case_customer_refund_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_refund_id bigint NOT NULL REFERENCES returns.return_case_customer_refunds(id),
  return_case_item_id bigint NOT NULL REFERENCES returns.return_case_items(id),
  external_line_item_id varchar(100) NOT NULL,
  quantity integer NOT NULL,
  subtotal_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_customer_refund_items_item_uq UNIQUE (customer_refund_id, return_case_item_id),
  CONSTRAINT return_case_customer_refund_items_external_uq UNIQUE (customer_refund_id, external_line_item_id),
  CONSTRAINT return_case_customer_refund_items_quantity_chk CHECK (quantity > 0),
  CONSTRAINT return_case_customer_refund_items_money_chk CHECK (
    subtotal_cents >= 0
    AND tax_cents >= 0
    AND total_cents = subtotal_cents + tax_cents
  )
);

CREATE INDEX return_case_customer_refund_items_case_item_idx
  ON returns.return_case_customer_refund_items (return_case_item_id, id);

CREATE TABLE returns.return_case_customer_refund_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_refund_id bigint NOT NULL REFERENCES returns.return_case_customer_refunds(id),
  position integer NOT NULL,
  parent_transaction_id varchar(160) NOT NULL,
  gateway varchar(160) NOT NULL,
  amount_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_customer_refund_transactions_position_uq UNIQUE (customer_refund_id, position),
  CONSTRAINT return_case_customer_refund_transactions_parent_uq UNIQUE (customer_refund_id, parent_transaction_id),
  CONSTRAINT return_case_customer_refund_transactions_position_chk CHECK (position >= 0),
  CONSTRAINT return_case_customer_refund_transactions_amount_chk CHECK (amount_cents > 0),
  CONSTRAINT return_case_customer_refund_transactions_text_chk CHECK (
    btrim(parent_transaction_id) <> '' AND btrim(gateway) <> ''
  )
);

CREATE TABLE returns.return_case_vendor_settlements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL REFERENCES returns.return_cases(id),
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
  fault_category varchar(24) NOT NULL,
  currency varchar(3) NOT NULL,
  product_credit_cents bigint NOT NULL,
  original_shipping_credit_cents bigint NOT NULL,
  restocking_fee_cents bigint NOT NULL,
  processing_fee_cents bigint NOT NULL,
  return_shipping_fee_cents bigint NOT NULL,
  gross_credit_cents bigint NOT NULL,
  total_fee_cents bigint NOT NULL,
  net_settlement_cents bigint NOT NULL,
  return_shipping_actual_cents bigint,
  restocking_fee_policy_id integer,
  processing_fee_policy_id integer,
  return_shipping_fee_policy_id integer,
  settlement_breakdown jsonb NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  quote_hash varchar(64) NOT NULL,
  recorded_by varchar(255) NOT NULL,
  notes text,
  settled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_vendor_settlements_case_uq UNIQUE (return_case_id),
  CONSTRAINT return_case_vendor_settlements_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT return_case_vendor_settlements_fault_chk CHECK (
    fault_category IN ('card_shellz','vendor','customer','marketplace','carrier')
  ),
  CONSTRAINT return_case_vendor_settlements_currency_chk CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT return_case_vendor_settlements_money_chk CHECK (
    product_credit_cents >= 0
    AND original_shipping_credit_cents >= 0
    AND restocking_fee_cents >= 0
    AND processing_fee_cents >= 0
    AND return_shipping_fee_cents >= 0
    AND gross_credit_cents = product_credit_cents + original_shipping_credit_cents
    AND total_fee_cents = restocking_fee_cents + processing_fee_cents + return_shipping_fee_cents
    AND net_settlement_cents = gross_credit_cents - total_fee_cents
    AND (return_shipping_actual_cents IS NULL OR return_shipping_actual_cents >= 0)
  ),
  CONSTRAINT return_case_vendor_settlements_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
    AND quote_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT return_case_vendor_settlements_breakdown_chk CHECK (jsonb_typeof(settlement_breakdown) = 'object'),
  CONSTRAINT return_case_vendor_settlements_actor_chk CHECK (btrim(recorded_by) <> '')
);

CREATE INDEX return_case_vendor_settlements_vendor_idx
  ON returns.return_case_vendor_settlements (vendor_id, settled_at, id);

CREATE TABLE returns.return_case_vendor_settlement_ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_settlement_id bigint NOT NULL REFERENCES returns.return_case_vendor_settlements(id),
  wallet_ledger_id integer NOT NULL REFERENCES dropship.dropship_wallet_ledger(id),
  entry_role varchar(16) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_vendor_settlement_ledger_entry_uq UNIQUE (vendor_settlement_id, entry_role),
  CONSTRAINT return_case_vendor_settlement_wallet_ledger_uq UNIQUE (wallet_ledger_id),
  CONSTRAINT return_case_vendor_settlement_ledger_role_chk CHECK (entry_role IN ('credit','fee'))
);

CREATE OR REPLACE FUNCTION returns.return_case_disposition_is_complete(target_case_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM returns.return_case_items case_item
    JOIN wms.return_items wms_item
      ON wms_item.id = case_item.wms_return_item_id
    WHERE case_item.return_case_id = target_case_id
      AND wms_item.received_qty > 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM returns.return_case_items case_item
    JOIN wms.return_items wms_item
      ON wms_item.id = case_item.wms_return_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(disposition_item.quantity), 0) AS recorded_quantity
      FROM returns.return_case_disposition_items disposition_item
      JOIN returns.return_case_dispositions disposition
        ON disposition.id = disposition_item.disposition_id
       AND disposition.return_case_id = target_case_id
      WHERE disposition_item.return_case_item_id = case_item.id
    ) recorded ON true
    WHERE case_item.return_case_id = target_case_id
      AND (wms_item.received_qty <> wms_item.expected_qty
        OR recorded.recorded_quantity <> wms_item.received_qty)
  );
$$;

CREATE OR REPLACE FUNCTION returns.guard_customer_refund_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target returns.return_cases%ROWTYPE;
  channel_provider varchar(30);
BEGIN
  SELECT * INTO target
  FROM returns.return_cases
  WHERE id = NEW.return_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return Case % does not exist', NEW.return_case_id USING ERRCODE = '23503';
  END IF;

  SELECT provider INTO channel_provider
  FROM channels.channels
  WHERE id = target.channel_id
  FOR SHARE;

  IF target.business_context <> 'retail'
     OR target.channel_id <> NEW.channel_id
     OR channel_provider IS DISTINCT FROM 'shopify'
     OR target.policy_snapshot->>'customerRefundAuthority' IS DISTINCT FROM 'card_shellz'
     OR target.case_status <> 'open'
     OR target.approval_status <> 'approved'
     OR NOT (
       (target.inspection_status = 'not_required'
         AND target.policy_snapshot->>'inspectionRequirement' = 'none'
         AND NOT EXISTS (
           SELECT 1
           FROM returns.return_case_inspections inspection
           WHERE inspection.return_case_id = target.id
         ))
       OR (target.inspection_status = 'approved' AND EXISTS (
         SELECT 1
         FROM returns.return_case_inspections inspection
         WHERE inspection.return_case_id = target.id
           AND inspection.status = 'approved'
           AND inspection.completed_at IS NOT NULL
           AND inspection.completed_by IS NOT NULL
       ))
     )
     OR NOT returns.return_case_disposition_is_complete(target.id)
     OR target.customer_refund_status NOT IN ('pending','failed') THEN
    RAISE EXCEPTION 'Return Case % is not eligible for a customer refund', NEW.return_case_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_customer_refunds_case_guard
  BEFORE INSERT ON returns.return_case_customer_refunds
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_refund_case();

CREATE OR REPLACE FUNCTION returns.guard_customer_refund_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('completed','failed') THEN
    RAISE EXCEPTION 'Customer refund evidence only permits pending to terminal transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.return_case_id IS DISTINCT FROM OLD.return_case_id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.external_order_id IS DISTINCT FROM OLD.external_order_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.maximum_refundable_cents IS DISTINCT FROM OLD.maximum_refundable_cents
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.quote_hash IS DISTINCT FROM OLD.quote_hash
     OR NEW.quote IS DISTINCT FROM OLD.quote
     OR NEW.notify_customer IS DISTINCT FROM OLD.notify_customer
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.notes IS DISTINCT FROM OLD.notes
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Customer refund request evidence is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_customer_refunds_transition_guard
  BEFORE UPDATE ON returns.return_case_customer_refunds
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_refund_transition();
CREATE TRIGGER return_case_customer_refunds_delete_guard
  BEFORE DELETE ON returns.return_case_customer_refunds
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE TRIGGER return_case_customer_refund_items_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_customer_refund_items
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();
CREATE TRIGGER return_case_customer_refund_transactions_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_customer_refund_transactions
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE OR REPLACE FUNCTION returns.guard_customer_refund_item_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header returns.return_case_customer_refunds%ROWTYPE;
  item_case_id bigint;
BEGIN
  SELECT * INTO header
  FROM returns.return_case_customer_refunds
  WHERE id = NEW.customer_refund_id
  FOR UPDATE;
  IF NOT FOUND OR header.status <> 'pending' THEN
    RAISE EXCEPTION 'Customer refund % is not accepting item evidence', NEW.customer_refund_id
      USING ERRCODE = '23514';
  END IF;

  SELECT return_case_id INTO item_case_id
  FROM returns.return_case_items
  WHERE id = NEW.return_case_item_id
  FOR SHARE;
  IF NOT FOUND OR item_case_id <> header.return_case_id THEN
    RAISE EXCEPTION 'Customer refund item % does not belong to Return Case %',
      NEW.return_case_item_id, header.return_case_id USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(header.quote->'lines') AS quoted(line)
    WHERE (quoted.line->>'returnCaseItemId')::bigint = NEW.return_case_item_id
      AND quoted.line->>'externalLineItemId' = NEW.external_line_item_id
      AND (quoted.line->>'quantity')::integer = NEW.quantity
      AND (quoted.line->>'subtotalCents')::bigint = NEW.subtotal_cents
      AND (quoted.line->>'taxCents')::bigint = NEW.tax_cents
      AND (quoted.line->>'totalCents')::bigint = NEW.total_cents
  ) THEN
    RAISE EXCEPTION 'Customer refund item evidence does not match the approved quote'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_customer_refund_items_evidence_guard
  BEFORE INSERT ON returns.return_case_customer_refund_items
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_refund_item_evidence();

CREATE OR REPLACE FUNCTION returns.guard_customer_refund_transaction_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  header returns.return_case_customer_refunds%ROWTYPE;
BEGIN
  SELECT * INTO header
  FROM returns.return_case_customer_refunds
  WHERE id = NEW.customer_refund_id
  FOR UPDATE;
  IF NOT FOUND OR header.status <> 'pending' THEN
    RAISE EXCEPTION 'Customer refund % is not accepting transaction evidence', NEW.customer_refund_id
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(header.quote->'transactions') AS quoted(transaction)
    WHERE (quoted.transaction->>'position')::integer = NEW.position
      AND quoted.transaction->>'parentTransactionId' = NEW.parent_transaction_id
      AND quoted.transaction->>'gateway' = NEW.gateway
      AND (quoted.transaction->>'amountCents')::bigint = NEW.amount_cents
  ) THEN
    RAISE EXCEPTION 'Customer refund transaction evidence does not match the approved quote'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_customer_refund_transactions_evidence_guard
  BEFORE INSERT ON returns.return_case_customer_refund_transactions
  FOR EACH ROW EXECUTE FUNCTION returns.guard_customer_refund_transaction_evidence();

CREATE OR REPLACE FUNCTION returns.validate_customer_refund_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_refund_id bigint := COALESCE(
    (to_jsonb(NEW)->>'customer_refund_id')::bigint,
    (to_jsonb(NEW)->>'id')::bigint,
    (to_jsonb(OLD)->>'customer_refund_id')::bigint,
    (to_jsonb(OLD)->>'id')::bigint
  );
  header returns.return_case_customer_refunds%ROWTYPE;
  item_total bigint;
  transaction_total bigint;
  item_count integer;
  transaction_count integer;
BEGIN
  SELECT * INTO header
  FROM returns.return_case_customer_refunds
  WHERE id = target_refund_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(total_cents), 0), COUNT(*)
    INTO item_total, item_count
  FROM returns.return_case_customer_refund_items
  WHERE customer_refund_id = target_refund_id;
  SELECT COALESCE(SUM(amount_cents), 0), COUNT(*)
    INTO transaction_total, transaction_count
  FROM returns.return_case_customer_refund_transactions
  WHERE customer_refund_id = target_refund_id;

  IF item_count = 0 OR transaction_count = 0
     OR item_total <> header.amount_cents
     OR transaction_total <> header.amount_cents
     OR item_count <> jsonb_array_length(header.quote->'lines')
     OR transaction_count <> jsonb_array_length(header.quote->'transactions') THEN
    RAISE EXCEPTION 'Customer refund % line or transaction evidence does not match header amount', target_refund_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_customer_refund_header_totals_guard
  AFTER INSERT ON returns.return_case_customer_refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_customer_refund_evidence();
CREATE CONSTRAINT TRIGGER return_case_customer_refund_items_totals_guard
  AFTER INSERT ON returns.return_case_customer_refund_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_customer_refund_evidence();
CREATE CONSTRAINT TRIGGER return_case_customer_refund_transactions_totals_guard
  AFTER INSERT ON returns.return_case_customer_refund_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_customer_refund_evidence();

CREATE OR REPLACE FUNCTION returns.guard_vendor_settlement_case()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target returns.return_cases%ROWTYPE;
BEGIN
  SELECT * INTO target
  FROM returns.return_cases
  WHERE id = NEW.return_case_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Return Case % does not exist', NEW.return_case_id USING ERRCODE = '23503';
  END IF;
  IF target.business_context <> 'dropship'
     OR target.vendor_id IS DISTINCT FROM NEW.vendor_id
     OR target.policy_snapshot->>'vendorSettlementTrigger' IS DISTINCT FROM 'inspection_approved'
     OR target.case_status <> 'open'
     OR target.approval_status <> 'approved'
     OR target.inspection_status <> 'approved'
     OR NOT EXISTS (
       SELECT 1
       FROM returns.return_case_inspections inspection
       WHERE inspection.return_case_id = target.id
         AND inspection.status = 'approved'
         AND inspection.completed_at IS NOT NULL
         AND inspection.completed_by IS NOT NULL
     )
     OR NOT returns.return_case_disposition_is_complete(target.id)
     OR target.vendor_settlement_status NOT IN ('pending','eligible','failed') THEN
    RAISE EXCEPTION 'Return Case % is not eligible for vendor settlement', NEW.return_case_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_vendor_settlements_case_guard
  BEFORE INSERT ON returns.return_case_vendor_settlements
  FOR EACH ROW EXECUTE FUNCTION returns.guard_vendor_settlement_case();
CREATE TRIGGER return_case_vendor_settlements_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_vendor_settlements
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();
CREATE TRIGGER return_case_vendor_settlement_ledger_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_vendor_settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE OR REPLACE FUNCTION returns.guard_vendor_settlement_ledger_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  settlement returns.return_case_vendor_settlements%ROWTYPE;
  ledger dropship.dropship_wallet_ledger%ROWTYPE;
  expected_amount bigint;
  expected_type varchar(40);
BEGIN
  SELECT * INTO settlement
  FROM returns.return_case_vendor_settlements
  WHERE id = NEW.vendor_settlement_id
  FOR UPDATE;
  SELECT * INTO ledger
  FROM dropship.dropship_wallet_ledger
  WHERE id = NEW.wallet_ledger_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dropship wallet ledger entry % does not exist', NEW.wallet_ledger_id
      USING ERRCODE = '23503';
  END IF;

  IF NEW.entry_role = 'credit' THEN
    expected_amount := settlement.gross_credit_cents;
    IF expected_amount <= 0 OR ledger.type NOT IN ('return_credit','insurance_pool_credit') THEN
      RAISE EXCEPTION 'Vendor settlement credit evidence is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    expected_amount := -settlement.total_fee_cents;
    expected_type := 'return_fee';
    IF settlement.total_fee_cents <= 0 OR ledger.type <> expected_type THEN
      RAISE EXCEPTION 'Vendor settlement fee evidence is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF ledger.vendor_id <> settlement.vendor_id
     OR ledger.currency <> settlement.currency
     OR ledger.status <> 'settled'
     OR ledger.amount_cents <> expected_amount
     OR ledger.reference_type <> 'return_case_vendor_settlement'
     OR ledger.reference_id <> (settlement.id::text || ':' || NEW.entry_role)
     OR ledger.idempotency_key <> (settlement.idempotency_key || ':' || NEW.entry_role) THEN
    RAISE EXCEPTION 'Wallet ledger entry % does not match vendor settlement %',
      NEW.wallet_ledger_id, NEW.vendor_settlement_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_vendor_settlement_ledger_evidence_guard
  BEFORE INSERT ON returns.return_case_vendor_settlement_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION returns.guard_vendor_settlement_ledger_evidence();

CREATE OR REPLACE FUNCTION returns.validate_vendor_settlement_ledger_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_settlement_id bigint := COALESCE(
    (to_jsonb(NEW)->>'vendor_settlement_id')::bigint,
    (to_jsonb(NEW)->>'id')::bigint
  );
  settlement returns.return_case_vendor_settlements%ROWTYPE;
  credit_count integer;
  fee_count integer;
BEGIN
  SELECT * INTO settlement
  FROM returns.return_case_vendor_settlements
  WHERE id = target_settlement_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COUNT(*) FILTER (WHERE entry_role = 'credit'),
         COUNT(*) FILTER (WHERE entry_role = 'fee')
    INTO credit_count, fee_count
  FROM returns.return_case_vendor_settlement_ledger_entries
  WHERE vendor_settlement_id = target_settlement_id;

  IF credit_count <> (CASE WHEN settlement.gross_credit_cents > 0 THEN 1 ELSE 0 END)
     OR fee_count <> (CASE WHEN settlement.total_fee_cents > 0 THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'Vendor settlement % wallet evidence is incomplete', target_settlement_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_vendor_settlement_header_ledger_guard
  AFTER INSERT ON returns.return_case_vendor_settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_vendor_settlement_ledger_evidence();
CREATE CONSTRAINT TRIGGER return_case_vendor_settlement_child_ledger_guard
  AFTER INSERT ON returns.return_case_vendor_settlement_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_vendor_settlement_ledger_evidence();

CREATE OR REPLACE FUNCTION returns.validate_customer_refund_command_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed'
     AND NOT EXISTS (
       SELECT 1
       FROM returns.return_case_commands command
       WHERE command.return_case_id = NEW.return_case_id
         AND command.command_type = 'issue_customer_refund'
         AND command.idempotency_key = NEW.idempotency_key
         AND command.request_hash = NEW.request_hash
         AND command.actor = NEW.requested_by
         AND (command.response->>'caseId')::bigint = NEW.return_case_id
         AND (command.response->>'customerRefundId')::bigint = NEW.id
         AND command.response->>'provider' = NEW.provider
         AND command.response->>'providerRefundId' = NEW.provider_refund_id
         AND command.response->>'currency' = NEW.currency
         AND (command.response->>'amountCents')::bigint = NEW.amount_cents
     ) THEN
    RAISE EXCEPTION 'Completed customer refund requires matching immutable command evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_customer_refund_command_evidence_guard
  AFTER UPDATE OF status ON returns.return_case_customer_refunds
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_customer_refund_command_evidence();

CREATE OR REPLACE FUNCTION returns.validate_vendor_settlement_command_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM returns.return_case_commands command
    WHERE command.return_case_id = NEW.return_case_id
      AND command.command_type = 'settle_vendor_account'
      AND command.idempotency_key = NEW.idempotency_key
      AND command.request_hash = NEW.request_hash
      AND command.actor = NEW.recorded_by
      AND (command.response->>'caseId')::bigint = NEW.return_case_id
      AND (command.response->>'vendorSettlementId')::bigint = NEW.id
      AND (command.response->>'vendorId')::integer = NEW.vendor_id
      AND command.response->>'currency' = NEW.currency
      AND (command.response->>'grossCreditCents')::bigint = NEW.gross_credit_cents
      AND (command.response->>'totalFeeCents')::bigint = NEW.total_fee_cents
      AND (command.response->>'netSettlementCents')::bigint = NEW.net_settlement_cents
  ) THEN
    RAISE EXCEPTION 'Vendor settlement requires matching immutable command evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_vendor_settlement_command_evidence_guard
  AFTER INSERT ON returns.return_case_vendor_settlements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_vendor_settlement_command_evidence();

CREATE OR REPLACE FUNCTION returns.validate_return_case_financial_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_type = 'issue_customer_refund'
     AND NOT EXISTS (
       SELECT 1
       FROM returns.return_case_customer_refunds refund
       WHERE refund.return_case_id = NEW.return_case_id
         AND refund.status = 'completed'
         AND refund.idempotency_key = NEW.idempotency_key
         AND refund.request_hash = NEW.request_hash
         AND refund.requested_by = NEW.actor
         AND (NEW.response->>'caseId')::bigint = refund.return_case_id
         AND (NEW.response->>'customerRefundId')::bigint = refund.id
         AND NEW.response->>'provider' = refund.provider
         AND NEW.response->>'providerRefundId' = refund.provider_refund_id
         AND NEW.response->>'currency' = refund.currency
         AND (NEW.response->>'amountCents')::bigint = refund.amount_cents
     ) THEN
    RAISE EXCEPTION 'Customer refund command requires matching completed refund evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.command_type = 'settle_vendor_account'
     AND NOT EXISTS (
       SELECT 1
       FROM returns.return_case_vendor_settlements settlement
       WHERE settlement.return_case_id = NEW.return_case_id
         AND settlement.idempotency_key = NEW.idempotency_key
         AND settlement.request_hash = NEW.request_hash
         AND settlement.recorded_by = NEW.actor
         AND (NEW.response->>'caseId')::bigint = settlement.return_case_id
         AND (NEW.response->>'vendorSettlementId')::bigint = settlement.id
         AND (NEW.response->>'vendorId')::integer = settlement.vendor_id
         AND NEW.response->>'currency' = settlement.currency
         AND (NEW.response->>'grossCreditCents')::bigint = settlement.gross_credit_cents
         AND (NEW.response->>'totalFeeCents')::bigint = settlement.total_fee_cents
         AND (NEW.response->>'netSettlementCents')::bigint = settlement.net_settlement_cents
     ) THEN
    RAISE EXCEPTION 'Vendor settlement command requires matching immutable settlement evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_financial_commands_evidence_guard
  AFTER INSERT ON returns.return_case_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_financial_command();

ALTER TABLE returns.return_case_commands
  DROP CONSTRAINT return_case_commands_type_chk;
ALTER TABLE returns.return_case_commands
  ADD CONSTRAINT return_case_commands_type_chk CHECK (
    command_type IN (
      'record_receipt',
      'start_inspection',
      'complete_inspection',
      'record_disposition',
      'apply_inventory_treatment',
      'issue_customer_refund',
      'settle_vendor_account'
    )
  );
