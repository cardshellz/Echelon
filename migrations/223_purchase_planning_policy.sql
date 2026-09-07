-- Additive planning configuration. No existing recommendations or inventory are rewritten.
CREATE TABLE IF NOT EXISTS procurement.purchase_planning_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  revision integer NOT NULL CHECK (revision >= 0),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy) = 'object')
);
INSERT INTO procurement.purchase_planning_policy (id, revision, policy)
VALUES (1, 0, '{"version":1,"growthPercent":0,"targetCoverDays":null,"products":[]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS procurement.purchase_planning_policy_revisions (
  revision integer PRIMARY KEY CHECK (revision > 0),
  idempotency_key varchar(160) NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  actor_id varchar(255) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  changed_at timestamptz NOT NULL,
  before_policy jsonb NOT NULL CHECK (jsonb_typeof(before_policy) = 'object'),
  after_policy jsonb NOT NULL CHECK (jsonb_typeof(after_policy) = 'object')
);

CREATE OR REPLACE FUNCTION procurement.reject_purchase_planning_policy_revision_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Purchase planning policy revisions are immutable';
END;
$$;
DROP TRIGGER IF EXISTS purchase_planning_policy_revisions_immutable ON procurement.purchase_planning_policy_revisions;
CREATE TRIGGER purchase_planning_policy_revisions_immutable
BEFORE UPDATE OR DELETE ON procurement.purchase_planning_policy_revisions
FOR EACH ROW EXECUTE FUNCTION procurement.reject_purchase_planning_policy_revision_change();

-- Version one observations remain immutable and readable. Version two includes
-- the explicit nonzero growth overlay in the canonical forecast fingerprint.
ALTER TABLE procurement.purchase_forecast_observations
  DROP CONSTRAINT IF EXISTS purchase_forecast_observations_policy_capture_chk;
ALTER TABLE procurement.purchase_forecast_observations
  ADD CONSTRAINT purchase_forecast_observations_policy_capture_chk CHECK (
    (forecast_policy_capture_version = 0 AND forecast_policy_fingerprint IS NULL AND forecast_policy_snapshot IS NULL)
    OR (forecast_policy_capture_version IN (1, 2)
      AND forecast_policy_fingerprint ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(forecast_policy_snapshot) = 'object')
  );
