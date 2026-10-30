-- Status-only capture never grants contents, inventory or dispatch authority.
CREATE TABLE wms.saved_label_status_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind text NOT NULL CHECK(source_kind IN ('return','history')),
  source_id bigint NOT NULL CHECK(source_id>0),
  provider_reference text NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 200),
  tracking_number text NOT NULL CHECK(length(tracking_number) BETWEEN 1 AND 200),
  priority smallint NOT NULL DEFAULT 1 CHECK(priority BETWEEN 0 AND 2),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','complete','review')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count>=0),
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid, lease_until timestamptz,
  last_error_code text, last_status text,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE(source_kind,source_id,provider_reference),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX saved_label_status_due ON wms.saved_label_status_jobs(priority,next_attempt_at,id) WHERE state IN ('pending','active');
CREATE TABLE wms.saved_label_status_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES wms.saved_label_status_jobs(id),
  attempt_number integer NOT NULL CHECK(attempt_number>0),
  lease_token uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('active','complete','retry','review')),
  error_code text, canonical_status text,
  actor text NOT NULL, started_at timestamptz NOT NULL, completed_at timestamptz NOT NULL,
  CHECK(completed_at>=started_at),
  UNIQUE(job_id,attempt_number), UNIQUE(job_id,lease_token)
);
CREATE OR REPLACE FUNCTION wms.saved_label_status_attempts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Shipping status capture attempts are immutable'; END;
$$;
CREATE TRIGGER saved_label_status_attempts_immutable BEFORE UPDATE OR DELETE ON wms.saved_label_status_attempts
FOR EACH ROW EXECUTE FUNCTION wms.saved_label_status_attempts_immutable();
-- Existing successful labels and verified history are evidence sources only.
-- The worker revalidates owner evidence before any authenticated provider GET.
INSERT INTO wms.saved_label_status_jobs(source_kind,source_id,provider_reference,tracking_number,priority,next_attempt_at,created_at,updated_at)
SELECT 'return',a.id,a.result_snapshot->>'labelId',a.result_snapshot->>'trackingNumber',0,now(),now(),now()
FROM returns.customer_return_label_attempts a WHERE a.status='succeeded'
AND a.result_snapshot->>'labelId' ~ '^se(-[a-z0-9]+)+$' AND length(a.result_snapshot->>'trackingNumber') BETWEEN 1 AND 200
ON CONFLICT DO NOTHING;
INSERT INTO wms.saved_label_status_jobs(source_kind,source_id,provider_reference,tracking_number,priority,next_attempt_at,created_at,updated_at)
SELECT 'history',j.oms_order_id,p->>'providerShipmentId',p->>'trackingNumber',2,now(),now(),now()
FROM wms.shipping_package_history_jobs j
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(j.document->'packages')='array' THEN j.document->'packages' ELSE '[]'::jsonb END) p
WHERE j.state='ready' AND j.generation=j.computed_generation AND p->>'providerShipmentId' ~ '^[1-9][0-9]*$'
AND length(p->>'trackingNumber') BETWEEN 1 AND 200 ON CONFLICT DO NOTHING;
