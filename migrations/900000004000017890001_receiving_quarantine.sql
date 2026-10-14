-- Pending-recognition receiving custody. This records physical observation;
-- it neither opens the inventory ledger nor creates a lot, asset or AP credit.
-- The migration runner owns the transaction. No historical damage is inferred.

-- Canonical catalog ownership key (also installed by migrations159/0607).
-- Preserve historical identity if a catalog edit attempts to reparent a pack.
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_id_product_uidx ON catalog.product_variants(id,product_id);

CREATE TABLE procurement.receiving_custody_fence (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO procurement.receiving_custody_fence(singleton,revision) VALUES(true,0);

CREATE TABLE procurement.receiving_quarantine_observations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id) ON DELETE RESTRICT,
  receiving_line_id integer UNIQUE REFERENCES procurement.receiving_lines(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  holding_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  product_id integer REFERENCES catalog.products(id) ON DELETE RESTRICT,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  units_per_variant_snapshot integer,
  purchase_order_line_id integer REFERENCES procurement.purchase_order_lines(id) ON DELETE RESTRICT,
  inbound_shipment_line_id integer REFERENCES procurement.inbound_shipment_lines(id) ON DELETE RESTRICT,
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  observed_sku text CHECK (observed_sku IS NULL OR length(observed_sku) <= 200),
  unit_label text NOT NULL CHECK (length(btrim(unit_label)) BETWEEN 1 AND 80),
  condition text NOT NULL CHECK (condition IN ('damaged','unexpected','other')),
  observed_qty integer NOT NULL CHECK (observed_qty > 0),
  awaiting_receipt_qty integer NOT NULL DEFAULT 0 CHECK (awaiting_receipt_qty >= 0),
  received_qty integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  returned_qty integer NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 200),
  actor_id varchar(100) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  recorded_at timestamptz NOT NULL,
  command_key varchar(200) NOT NULL CHECK (length(btrim(command_key)) > 0),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence)='object'),
  CONSTRAINT receiving_quarantine_known_identity CHECK (
    (receiving_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL
      AND units_per_variant_snapshot IS NULL AND purchase_order_line_id IS NULL AND inbound_shipment_line_id IS NULL)
    OR (receiving_line_id IS NOT NULL AND product_id IS NOT NULL AND product_variant_id IS NOT NULL
      AND units_per_variant_snapshot IS NOT NULL AND units_per_variant_snapshot > 0)
  ),
  CONSTRAINT receiving_quarantine_nonnegative_custody CHECK (
    awaiting_receipt_qty::bigint + received_qty::bigint + returned_qty::bigint <= observed_qty::bigint
  ),
  CONSTRAINT receiving_quarantine_observation_variant_product_fk FOREIGN KEY(product_variant_id,product_id)
    REFERENCES catalog.product_variants(id,product_id) ON DELETE RESTRICT,
  CONSTRAINT receiving_quarantine_observation_command UNIQUE(receiving_order_id,actor_id,command_key)
);
CREATE INDEX receiving_quarantine_observations_receipt_idx
  ON procurement.receiving_quarantine_observations(receiving_order_id,id);
CREATE INDEX receiving_quarantine_observations_held_location_idx
  ON procurement.receiving_quarantine_observations(holding_location_id,product_id)
  WHERE observed_qty::bigint > received_qty::bigint + returned_qty::bigint;

CREATE TABLE procurement.receiving_quarantine_acceptances (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id integer NOT NULL REFERENCES procurement.receiving_quarantine_observations(id) ON DELETE RESTRICT,
  receiving_order_id integer NOT NULL REFERENCES procurement.receiving_orders(id) ON DELETE RESTRICT,
  receiving_line_id integer NOT NULL UNIQUE REFERENCES procurement.receiving_lines(id) ON DELETE RESTRICT,
  observation_qty integer NOT NULL CHECK (observation_qty > 0),
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  units_per_variant_snapshot integer NOT NULL CHECK (units_per_variant_snapshot > 0),
  accepted_variant_qty integer NOT NULL CHECK (accepted_variant_qty > 0),
  status text NOT NULL DEFAULT 'awaiting_receipt' CHECK (status IN ('awaiting_receipt','received','cancelled')),
  actor_id varchar(100) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  created_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  source_evidence jsonb NOT NULL CHECK (jsonb_typeof(source_evidence)='object'),
  CONSTRAINT receiving_quarantine_acceptance_variant_product_fk FOREIGN KEY(product_variant_id,product_id)
    REFERENCES catalog.product_variants(id,product_id) ON DELETE RESTRICT
);
CREATE INDEX receiving_quarantine_acceptances_observation_idx
  ON procurement.receiving_quarantine_acceptances(observation_id,id);
CREATE INDEX receiving_quarantine_acceptances_receipt_idx
  ON procurement.receiving_quarantine_acceptances(receiving_order_id,status,id);

CREATE TABLE procurement.receiving_quarantine_dispositions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id integer NOT NULL REFERENCES procurement.receiving_quarantine_observations(id) ON DELETE RESTRICT,
  acceptance_id integer REFERENCES procurement.receiving_quarantine_acceptances(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('prepare_acceptance','cancel_acceptance','receive','return')),
  observation_qty integer NOT NULL CHECK (observation_qty > 0),
  actor_id varchar(100) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  recorded_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  evidence_reference text CHECK (evidence_reference IS NULL OR length(btrim(evidence_reference)) BETWEEN 1 AND 200),
  version_before integer NOT NULL CHECK (version_before >= 0),
  version_after integer NOT NULL CHECK (version_after > 0 AND version_after::bigint = version_before::bigint + 1),
  command_key varchar(200) NOT NULL CHECK (length(btrim(command_key)) > 0),
  request_evidence jsonb NOT NULL CHECK (jsonb_typeof(request_evidence)='object'),
  CONSTRAINT receiving_quarantine_disposition_acceptance CHECK (
    (kind='return' AND acceptance_id IS NULL AND evidence_reference IS NOT NULL)
    OR (kind<>'return' AND acceptance_id IS NOT NULL)
  ),
  CONSTRAINT receiving_quarantine_disposition_version UNIQUE(observation_id,version_after)
);
CREATE UNIQUE INDEX receiving_quarantine_acceptance_prepare_uidx
  ON procurement.receiving_quarantine_dispositions(acceptance_id) WHERE kind='prepare_acceptance';
CREATE UNIQUE INDEX receiving_quarantine_acceptance_terminal_uidx
  ON procurement.receiving_quarantine_dispositions(acceptance_id) WHERE kind IN ('cancel_acceptance','receive');

CREATE FUNCTION procurement.guard_receiving_quarantine_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine history cannot be deleted';
  END IF;
  IF TG_TABLE_NAME='receiving_quarantine_observations' THEN
    IF (to_jsonb(NEW)-ARRAY['awaiting_receipt_qty','received_qty','returned_qty','version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['awaiting_receipt_qty','received_qty','returned_qty','version']) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine observation evidence is immutable';
    END IF;
  ELSIF TG_TABLE_NAME='receiving_quarantine_acceptances' THEN
    IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status')
      OR OLD.status<>'awaiting_receipt' OR NEW.status NOT IN ('received','cancelled') THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine acceptance permits one terminal disposition only';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine dispositions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_quarantine_observation_immutable BEFORE UPDATE OR DELETE
  ON procurement.receiving_quarantine_observations FOR EACH ROW EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_quarantine_acceptance_immutable BEFORE UPDATE OR DELETE
  ON procurement.receiving_quarantine_acceptances FOR EACH ROW EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_quarantine_disposition_immutable BEFORE UPDATE OR DELETE
  ON procurement.receiving_quarantine_dispositions FOR EACH ROW EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_quarantine_observation_no_truncate BEFORE TRUNCATE
  ON procurement.receiving_quarantine_observations FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_quarantine_acceptance_no_truncate BEFORE TRUNCATE
  ON procurement.receiving_quarantine_acceptances FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_quarantine_disposition_no_truncate BEFORE TRUNCATE
  ON procurement.receiving_quarantine_dispositions FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();
CREATE TRIGGER receiving_custody_fence_no_remove BEFORE DELETE OR TRUNCATE
  ON procurement.receiving_custody_fence FOR EACH STATEMENT EXECUTE FUNCTION procurement.guard_receiving_quarantine_history();

-- Deferred proof lets the business transaction prepare/close/cancel receiving
-- and append its disposition in either statement order, but never commit half.
CREATE FUNCTION procurement.check_receiving_quarantine_observation(p_observation_id integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  observation procurement.receiving_quarantine_observations%ROWTYPE;
  receipt procurement.receiving_orders%ROWTYPE;
  source_line procurement.receiving_lines%ROWTYPE;
  totals record;
  acceptance_totals record;
  acceptance record;
  prepared_count bigint;
  terminal_count bigint;
  terminal_kind text;
BEGIN
  SELECT * INTO STRICT observation FROM procurement.receiving_quarantine_observations WHERE id=p_observation_id;
  SELECT * INTO STRICT receipt FROM procurement.receiving_orders WHERE id=observation.receiving_order_id;
  IF receipt.warehouse_id IS DISTINCT FROM observation.warehouse_id
    OR NOT EXISTS (SELECT 1 FROM warehouse.warehouse_locations location
      WHERE location.id=observation.holding_location_id AND location.warehouse_id=observation.warehouse_id
        AND location.location_type IS DISTINCT FROM '3pl_virtual') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine warehouse and physical location evidence disagree';
  END IF;
  IF observation.receiving_line_id IS NOT NULL THEN
    SELECT * INTO STRICT source_line FROM procurement.receiving_lines WHERE id=observation.receiving_line_id;
    IF source_line.receiving_order_id IS DISTINCT FROM observation.receiving_order_id
      OR source_line.product_id IS DISTINCT FROM observation.product_id
      OR source_line.product_variant_id IS DISTINCT FROM observation.product_variant_id
      OR source_line.units_per_variant_snapshot IS DISTINCT FROM observation.units_per_variant_snapshot
      OR source_line.purchase_order_line_id IS DISTINCT FROM observation.purchase_order_line_id
      OR source_line.inbound_shipment_line_id IS DISTINCT FROM observation.inbound_shipment_line_id
      OR NOT EXISTS (SELECT 1 FROM catalog.product_variants variant
        WHERE variant.id=observation.product_variant_id AND variant.product_id=observation.product_id) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine source line identity disagrees with its immutable observation';
    END IF;
  END IF;
  SELECT count(*) AS versions,coalesce(max(version_after),0) AS last_version,
    coalesce(sum(observation_qty::bigint) FILTER (WHERE kind='prepare_acceptance'),0) AS prepared,
    coalesce(sum(observation_qty::bigint) FILTER (WHERE kind='cancel_acceptance'),0) AS cancelled,
    coalesce(sum(observation_qty::bigint) FILTER (WHERE kind='receive'),0) AS received,
    coalesce(sum(observation_qty::bigint) FILTER (WHERE kind='return'),0) AS returned
    INTO totals FROM procurement.receiving_quarantine_dispositions WHERE observation_id=p_observation_id;
  IF totals.versions<>observation.version OR totals.last_version<>observation.version
    OR totals.prepared-totals.cancelled-totals.received<>observation.awaiting_receipt_qty
    OR totals.received<>observation.received_qty OR totals.returned<>observation.returned_qty THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine counters or version lack complete immutable disposition evidence';
  END IF;
  SELECT coalesce(sum(observation_qty::bigint) FILTER (WHERE status='awaiting_receipt'),0) AS awaiting,
    coalesce(sum(observation_qty::bigint) FILTER (WHERE status='received'),0) AS received
    INTO acceptance_totals FROM procurement.receiving_quarantine_acceptances WHERE observation_id=p_observation_id;
  IF acceptance_totals.awaiting<>observation.awaiting_receipt_qty OR acceptance_totals.received<>observation.received_qty THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine pending custody disagrees with its acceptance records';
  END IF;
  FOR acceptance IN SELECT a.*,line.receiving_order_id AS line_receipt_id,line.product_id AS line_product_id,line.product_variant_id AS line_variant_id,
      line.units_per_variant_snapshot AS line_units,line.received_qty AS line_received,line.expected_qty AS line_expected,
      line.damaged_qty AS line_damaged,line.putaway_complete AS line_putaway,line.putaway_location_id AS line_location_id,
      target.status AS target_status,target.warehouse_id AS target_warehouse_id,variant.product_id AS target_product_id
    FROM procurement.receiving_quarantine_acceptances a
    JOIN procurement.receiving_lines line ON line.id=a.receiving_line_id
    JOIN procurement.receiving_orders target ON target.id=a.receiving_order_id
    JOIN catalog.product_variants variant ON variant.id=a.product_variant_id
    WHERE a.observation_id=p_observation_id
  LOOP
    IF acceptance.line_receipt_id<>acceptance.receiving_order_id
      OR acceptance.target_warehouse_id IS DISTINCT FROM observation.warehouse_id
      OR acceptance.line_product_id IS DISTINCT FROM acceptance.product_id
      OR acceptance.line_variant_id IS DISTINCT FROM acceptance.product_variant_id
      OR acceptance.line_units IS DISTINCT FROM acceptance.units_per_variant_snapshot
      OR acceptance.line_damaged<>0
      OR (observation.product_id IS NOT NULL AND observation.product_id<>acceptance.target_product_id)
      OR (observation.units_per_variant_snapshot IS NOT NULL AND
        observation.units_per_variant_snapshot::bigint * acceptance.observation_qty::bigint
          <> acceptance.units_per_variant_snapshot::bigint * acceptance.accepted_variant_qty::bigint) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine acceptance source or exact unit conversion disagrees';
    END IF;
    SELECT count(*) INTO prepared_count FROM procurement.receiving_quarantine_dispositions
      WHERE acceptance_id=acceptance.id AND kind='prepare_acceptance' AND observation_id=p_observation_id
        AND observation_qty=acceptance.observation_qty;
    SELECT count(*),max(kind) INTO terminal_count,terminal_kind FROM procurement.receiving_quarantine_dispositions
      WHERE acceptance_id=acceptance.id AND kind IN ('receive','cancel_acceptance')
        AND observation_id=p_observation_id AND observation_qty=acceptance.observation_qty;
    IF prepared_count<>1 OR (acceptance.status='awaiting_receipt' AND terminal_count<>0)
      OR (acceptance.status='received' AND (terminal_count<>1 OR terminal_kind<>'receive'))
      OR (acceptance.status='cancelled' AND (terminal_count<>1 OR terminal_kind<>'cancel_acceptance')) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine acceptance lacks its matching immutable disposition';
    END IF;
    IF acceptance.status='cancelled' THEN
      IF acceptance.line_received<>0 OR acceptance.line_expected<>0 OR acceptance.line_putaway<>0 THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Cancelled quarantine acceptance must retain an unposted zero-count source line';
      END IF;
    ELSE
      IF acceptance.line_received<>acceptance.accepted_variant_qty OR acceptance.line_expected<>acceptance.accepted_variant_qty THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Quarantine acceptance counts cannot be changed outside its custody owner';
      END IF;
      IF acceptance.status='awaiting_receipt' AND (acceptance.target_status IN ('closed','cancelled') OR acceptance.line_putaway<>0) THEN
        RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Prepared quarantine acceptance must remain unposted until atomic receipt completion';
      END IF;
      IF acceptance.status='received' THEN
        IF acceptance.target_status<>'closed' OR acceptance.line_putaway<>1
          OR NOT EXISTS (SELECT 1 FROM inventory.inventory_transactions posted
            WHERE posted.receiving_order_id=acceptance.receiving_order_id AND posted.receiving_line_id=acceptance.receiving_line_id
              AND posted.transaction_type='receipt' AND posted.voided_at IS NULL
              AND posted.product_variant_id=acceptance.product_variant_id AND posted.to_location_id=acceptance.line_location_id
              AND posted.variant_qty_delta=acceptance.accepted_variant_qty) THEN
          RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Released quarantine custody requires the exact committed physical receipt';
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM procurement.receiving_quarantine_dispositions d
    JOIN procurement.receiving_quarantine_acceptances a ON a.id=d.acceptance_id
    WHERE d.observation_id=p_observation_id AND (a.observation_id<>d.observation_id OR a.observation_qty<>d.observation_qty)) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Receiving quarantine disposition refers to another custody observation';
  END IF;
END $$;

CREATE FUNCTION procurement.check_receiving_quarantine_constraint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked_observation_id integer;
BEGIN
  IF TG_TABLE_NAME='receiving_quarantine_observations' THEN
    PERFORM procurement.check_receiving_quarantine_observation(NEW.id);
  ELSIF TG_TABLE_NAME IN ('receiving_quarantine_acceptances','receiving_quarantine_dispositions') THEN
    PERFORM procurement.check_receiving_quarantine_observation(NEW.observation_id);
  ELSIF TG_TABLE_NAME='receiving_lines' THEN
    FOR checked_observation_id IN SELECT id FROM procurement.receiving_quarantine_observations WHERE receiving_line_id=NEW.id
      UNION SELECT observation_id FROM procurement.receiving_quarantine_acceptances WHERE receiving_line_id=NEW.id
    LOOP PERFORM procurement.check_receiving_quarantine_observation(checked_observation_id); END LOOP;
  ELSIF TG_TABLE_NAME='receiving_orders' THEN
    FOR checked_observation_id IN SELECT id FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=NEW.id
      UNION SELECT observation_id FROM procurement.receiving_quarantine_acceptances WHERE receiving_order_id=NEW.id
    LOOP PERFORM procurement.check_receiving_quarantine_observation(checked_observation_id); END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receiving_quarantine_observation_proof AFTER INSERT OR UPDATE
  ON procurement.receiving_quarantine_observations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION procurement.check_receiving_quarantine_constraint();
CREATE CONSTRAINT TRIGGER receiving_quarantine_acceptance_proof AFTER INSERT OR UPDATE
  ON procurement.receiving_quarantine_acceptances DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION procurement.check_receiving_quarantine_constraint();
CREATE CONSTRAINT TRIGGER receiving_quarantine_disposition_proof AFTER INSERT
  ON procurement.receiving_quarantine_dispositions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION procurement.check_receiving_quarantine_constraint();
CREATE CONSTRAINT TRIGGER receiving_quarantine_line_proof AFTER UPDATE
  ON procurement.receiving_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION procurement.check_receiving_quarantine_constraint();
CREATE CONSTRAINT TRIGGER receiving_quarantine_order_proof AFTER UPDATE
  ON procurement.receiving_orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION procurement.check_receiving_quarantine_constraint();

-- Once explicitly separated, a normal editor must not recreate held units in
-- the original accepted count. Dedicated acceptance lines are checked at commit
-- so their one allowed cancellation can zero counts within the same transaction.
CREATE FUNCTION procurement.guard_observed_receiving_line_counts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.product_id,NEW.product_variant_id,NEW.units_per_variant_snapshot,
      NEW.purchase_order_line_id,NEW.inbound_shipment_line_id,NEW.receiving_order_id)
    IS DISTINCT FROM (OLD.product_id,OLD.product_variant_id,OLD.units_per_variant_snapshot,
      OLD.purchase_order_line_id,OLD.inbound_shipment_line_id,OLD.receiving_order_id)
    AND EXISTS (SELECT 1 FROM procurement.receiving_quarantine_acceptances WHERE receiving_line_id=OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Quarantine acceptance source identity is immutable';
  END IF;
  IF (NEW.received_qty,NEW.damaged_qty,NEW.expected_qty,NEW.product_id,NEW.product_variant_id,
      NEW.units_per_variant_snapshot,NEW.purchase_order_line_id,NEW.inbound_shipment_line_id,NEW.receiving_order_id)
    IS DISTINCT FROM (OLD.received_qty,OLD.damaged_qty,OLD.expected_qty,OLD.product_id,OLD.product_variant_id,
      OLD.units_per_variant_snapshot,OLD.purchase_order_line_id,OLD.inbound_shipment_line_id,OLD.receiving_order_id)
    AND EXISTS (SELECT 1 FROM procurement.receiving_quarantine_observations WHERE receiving_line_id=OLD.id) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Observed receiving counts and source identity are immutable; resolve recorded custody explicitly';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_quarantine_observed_line_counts BEFORE UPDATE ON procurement.receiving_lines
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_observed_receiving_line_counts();
