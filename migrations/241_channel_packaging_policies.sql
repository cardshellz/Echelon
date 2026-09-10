-- Physical availability and branding are reviewed facts, never inferred from names.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE shipping.box_catalog
  ADD COLUMN branding text NOT NULL DEFAULT 'unclassified'
    CHECK (branding IN ('unclassified','unbranded','branded')),
  ADD COLUMN availability_reviewed boolean NOT NULL DEFAULT false,
  ADD COLUMN configuration_revision integer NOT NULL DEFAULT 1 CHECK(configuration_revision > 0);

-- No policies are manufactured on migration. Existing channels retain legacy
-- packaging until an administrator explicitly saves their concrete policy.
CREATE TABLE shipping.channel_packaging_policies (
  channel_id integer PRIMARY KEY REFERENCES channels.channels(id),
  revision integer NOT NULL CHECK(revision > 0),
  default_suite_id integer NOT NULL REFERENCES shipping.box_suites(id),
  requirement text NOT NULL CHECK(requirement IN ('any','unbranded'))
);
CREATE TABLE shipping.channel_packaging_overrides (
  channel_id integer NOT NULL REFERENCES shipping.channel_packaging_policies(channel_id),
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id),
  suite_id integer NOT NULL REFERENCES shipping.box_suites(id),
  PRIMARY KEY(channel_id,warehouse_id)
);
CREATE INDEX shipping_channel_packaging_suite_idx ON shipping.channel_packaging_policies(default_suite_id);
CREATE INDEX shipping_channel_packaging_override_suite_idx ON shipping.channel_packaging_overrides(suite_id);

-- Serialize catalog/suite/policy edits with the same lock used by their audited
-- command boundary. Deferred validation sees the complete new suite revision.
CREATE FUNCTION shipping.validate_channel_packaging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('shipping-shared-config'));
  IF EXISTS (
    SELECT 1 FROM shipping.channel_packaging_policies p
    JOIN LATERAL (SELECT p.default_suite_id AS suite_id UNION SELECT o.suite_id
      FROM shipping.channel_packaging_overrides o WHERE o.channel_id=p.channel_id) a ON true
    JOIN shipping.box_suites s ON s.id=a.suite_id
    WHERE s.archived OR (p.requirement='unbranded' AND EXISTS (
      SELECT 1 FROM shipping.box_suite_members m JOIN shipping.box_catalog b ON b.id=m.box_id
      WHERE m.suite_id=s.id AND m.revision=s.current_revision AND b.branding<>'unbranded'))
  ) THEN RAISE EXCEPTION 'SHIPPING_PACKAGING_POLICY_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER shipping_channel_packaging_policy_valid AFTER INSERT OR UPDATE ON shipping.channel_packaging_policies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping.validate_channel_packaging();
CREATE CONSTRAINT TRIGGER shipping_channel_packaging_override_valid AFTER INSERT OR UPDATE ON shipping.channel_packaging_overrides
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping.validate_channel_packaging();
CREATE CONSTRAINT TRIGGER shipping_channel_packaging_suite_valid AFTER UPDATE ON shipping.box_suites
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping.validate_channel_packaging();
CREATE CONSTRAINT TRIGGER shipping_channel_packaging_box_valid AFTER UPDATE ON shipping.box_catalog
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shipping.validate_channel_packaging();
SET CONSTRAINTS ALL DEFERRED;

CREATE TABLE shipping.packaging_confirmation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id bigint NOT NULL REFERENCES shipping.pack_plans(id),
  parcel_id bigint NOT NULL REFERENCES shipping.pack_plan_parcels(id),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL
);
CREATE INDEX shipping_packaging_confirmation_plan_idx ON shipping.packaging_confirmation_events(plan_id,id);
CREATE TRIGGER shipping_packaging_confirmations_immutable BEFORE UPDATE OR DELETE ON shipping.packaging_confirmation_events
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_configuration_history_change();
