-- Shared configuration. Legacy Dropship records remain intact for quote history.
CREATE TABLE shipping.configuration_commands (
  command_id uuid PRIMARY KEY,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  actor_id text NOT NULL,
  resource_key text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE shipping.box_suites (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  current_revision integer NOT NULL CHECK (current_revision > 0)
);
CREATE UNIQUE INDEX shipping_box_suites_name_idx ON shipping.box_suites (lower(name));
CREATE TABLE shipping.box_suite_revisions (
  suite_id integer NOT NULL REFERENCES shipping.box_suites(id),
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  actor_id text NOT NULL,
  PRIMARY KEY (suite_id, revision)
);
ALTER TABLE shipping.box_suites ADD CONSTRAINT shipping_suite_current_fk
  FOREIGN KEY (id,current_revision) REFERENCES shipping.box_suite_revisions(suite_id,revision)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE shipping.box_suite_members (
  suite_id integer NOT NULL,
  revision integer NOT NULL,
  box_id integer NOT NULL REFERENCES shipping.box_catalog(id),
  PRIMARY KEY (suite_id,revision,box_id),
  FOREIGN KEY (suite_id,revision) REFERENCES shipping.box_suite_revisions(suite_id,revision)
);
CREATE TABLE shipping.packaging_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel text NOT NULL CHECK (channel IN ('shopify','internal','ebay','dropship')),
  warehouse_id integer REFERENCES warehouse.warehouses(id),
  suite_id integer NOT NULL REFERENCES shipping.box_suites(id),
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE UNIQUE INDEX shipping_packaging_assignment_idx
  ON shipping.packaging_assignments(channel, COALESCE(warehouse_id,0));

CREATE TABLE shipping.rate_book_charge_revisions (
  rate_book_id integer NOT NULL REFERENCES shipping.rate_books(id),
  revision integer NOT NULL CHECK (revision > 0),
  charges jsonb NOT NULL CHECK (jsonb_typeof(charges)='object'),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  actor_id text NOT NULL,
  PRIMARY KEY (rate_book_id,revision),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX shipping_program_charge_current_idx
  ON shipping.rate_book_charge_revisions(rate_book_id) WHERE effective_to IS NULL;

-- Stable identity mapping; equal dimensions alone do not prove equal boxes.
CREATE TABLE shipping.legacy_dropship_box_map (
  legacy_box_id integer PRIMARY KEY REFERENCES dropship.dropship_box_catalog(id),
  box_id integer NOT NULL UNIQUE REFERENCES shipping.box_catalog(id)
);

-- Seed explicit channel defaults to preserve each engine's previous catalog.
INSERT INTO shipping.box_suites(name,current_revision) VALUES ('Existing shared packaging',1);
INSERT INTO shipping.box_suite_revisions(suite_id,revision,name,created_at,actor_id)
  SELECT id,1,name,transaction_timestamp(),'migration:238' FROM shipping.box_suites;
INSERT INTO shipping.box_suite_members(suite_id,revision,box_id)
  SELECT s.id,1,b.id FROM shipping.box_suites s CROSS JOIN shipping.box_catalog b;
INSERT INTO shipping.packaging_assignments(channel,warehouse_id,suite_id,revision)
  SELECT c.channel,NULL,s.id,1 FROM shipping.box_suites s
  CROSS JOIN (VALUES ('shopify'),('internal'),('ebay')) c(channel);

INSERT INTO shipping.box_catalog(code,name,kind,length_mm,width_mm,height_mm,
  tare_weight_grams,max_weight_grams,cost_cents,fill_factor_bps,is_active)
SELECT 'migrated-dropship-' || id,name,'box',length_mm,width_mm,height_mm,
  tare_weight_grams,max_weight_grams,0,10000,is_active
FROM dropship.dropship_box_catalog;
INSERT INTO shipping.legacy_dropship_box_map(legacy_box_id,box_id)
  SELECT d.id,b.id FROM dropship.dropship_box_catalog d
  JOIN shipping.box_catalog b ON b.code='migrated-dropship-' || d.id;
INSERT INTO shipping.box_suites(name,current_revision) VALUES ('Dropship packaging',1);
INSERT INTO shipping.box_suite_revisions(suite_id,revision,name,created_at,actor_id)
  SELECT id,1,name,transaction_timestamp(),'migration:238' FROM shipping.box_suites
  WHERE name='Dropship packaging';
INSERT INTO shipping.box_suite_members(suite_id,revision,box_id)
  SELECT s.id,1,m.box_id FROM shipping.box_suites s CROSS JOIN shipping.legacy_dropship_box_map m
  WHERE s.name='Dropship packaging';
INSERT INTO shipping.packaging_assignments(channel,warehouse_id,suite_id,revision)
  SELECT 'dropship',NULL,id,1 FROM shipping.box_suites WHERE name='Dropship packaging';

-- Capture default service selection independently of pricing and packaging.
CREATE TABLE shipping.fulfillment_channel_services (
  channel text PRIMARY KEY CHECK (channel IN ('shopify','internal','ebay','dropship')),
  service_level_id integer NOT NULL REFERENCES shipping.service_levels(id),
  revision integer NOT NULL CHECK (revision > 0)
);
INSERT INTO shipping.fulfillment_channel_services(channel,service_level_id,revision)
  SELECT 'dropship',id,1 FROM shipping.service_levels WHERE code='standard';

ALTER TABLE shipping.rate_books ADD COLUMN charge_policy_required boolean NOT NULL DEFAULT false;

-- Existing Dropship charges move only to programs already used for vendor
-- fulfillment. A retail-shared program requires deliberate separation first.
CREATE TEMP TABLE migrated_dropship_programs ON COMMIT DROP AS
SELECT DISTINCT b.id FROM shipping.rate_books b WHERE b.status='active' AND (
  EXISTS (SELECT 1 FROM shipping.rate_book_assignments a WHERE a.rate_book_id=b.id
    AND a.is_active AND a.pricing_channel='dropship' AND a.rate_purpose='vendor_fulfillment_charge')
  OR EXISTS (SELECT 1 FROM shipping.channel_policy_routes r JOIN shipping.channel_policies p ON p.id=r.policy_id
    WHERE r.rate_book_id=b.id AND p.status='active' AND p.purpose='vendor_fulfillment_charge'));

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM migrated_dropship_programs m WHERE
    EXISTS (SELECT 1 FROM shipping.rate_book_assignments a WHERE a.rate_book_id=m.id AND a.is_active
      AND (a.pricing_channel<>'dropship' OR a.rate_purpose<>'vendor_fulfillment_charge'))
    OR EXISTS (SELECT 1 FROM shipping.channel_policy_routes r JOIN shipping.channel_policies p ON p.id=r.policy_id
      WHERE r.rate_book_id=m.id AND p.status='active' AND p.purpose='customer_checkout')) THEN
    RAISE EXCEPTION 'SHIPPING_PROGRAM_SHARED_WITH_RETAIL: separate Dropship and checkout pricing programs before migrating fees';
  END IF;
END $$;

UPDATE shipping.rate_books SET charge_policy_required=true WHERE id IN (SELECT id FROM migrated_dropship_programs);

-- Intersect all effective windows, including scheduled changes. Legacy reads
-- chose the most recent policy; overlapping policies are rejected here rather
-- than choosing one silently. Missing periods remain unquotable, as before.
CREATE TEMP TABLE migrated_charge_windows ON COMMIT DROP AS
SELECT greatest(m.effective_from,i.effective_from) AS starts,
  least(m.effective_to,i.effective_to) AS ends,
  jsonb_build_object('markup',jsonb_build_object('bps',m.markup_bps,'fixedCents',m.fixed_markup_cents,
    'minCents',m.min_markup_cents,'maxCents',m.max_markup_cents),
    'insurance',jsonb_build_object('bps',i.fee_bps,'fixedCents',0,'minCents',i.min_fee_cents,'maxCents',i.max_fee_cents)) AS charges
FROM dropship.dropship_shipping_markup_config m CROSS JOIN dropship.dropship_insurance_pool_config i
WHERE m.is_active AND i.is_active
  AND greatest(m.effective_from,i.effective_from) < COALESCE(least(m.effective_to,i.effective_to),'infinity'::timestamptz);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM (
    SELECT starts,lag(ends,1,'-infinity'::timestamptz) OVER (ORDER BY starts) AS previous_end
    FROM migrated_charge_windows
  ) w WHERE previous_end IS NULL OR starts < previous_end) THEN
    RAISE EXCEPTION 'SHIPPING_CHARGES_OVERLAP: resolve overlapping Dropship fee windows before migration';
  END IF;
END $$;
INSERT INTO shipping.rate_book_charge_revisions(rate_book_id,revision,charges,effective_from,effective_to,actor_id)
  SELECT p.id,row_number() OVER (PARTITION BY p.id ORDER BY w.starts)::integer,
    w.charges,w.starts,w.ends,'migration:238'
  FROM migrated_dropship_programs p CROSS JOIN migrated_charge_windows w;

-- Audit rows and published suite revisions are append-only. Charge windows
-- close on supersession, but their values must never be rewritten.
CREATE FUNCTION shipping.reject_configuration_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SHIPPING_CONFIGURATION_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER shipping_configuration_commands_immutable BEFORE UPDATE OR DELETE ON shipping.configuration_commands
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_configuration_history_change();
CREATE TRIGGER shipping_suite_revisions_immutable BEFORE UPDATE OR DELETE ON shipping.box_suite_revisions
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_configuration_history_change();
CREATE TRIGGER shipping_suite_members_immutable BEFORE UPDATE OR DELETE ON shipping.box_suite_members
  FOR EACH ROW EXECUTE FUNCTION shipping.reject_configuration_history_change();
CREATE INDEX shipping_configuration_history_idx ON shipping.configuration_commands(resource_key,created_at DESC);
CREATE FUNCTION shipping.protect_charge_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SHIPPING_CHARGE_HISTORY_IMMUTABLE'; END IF;
  IF NEW.rate_book_id IS DISTINCT FROM OLD.rate_book_id OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.charges IS DISTINCT FROM OLD.charges OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.effective_to IS NULL
    OR NEW.effective_to <= OLD.effective_from
    OR (OLD.effective_to IS NOT NULL AND NEW.effective_to >= OLD.effective_to) THEN
    RAISE EXCEPTION 'SHIPPING_CHARGE_HISTORY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shipping_charge_revision_immutable BEFORE UPDATE OR DELETE ON shipping.rate_book_charge_revisions
  FOR EACH ROW EXECUTE FUNCTION shipping.protect_charge_revision();

ALTER TABLE shipping.pack_plans ADD COLUMN packaging_snapshot jsonb;
COMMENT ON COLUMN shipping.pack_plans.packaging_snapshot IS
  'Resolved suite and assignment revisions plus eligible box specifications at planning time; historical plans are unchanged.';
ALTER TABLE shipping.box_catalog
  ADD COLUMN outer_length_mm integer,
  ADD COLUMN outer_width_mm integer,
  ADD COLUMN outer_height_mm integer,
  ADD CONSTRAINT shipping_box_outer_dimensions_chk CHECK (
    (outer_length_mm IS NULL AND outer_width_mm IS NULL AND outer_height_mm IS NULL)
    OR (outer_length_mm IS NOT NULL AND outer_width_mm IS NOT NULL AND outer_height_mm IS NOT NULL
      AND outer_length_mm >= length_mm AND outer_width_mm >= width_mm AND outer_height_mm >= height_mm)
  );
-- NULL means not measured. Do not manufacture outer dimensions during migration.

-- Preserve existing variant packing boundaries without leaving the live
-- cartonizer dependent on Dropship-owned packaging configuration.
CREATE TABLE shipping.channel_packing_preferences (
  channel text NOT NULL CHECK (channel IN ('shopify','internal','ebay','dropship')),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  preferred_box_id integer REFERENCES shipping.box_catalog(id),
  legacy_carrier text,
  legacy_service text,
  source text NOT NULL,
  PRIMARY KEY(channel,product_variant_id)
);
INSERT INTO shipping.channel_packing_preferences(channel,product_variant_id,preferred_box_id,legacy_carrier,legacy_service,source)
  SELECT 'dropship',p.product_variant_id,m.box_id,p.default_carrier,p.default_service,'migration:238'
  FROM dropship.dropship_package_profiles p
  LEFT JOIN shipping.legacy_dropship_box_map m ON m.legacy_box_id=p.default_box_id
  WHERE p.is_active;
COMMENT ON TABLE shipping.channel_packing_preferences IS
  'Compatibility packing boundaries. Physical facts remain catalog-owned. Carrier purchase routing is service-level owned, not selected here.';
