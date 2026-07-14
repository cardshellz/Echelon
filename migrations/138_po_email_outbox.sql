-- Durable purchase-order email delivery outbox.
--
-- The request snapshot is immutable once queued. Workers lease rows with
-- SKIP LOCKED, reuse the same RFC Message-ID on automatic retries, and only
-- append PO history after SMTP accepts the message.

CREATE TABLE procurement.po_email_outbox (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id INTEGER NOT NULL
    REFERENCES procurement.purchase_orders(id) ON DELETE RESTRICT,
  idempotency_key VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  to_email VARCHAR(320) NOT NULL,
  cc_email VARCHAR(320),
  subject VARCHAR(500) NOT NULL,
  html_body TEXT NOT NULL,
  text_body TEXT,
  message_id VARCHAR(255) NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token VARCHAR(64),
  lease_expires_at TIMESTAMPTZ,
  provider_message_id VARCHAR(500),
  provider_response VARCHAR(1000),
  last_error_code VARCHAR(100),
  last_error_message VARCHAR(1000),
  sent_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  created_by VARCHAR REFERENCES identity.users(id) ON DELETE SET NULL,
  replay_of_id INTEGER REFERENCES procurement.po_email_outbox(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT po_email_outbox_status_chk
    CHECK (status IN ('queued', 'processing', 'sent', 'partially_sent', 'dead_letter')),
  CONSTRAINT po_email_outbox_attempts_chk
    CHECK (attempt_count >= 0 AND max_attempts > 0 AND attempt_count <= max_attempts),
  CONSTRAINT po_email_outbox_lease_chk
    CHECK (
      (status = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
  CONSTRAINT po_email_outbox_sent_timestamp_chk
    CHECK ((status IN ('sent', 'partially_sent')) = (sent_at IS NOT NULL)),
  CONSTRAINT po_email_outbox_dead_timestamp_chk
    CHECK ((status = 'dead_letter') = (dead_lettered_at IS NOT NULL))
);

CREATE UNIQUE INDEX po_email_outbox_idempotency_idx
  ON procurement.po_email_outbox(purchase_order_id, idempotency_key);

CREATE UNIQUE INDEX po_email_outbox_message_id_idx
  ON procurement.po_email_outbox(message_id);

CREATE INDEX po_email_outbox_due_idx
  ON procurement.po_email_outbox(next_attempt_at, id)
  WHERE status = 'queued';

CREATE INDEX po_email_outbox_expired_lease_idx
  ON procurement.po_email_outbox(lease_expires_at, id)
  WHERE status = 'processing';

CREATE INDEX po_email_outbox_po_created_idx
  ON procurement.po_email_outbox(purchase_order_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION procurement.po_email_outbox_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.to_email IS DISTINCT FROM OLD.to_email
     OR NEW.cc_email IS DISTINCT FROM OLD.cc_email
     OR NEW.subject IS DISTINCT FROM OLD.subject
     OR NEW.html_body IS DISTINCT FROM OLD.html_body
     OR NEW.text_body IS DISTINCT FROM OLD.text_body
     OR NEW.message_id IS DISTINCT FROM OLD.message_id
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
     OR NEW.replay_of_id IS DISTINCT FROM OLD.replay_of_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PO email outbox request snapshots are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN ('sent', 'partially_sent', 'dead_letter')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'PO email outbox terminal states are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'processing'))
     OR (OLD.status = 'processing' AND NEW.status NOT IN ('queued', 'sent', 'partially_sent', 'dead_letter')) THEN
    RAISE EXCEPTION 'Invalid PO email outbox status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER po_email_outbox_update_guard
BEFORE UPDATE ON procurement.po_email_outbox
FOR EACH ROW
EXECUTE FUNCTION procurement.po_email_outbox_update_guard();
