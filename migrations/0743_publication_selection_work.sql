-- Change notifications, not another inclusion setting. Source owners retain all
-- listing decisions; the existing inventory planner derives current quantities.
CREATE TABLE inventory.publication_selection_work (
  product_id integer PRIMARY KEY CHECK (product_id > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  acknowledged_revision bigint NOT NULL DEFAULT 0 CHECK (acknowledged_revision >= 0 AND acknowledged_revision <= revision),
  last_invalidating_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  next_boundary_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
CREATE INDEX publication_selection_work_due ON inventory.publication_selection_work(next_attempt_at)
  WHERE revision > acknowledged_revision;
CREATE INDEX publication_selection_work_boundary ON inventory.publication_selection_work(next_boundary_at)
  WHERE next_boundary_at IS NOT NULL;
CREATE TABLE inventory.publication_selection_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL CHECK (product_id > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  outcome text NOT NULL CHECK (outcome IN ('planned','blocked')),
  error_code text,
  occurred_at timestamptz NOT NULL,
  CHECK ((outcome='planned' AND error_code IS NULL) OR (outcome='blocked' AND error_code IS NOT NULL))
);
CREATE FUNCTION inventory.guard_publication_selection_attempts() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'PUBLICATION_SELECTION_AUDIT_IMMUTABLE'; END;
$$;
CREATE TRIGGER publication_selection_attempts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE
  ON inventory.publication_selection_attempts FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_publication_selection_attempts();

-- Deadlines are scheduling facts, not an implementation of the exposure rules.
-- A conservative extra replan is safe; only the Dropship resolver selects SKUs.
CREATE FUNCTION inventory.next_publication_selection_boundary(observed_at timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT min(boundary) FROM dropship.dropship_catalog_rules r
    CROSS JOIN LATERAL (VALUES(r.starts_at),(r.ends_at)) deadlines(boundary)
    WHERE r.is_active=true AND boundary>observed_at
$$;

CREATE FUNCTION inventory.invalidate_publication_selection_product(affected_product integer)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  -- Unenrolled products cannot send stock. Mapping activation emits the same
  -- invalidation; it will read current selection when enrollment becomes real.
  IF affected_product IS NULL OR NOT EXISTS (
    SELECT 1 FROM inventory.publication_variant_mapping_heads h
    JOIN catalog.product_variants v ON v.id=h.product_variant_id
    WHERE v.product_id=affected_product AND h.active_mapping_id IS NOT NULL
  ) THEN RETURN; END IF;
  INSERT INTO inventory.publication_selection_work(product_id,next_boundary_at)
    VALUES(affected_product,inventory.next_publication_selection_boundary(transaction_timestamp()))
  ON CONFLICT(product_id) DO UPDATE SET
    revision=CASE WHEN publication_selection_work.last_invalidating_xid=pg_current_xact_id()
      THEN publication_selection_work.revision ELSE publication_selection_work.revision+1 END,
    last_invalidating_xid=pg_current_xact_id(), next_attempt_at=transaction_timestamp(),
    next_boundary_at=inventory.next_publication_selection_boundary(transaction_timestamp()),
    attempt_count=0,last_error_code=NULL,updated_at=transaction_timestamp();
END;
$$;

CREATE FUNCTION inventory.gate_publication_selection_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  -- Fail/retry rather than invert locks held by an existing multi-step owner.
  -- ACK/projection writes do not take this exclusive gate: some occur inside an
  -- admitted provider request that already owns its shared side.
  IF NOT pg_try_advisory_xact_lock(918419,0) THEN
    RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='PUBLICATION_SELECTION_BUSY';
  END IF;
  IF TG_LEVEL='ROW' THEN RETURN NEW; END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION inventory.notify_publication_selection_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE before_row jsonb; after_row jsonb; field_name text; changed boolean := TG_OP<>'UPDATE'; affected integer;
BEGIN
  IF TG_OP<>'INSERT' THEN before_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN after_row:=to_jsonb(NEW); END IF;
  IF TG_OP='UPDATE' THEN
    FOREACH field_name IN ARRAY string_to_array(TG_ARGV[1],',') LOOP
      IF before_row->field_name IS DISTINCT FROM after_row->field_name THEN changed:=true; EXIT; END IF;
    END LOOP;
  END IF;
  IF NOT changed THEN RETURN NULL; END IF;
  IF TG_ARGV[0]='all' THEN
    FOR affected IN SELECT DISTINCT v.product_id FROM inventory.publication_variant_mapping_heads h
      JOIN catalog.product_variants v ON v.id=h.product_variant_id WHERE h.active_mapping_id IS NOT NULL
    LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;
  ELSIF TG_ARGV[0]='variant' THEN
    FOR affected IN SELECT DISTINCT product_id FROM catalog.product_variants WHERE id IN
      ((before_row->>'product_variant_id')::integer,(after_row->>'product_variant_id')::integer)
    LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;
  ELSE
    -- The field is an explicit literal supplied by the migration manifest.
    PERFORM inventory.invalidate_publication_selection_product((before_row->>TG_ARGV[0])::integer);
    PERFORM inventory.invalidate_publication_selection_product((after_row->>TG_ARGV[0])::integer);
  END IF;
  RETURN NULL;
END;
$$;

DO $$
DECLARE entry record; relation regclass; column_name text; update_columns text;
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('channels.channel_product_overrides','product_id','channel_id,product_id,is_listed',true),
    ('channels.channel_variant_overrides','variant','channel_id,product_variant_id,is_listed',true),
    ('channels.channel_feeds','variant','channel_id,product_variant_id,is_active,quarantined_at,channel_variant_id,channel_inventory_item_id,channel_sku',false),
    ('catalog.products','id','is_active,status,product_type,category,ebay_listing_excluded',true),
    ('catalog.product_variants','product_id','product_id,is_active,requires_shipping,track_inventory,sales_eligibility,ebay_listing_excluded,sku,uom_type',true),
    ('catalog.product_line_products','product_id','product_id,product_line_id',true),
    ('ebay.ebay_category_mappings','all','channel_id,product_type_slug,listing_enabled',true),
    ('dropship.dropship_catalog_rules','all','scope_type,action,product_line_id,product_id,product_variant_id,category,starts_at,ends_at,is_active,priority',true),
    ('dropship.dropship_vendor_selection_rules','all','vendor_id,scope_type,action,product_line_id,product_id,product_variant_id,category,auto_connect_new_skus,auto_list_new_skus,is_active,priority',true),
    ('dropship.dropship_vendor_variant_overrides','variant','vendor_id,product_variant_id,enabled_override',true),
    ('dropship.dropship_store_listing_configs','all','store_connection_id,listing_mode,inventory_mode,is_active',true),
    ('dropship.dropship_store_connections','all','status',false),
    ('channels.channel_listings','variant','channel_id,product_variant_id,external_product_id,external_variant_id,external_sku',false),
    ('channels.ebay_listing_sync_jobs','product_id','operation,identity,provider_identity',false),
    ('dropship.dropship_vendor_listings','variant','vendor_id,store_connection_id,product_variant_id,status,external_listing_id,external_offer_id',false),
    ('dropship.dropship_listing_push_job_items','variant','listing_id,product_variant_id,action,status',false),
    ('dropship.dropship_listing_push_jobs','all','vendor_id,store_connection_id,status',false),
    ('inventory.publication_variant_mapping_heads','variant','publication_target_id,product_variant_id,active_mapping_id',false)
  ) manifest(table_name,product_field,selection_columns,gated) LOOP
    relation:=to_regclass(entry.table_name);
    IF relation IS NULL THEN RAISE EXCEPTION 'selection prerequisite table missing: %',entry.table_name; END IF;
    FOREACH column_name IN ARRAY string_to_array(entry.selection_columns,',') LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname=column_name AND attnum>0 AND NOT attisdropped)
        THEN RAISE EXCEPTION 'selection prerequisite column missing: %.%',entry.table_name,column_name; END IF;
    END LOOP;
    SELECT string_agg(quote_ident(c),',') INTO update_columns FROM unnest(string_to_array(entry.selection_columns,',')) c;
    IF entry.gated THEN
      EXECUTE format('CREATE TRIGGER ac_publication_selection_gate BEFORE INSERT OR DELETE OR UPDATE OF %s ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change()',update_columns,relation);
    END IF;
    EXECUTE format('CREATE TRIGGER publication_selection_invalidation AFTER INSERT OR DELETE OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION inventory.notify_publication_selection_change(%L,%L)',
      update_columns,relation,entry.product_field,entry.selection_columns);
  END LOOP;
END;
$$;

-- Feed ACKs routinely write unchanged is_active=1 and upsert identities. Gate
-- only a real on/off transition, never those acknowledgments. TRY is essential:
-- a row trigger already owns its source row and must not wait in reverse order.
CREATE TRIGGER ac_publication_selection_gate BEFORE UPDATE OF is_active ON channels.channel_feeds
  FOR EACH ROW WHEN (OLD.is_active IS DISTINCT FROM NEW.is_active)
  EXECUTE FUNCTION inventory.gate_publication_selection_change();
CREATE TRIGGER ac_publication_selection_delete_gate BEFORE DELETE ON channels.channel_feeds
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change();
CREATE TRIGGER ac_publication_selection_pause_gate BEFORE UPDATE OF status ON dropship.dropship_store_connections
  FOR EACH ROW WHEN ((OLD.status='paused') IS DISTINCT FROM (NEW.status='paused'))
  EXECUTE FUNCTION inventory.gate_publication_selection_change();

-- Existing mappings also receive one current-selection plan after deployment.
-- This schedules the existing owner; the migration makes no provider request.
SELECT inventory.invalidate_publication_selection_product(product_id) FROM
  (SELECT DISTINCT v.product_id FROM inventory.publication_variant_mapping_heads h
   JOIN catalog.product_variants v ON v.id=h.product_variant_id WHERE h.active_mapping_id IS NOT NULL) current_products;
