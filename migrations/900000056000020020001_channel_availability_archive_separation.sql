-- Catalog archival stops new channel work. Existing availability requests are
-- retained: their old schema cannot establish whether they were dispatched.
ALTER TABLE channels.channel_variant_availability_sync
  ADD COLUMN enqueued_xid xid8,
  ADD COLUMN enqueued_revision bigint,
  ADD COLUMN request_kind text CHECK (request_kind IN ('catalog_activation','stock_repair'));
ALTER TABLE channels.channel_variant_availability_sync
  DROP CONSTRAINT channel_variant_availability_sync_status_chk;
ALTER TABLE channels.channel_variant_availability_sync
  ADD CONSTRAINT channel_variant_availability_sync_status_chk
  CHECK (status IN ('pending','processing','retryable','synced','cancelled','needs_review'));
CREATE INDEX channel_variant_availability_sync_variant_idx
  ON channels.channel_variant_availability_sync(product_variant_id);
CREATE TABLE channels.channel_variant_availability_followups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  desired_active boolean NOT NULL,
  request_kind text NOT NULL CHECK (
    (request_kind='catalog_activation' AND desired_active) OR
    (request_kind='stock_repair' AND NOT desired_active)
  ),
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (channel_id, product_variant_id)
    REFERENCES channels.channel_variant_availability_sync(channel_id, product_variant_id) ON DELETE CASCADE
);
CREATE INDEX channel_variant_availability_followups_order_idx
  ON channels.channel_variant_availability_followups(channel_id,product_variant_id,id);
CREATE INDEX channel_variant_availability_followups_active_variant_idx
  ON channels.channel_variant_availability_followups(product_variant_id) WHERE desired_active;
-- Catalog uses the same exposure decision for its application check and DB
-- guard. An unsent cancellation is not exposure; an ordered activation still is.
CREATE FUNCTION channels.has_active_variant_availability(p_variant_id integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM channels.channel_variant_availability_sync q
    WHERE q.product_variant_id=p_variant_id AND (
      (q.desired_active AND q.status<>'cancelled') OR q.status='needs_review'
      OR (q.status IN ('pending','processing','retryable') AND q.enqueued_revision IS DISTINCT FROM q.revision)
    ))
    OR EXISTS (SELECT 1 FROM channels.channel_variant_availability_followups f
      WHERE f.product_variant_id=p_variant_id AND f.desired_active)
$$;
CREATE TRIGGER channel_variant_availability_followups_require_sellable
BEFORE INSERT OR UPDATE OF product_variant_id,desired_active ON channels.channel_variant_availability_followups
FOR EACH ROW WHEN (NEW.desired_active IS TRUE) EXECUTE FUNCTION catalog.assert_customer_sellable_variant();
CREATE TABLE channels.channel_variant_availability_followup_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  reason text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  actor text NOT NULL DEFAULT 'system:channel-availability',
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE FUNCTION channels.audit_variant_availability_followup()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO channels.channel_variant_availability_followup_events
    (channel_id,product_variant_id,operation,reason,before_state,after_state)
  VALUES (COALESCE(NEW.channel_id,OLD.channel_id),COALESCE(NEW.product_variant_id,OLD.product_variant_id),TG_OP,
    CASE WHEN TG_OP='DELETE' THEN COALESCE(NULLIF(current_setting('echelon.availability_followup_outcome',true),''),'owner_operation')
      ELSE 'requested' END,
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
END;
$$;
CREATE TRIGGER channel_variant_availability_followups_audit
AFTER INSERT OR UPDATE OR DELETE ON channels.channel_variant_availability_followups
FOR EACH ROW EXECUTE FUNCTION channels.audit_variant_availability_followup();
CREATE FUNCTION channels.guard_variant_availability_followup_events()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Availability follow-up history is immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER channel_variant_availability_followup_events_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON channels.channel_variant_availability_followup_events
FOR EACH STATEMENT EXECUTE FUNCTION channels.guard_variant_availability_followup_events();
CREATE TABLE channels.channel_variant_availability_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL, product_variant_id integer NOT NULL,
  revision bigint NOT NULL, lease_token uuid NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('cancelled_before_dispatch','superseded_before_dispatch','prior_work_unconfirmed')),
  before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  actor text NOT NULL DEFAULT 'system:channel-availability',
  occurred_at timestamptz NOT NULL
);
CREATE TRIGGER channel_variant_availability_decisions_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON channels.channel_variant_availability_decisions
FOR EACH STATEMENT EXECUTE FUNCTION channels.guard_variant_availability_followup_events();

-- Match Catalog's parent-then-variant locking order. The queue owner holds
-- these locks while deciding whether a saved reactivation still applies.
CREATE FUNCTION channels.lock_availability_catalog(p_variant_id integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE parent_id integer; parent_active boolean; parent_status text; actual_parent integer; variant_active boolean;
BEGIN
  SELECT p.id,p.is_active,p.status INTO parent_id,parent_active,parent_status
    FROM catalog.products p JOIN catalog.product_variants v ON v.product_id=p.id
    WHERE v.id=p_variant_id FOR SHARE OF p NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Availability catalog parent is missing' USING ERRCODE='23503'; END IF;
  SELECT v.product_id,v.is_active INTO actual_parent,variant_active
    FROM catalog.product_variants v WHERE v.id=p_variant_id FOR SHARE NOWAIT;
  IF NOT FOUND OR actual_parent IS DISTINCT FROM parent_id THEN
    RAISE EXCEPTION 'Availability catalog identity changed' USING ERRCODE='40001';
  END IF;
  RETURN parent_active IS TRUE AND parent_status IS DISTINCT FROM 'archived' AND variant_active IS TRUE;
EXCEPTION WHEN lock_not_available THEN RETURN NULL;
END;
$$;

-- One queue owns execution. A request that arrives while an older request is
-- still outstanding is retained separately rather than invalidating its lease.
CREATE FUNCTION channels.request_variant_availability_refresh(p_channel_id integer, p_variant_id integer,
  p_desired_active boolean, p_request_kind text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_status text; current_desired boolean; current_kind text; current_xid xid8; current_attempts integer;
  current_revision bigint; current_generation bigint; last_kind text;
BEGIN
  IF p_channel_id IS NULL OR p_channel_id<=0 OR p_variant_id IS NULL OR p_variant_id<=0 OR p_desired_active IS NULL
    OR p_request_kind IS NULL OR NOT ((p_request_kind='catalog_activation' AND p_desired_active)
      OR (p_request_kind='stock_repair' AND NOT p_desired_active)) THEN
    RAISE EXCEPTION 'Invalid availability request' USING ERRCODE='22023';
  END IF;
  INSERT INTO channels.channel_variant_availability_sync (
    channel_id, product_variant_id, desired_active, revision, status, attempt_count,
    next_attempt_at, created_at, updated_at, enqueued_xid, enqueued_revision, request_kind
  ) VALUES (
    p_channel_id, p_variant_id, p_desired_active, 1, 'pending', 0,
    transaction_timestamp(), transaction_timestamp(), transaction_timestamp(), pg_current_xact_id(), 1, p_request_kind
  ) ON CONFLICT (channel_id,product_variant_id) DO NOTHING;
  IF FOUND THEN RETURN; END IF;

  SELECT status,desired_active,request_kind,enqueued_xid,attempt_count,revision,enqueued_revision
    INTO STRICT current_status,current_desired,current_kind,current_xid,current_attempts,current_revision,current_generation
    FROM channels.channel_variant_availability_sync
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id FOR UPDATE;
  -- Mapping projections in one transaction can emit the same active request
  -- twice. Only coalesce a newly queued, never-claimed request from this exact
  -- transaction; historical pending rows may still have an old sender.
  IF current_status='pending' AND current_attempts=0 AND current_desired=p_desired_active
    AND current_kind=p_request_kind AND current_xid=pg_current_xact_id()
    AND current_generation=current_revision THEN RETURN; END IF;
  IF current_status IN ('synced','cancelled') AND NOT EXISTS (
    SELECT 1 FROM channels.channel_variant_availability_followups
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id
  ) THEN
    UPDATE channels.channel_variant_availability_sync
      SET desired_active=p_desired_active,revision=revision+1,status='pending',attempt_count=0,
        next_attempt_at=transaction_timestamp(),lease_token=NULL,lease_expires_at=NULL,
        completed_at=NULL,last_error=NULL,updated_at=transaction_timestamp(),enqueued_xid=pg_current_xact_id(),
        enqueued_revision=revision+1,request_kind=p_request_kind
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id;
  ELSE
    -- Preserve different operations in arrival order. Adjacent identical
    -- automatic requests express the same absolute desired outcome and can
    -- share one queued follow-up.
    SELECT request_kind INTO last_kind FROM channels.channel_variant_availability_followups
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id ORDER BY id DESC LIMIT 1 FOR UPDATE;
    IF FOUND AND last_kind=p_request_kind THEN RETURN; END IF;
    INSERT INTO channels.channel_variant_availability_followups (channel_id,product_variant_id,desired_active,request_kind)
      VALUES (p_channel_id,p_variant_id,p_desired_active,p_request_kind);
  END IF;
END;
$$;

-- Called after a completion or a proven-unsent cancellation. Take Catalog
-- before the queue lock, then process distinct operations in arrival order.
CREATE FUNCTION channels.promote_one_availability_followup(p_channel_id integer,p_variant_id integer,p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE next_record record; catalog_active boolean; processed boolean := false;
  skipped integer := 0; max_skipped CONSTANT integer := 1000;
BEGIN
  catalog_active:=channels.lock_availability_catalog(p_variant_id);
  IF catalog_active IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM channels.channel_variant_availability_sync
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id AND status IN ('synced','cancelled')
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN false; END IF;
  LOOP
    SELECT id,desired_active,request_kind INTO next_record FROM channels.channel_variant_availability_followups
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id ORDER BY id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN processed; END IF;
    PERFORM set_config('echelon.availability_followup_outcome',
      CASE WHEN next_record.desired_active AND NOT catalog_active THEN 'archived_before_dispatch' ELSE 'promoted' END,true);
    DELETE FROM channels.channel_variant_availability_followups WHERE id=next_record.id;
    PERFORM set_config('echelon.availability_followup_outcome','',true);
    processed:=true;
    IF next_record.desired_active AND NOT catalog_active THEN
      skipped:=skipped+1;
      -- Leave remaining follow-ups for the next bounded worker pass.
      IF skipped>=max_skipped THEN RETURN true; END IF;
      CONTINUE;
    END IF;
    UPDATE channels.channel_variant_availability_sync SET
      desired_active=next_record.desired_active,revision=revision+1,status='pending',attempt_count=0,
      next_attempt_at=p_now,lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,last_error=NULL,updated_at=p_now,
      enqueued_xid=pg_current_xact_id(),enqueued_revision=revision+1,request_kind=next_record.request_kind
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id;
    RETURN true;
  END LOOP;
END;
$$;

-- An older worker can complete during rollout without promoting its saved
-- follow-ups. Recover those rows before the next batch is claimed.
CREATE FUNCTION channels.promote_completed_availability_followups(p_limit integer, p_now timestamptz)
RETURNS integer LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE item record; promoted integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid availability promotion' USING ERRCODE='22023';
  END IF;
  FOR item IN SELECT q.channel_id,q.product_variant_id,MIN(f.id) AS first_id
    FROM channels.channel_variant_availability_sync q JOIN channels.channel_variant_availability_followups f
      ON f.channel_id=q.channel_id AND f.product_variant_id=q.product_variant_id
    WHERE q.status IN ('synced','cancelled') GROUP BY q.channel_id,q.product_variant_id
    ORDER BY first_id LIMIT p_limit
  LOOP
    IF channels.promote_one_availability_followup(item.channel_id,item.product_variant_id,p_now) THEN
      promoted:=promoted+1;
    END IF;
  END LOOP;
  RETURN promoted;
END;
$$;

-- Completion and promotion share the queue-row lock. An older worker cannot
-- acknowledge or erase a newer intent, and retrying a completed lease is a no-op.
CREATE FUNCTION channels.complete_variant_availability_claim(
  p_channel_id integer, p_variant_id integer, p_revision bigint, p_lease_token uuid,
  p_record_quantity boolean, p_quantity integer, p_now timestamptz
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE catalog_active boolean;
BEGIN
  IF p_channel_id IS NULL OR p_channel_id<=0 OR p_variant_id IS NULL OR p_variant_id<=0
    OR p_revision IS NULL OR p_revision<=0 OR p_lease_token IS NULL OR p_now IS NULL
    OR p_record_quantity IS NULL OR (p_record_quantity AND (p_quantity IS NULL OR p_quantity<0)) THEN
    RAISE EXCEPTION 'Invalid availability completion' USING ERRCODE='22023';
  END IF;
  catalog_active:=channels.lock_availability_catalog(p_variant_id);
  IF catalog_active IS NULL THEN
    RAISE EXCEPTION 'Availability catalog is changing; retry' USING ERRCODE='55P03';
  END IF;
  PERFORM 1 FROM channels.channel_variant_availability_sync
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id
      AND revision=p_revision AND status='processing' AND lease_token=p_lease_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE channels.channel_variant_availability_sync SET
    status='synced',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=p_now,completed_at=p_now,
    last_synced_quantity=CASE WHEN p_record_quantity THEN p_quantity ELSE last_synced_quantity END,
    last_synced_at=CASE WHEN p_record_quantity THEN p_now ELSE last_synced_at END,
    last_error=NULL,updated_at=p_now
  WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id;
  PERFORM channels.promote_one_availability_followup(p_channel_id,p_variant_id,p_now);
  RETURN true;
END;
$$;

-- Replan only a proven-unsent lease. Later operations remain ordered behind it.
CREATE FUNCTION channels.reschedule_variant_availability_claim(
  p_channel_id integer, p_variant_id integer, p_revision bigint, p_lease_token uuid,
  p_desired_active boolean, p_now timestamptz
) RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE catalog_active boolean; before_record jsonb; after_record jsonb;
  current_attempts integer; current_generation bigint; disposition text;
BEGIN
  IF p_channel_id IS NULL OR p_channel_id<=0 OR p_variant_id IS NULL OR p_variant_id<=0
    OR p_revision IS NULL OR p_revision<=0 OR p_lease_token IS NULL OR p_desired_active IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'Invalid availability reschedule' USING ERRCODE='22023';
  END IF;
  catalog_active:=channels.lock_availability_catalog(p_variant_id);
  IF catalog_active IS NULL THEN RAISE EXCEPTION 'Availability catalog is changing; retry' USING ERRCODE='55P03'; END IF;
  IF p_desired_active IS DISTINCT FROM catalog_active THEN
    RAISE EXCEPTION 'Availability catalog changed while replanning; retry' USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(q),q.attempt_count,q.enqueued_revision INTO before_record,current_attempts,current_generation
    FROM channels.channel_variant_availability_sync q
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id
      AND revision=p_revision AND status='processing' AND lease_token=p_lease_token FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- This generation may have been sent by an older worker. A newer request is
  -- not evidence that its outcome is known: retain both until recovery can
  -- reconcile the prior work. A first claim of a generation created by this
  -- owner has not yet reached a provider at this point in the worker.
  IF current_attempts<>1 OR current_generation IS DISTINCT FROM p_revision THEN
    disposition:='prior_work_unconfirmed';
    UPDATE channels.channel_variant_availability_sync AS q SET
      status='needs_review',lease_token=NULL,lease_expires_at=NULL,completed_at=NULL,
      last_error='An earlier stock update may still be outstanding. Review its saved request before transferring this listing.',
      updated_at=p_now
      WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id RETURNING to_jsonb(q) INTO after_record;
    INSERT INTO channels.channel_variant_availability_decisions
      (channel_id,product_variant_id,revision,lease_token,disposition,before_state,after_state,occurred_at)
      VALUES(p_channel_id,p_variant_id,p_revision,p_lease_token,disposition,before_record,after_record,p_now);
    RETURN true;
  END IF;

  -- If the catalog is active, restore current availability after any earlier
  -- explicit stock repairs. Archive itself never creates a zero request.
  IF catalog_active THEN
    PERFORM channels.request_variant_availability_refresh(p_channel_id,p_variant_id,true,'catalog_activation');
  END IF;
  UPDATE channels.channel_variant_availability_sync AS q SET
    status='cancelled',lease_token=NULL,lease_expires_at=NULL,completed_at=p_now,last_error=NULL,updated_at=p_now
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id;
  PERFORM channels.promote_one_availability_followup(p_channel_id,p_variant_id,p_now);
  SELECT to_jsonb(q) INTO after_record FROM channels.channel_variant_availability_sync q
    WHERE channel_id=p_channel_id AND product_variant_id=p_variant_id;
  disposition:=CASE WHEN after_record->>'status'='pending'
    THEN 'superseded_before_dispatch' ELSE 'cancelled_before_dispatch' END;
  INSERT INTO channels.channel_variant_availability_decisions
    (channel_id,product_variant_id,revision,lease_token,disposition,before_state,after_state,occurred_at)
    VALUES(p_channel_id,p_variant_id,p_revision,p_lease_token,disposition,before_record,after_record,p_now);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION channels.enqueue_variant_availability_sync()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE target record;
BEGIN
  IF NEW.is_active IS NOT TRUE OR OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.id=NEW.product_id
    AND p.is_active IS TRUE AND p.status IS DISTINCT FROM 'archived') THEN RETURN NEW; END IF;
  FOR target IN SELECT c.id FROM channels.channels c WHERE lower(c.provider)='ebay'
    AND (EXISTS (SELECT 1 FROM channels.channel_feeds f WHERE f.channel_id=c.id AND f.product_variant_id=NEW.id)
      OR EXISTS (SELECT 1 FROM channels.channel_listings l WHERE l.channel_id=c.id AND l.product_variant_id=NEW.id))
    ORDER BY c.id
  LOOP
    PERFORM channels.request_variant_availability_refresh(target.id,NEW.id,true,'catalog_activation');
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_enqueue_availability_sync ON catalog.product_variants;
CREATE TRIGGER product_variants_enqueue_availability_sync
AFTER UPDATE OF is_active ON catalog.product_variants
FOR EACH ROW
WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active AND NEW.is_active IS TRUE)
EXECUTE FUNCTION channels.enqueue_variant_availability_sync();

CREATE OR REPLACE FUNCTION channels.enqueue_mapped_variant_availability_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  catalog_allows_publication BOOLEAN;
BEGIN
  SELECT variant_row.is_active IS TRUE
    AND product_row.is_active IS TRUE
    AND product_row.status IS DISTINCT FROM 'archived'
  INTO catalog_allows_publication
  FROM catalog.product_variants AS variant_row
  JOIN catalog.products AS product_row ON product_row.id = variant_row.product_id
  JOIN channels.channels AS channel_row
    ON channel_row.id = NEW.channel_id AND lower(channel_row.provider) = 'ebay'
  WHERE variant_row.id = NEW.product_variant_id;

  IF NOT FOUND OR catalog_allows_publication IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- The completion owner identifies its own projection. Other writes while a
  -- claim is running must retain a follow-up, even for the same variant.
  IF EXISTS (
    SELECT 1 FROM channels.channel_variant_availability_sync AS availability
    WHERE availability.channel_id = NEW.channel_id
      AND availability.product_variant_id = NEW.product_variant_id
      AND availability.status = 'processing'
      AND availability.lease_token::text = current_setting('echelon.availability_completion_lease',true)
  ) THEN
    RETURN NEW;
  END IF;
  PERFORM channels.request_variant_availability_refresh(NEW.channel_id,NEW.product_variant_id,true,'catalog_activation');
  RETURN NEW;
END;
$$;

-- Replace the existing Catalog guard using the shared availability decision.
CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.sales_eligibility IS NOT DISTINCT FROM OLD.sales_eligibility
     OR NEW.sales_eligibility <> 'internal_only' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(918424, NEW.id);

  IF NEW.shopify_variant_id IS NOT NULL OR NEW.shopify_inventory_item_id IS NOT NULL THEN
    RAISE EXCEPTION 'Variant % still has a Shopify mapping', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;
  IF COALESCE(NEW.dropship_eligible, false) THEN
    RAISE EXCEPTION 'Variant % is still enabled for dropship', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;
  IF EXISTS (
    SELECT 1 FROM channels.channel_feeds f
    WHERE f.product_variant_id = NEW.id AND f.is_active = 1
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_listings l
    WHERE l.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_reservations r
    WHERE r.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_variant_overrides o
    WHERE o.product_variant_id = NEW.id AND o.is_listed <> 0
  ) OR EXISTS (
    SELECT 1 FROM channels.channel_allocation_rules r
    WHERE r.product_variant_id = NEW.id
  ) OR channels.has_active_variant_availability(NEW.id) OR EXISTS (
    SELECT 1 FROM dropship.dropship_vendor_listings l
    WHERE l.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1 FROM dropship.dropship_vendor_variant_overrides o
    WHERE o.product_variant_id = NEW.id
  ) OR EXISTS (
    SELECT 1
    FROM marketplace.listing_publication_members m
    JOIN marketplace.listing_publications p ON p.id = m.publication_id
    WHERE m.product_variant_id = NEW.id
      AND m.disposition = 'included'
      AND p.status IN ('planned', 'staged', 'active')
  ) OR EXISTS (
    SELECT 1 FROM inventory.inventory_publication_outbox o
    WHERE o.product_variant_id = NEW.id
      AND o.state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled')
  ) OR EXISTS (
    SELECT 1
    FROM wms.order_items oi
    JOIN wms.orders o ON o.id = oi.order_id
    WHERE oi.sku = NEW.sku
      AND o.warehouse_status NOT IN ('shipped', 'completed', 'cancelled', 'voided')
      AND oi.status <> 'cancelled'
      AND oi.fulfilled_quantity < oi.quantity
  ) OR EXISTS (
    SELECT 1
    FROM oms.oms_order_lines ol
    JOIN oms.oms_orders o ON o.id = ol.order_id
    WHERE ol.product_variant_id = NEW.id
      AND o.status NOT IN ('shipped', 'delivered', 'cancelled', 'refunded')
  ) THEN
    RAISE EXCEPTION 'Variant % still has customer-facing channel, listing, allocation, or publication dependencies', NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'internal_only_variant_has_customer_exposure';
  END IF;

  RETURN NEW;
END;
$$;
