BEGIN;

CREATE TABLE IF NOT EXISTS procurement.purchase_supplier_progress (
  purchase_order_line_id integer PRIMARY KEY REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS procurement.purchase_supplier_progress_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_line_id integer NOT NULL REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  idempotency_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  before_report jsonb CHECK (before_report IS NULL OR jsonb_typeof(before_report) = 'object'),
  after_report jsonb NOT NULL CHECK (jsonb_typeof(after_report) = 'object'),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) > 0),
  recorded_at timestamptz NOT NULL,
  UNIQUE (purchase_order_line_id, revision)
);
CREATE OR REPLACE FUNCTION procurement.reject_supplier_progress_history_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Supplier progress history is immutable; record a correction';
END;
$$;
DROP TRIGGER IF EXISTS purchase_supplier_progress_history_immutable ON procurement.purchase_supplier_progress_revisions;
CREATE TRIGGER purchase_supplier_progress_history_immutable
  BEFORE UPDATE OR DELETE ON procurement.purchase_supplier_progress_revisions
  FOR EACH ROW EXECUTE FUNCTION procurement.reject_supplier_progress_history_change();

COMMIT;
