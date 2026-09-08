-- Global cutover admission, not activation. No authority/configuration values change.
-- A dedicated singleton row replaces colliding advisory namespaces. Epoch writes
-- make a pre-freeze RR/SERIALIZABLE writer fail with 40001 instead of accepting an
-- invisible freeze. The existing activation_freezes table remains the only
-- durable configuration freeze. HTTP/provider admission is a separate lifecycle.
CREATE TABLE inventory.cutover_admission_fence (
  singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key),
  epoch bigint NOT NULL CHECK (epoch > 0),
  owner_transaction_id xid8,
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
INSERT INTO inventory.cutover_admission_fence(singleton_key,epoch) VALUES (true,1);

CREATE FUNCTION inventory.assert_cutover_admission_fence_owner()
RETURNS bigint LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE fence inventory.cutover_admission_fence%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed'
     OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_READ_COMMITTED_TRANSACTION_REQUIRED';
  END IF;
  SELECT * INTO fence FROM inventory.cutover_admission_fence WHERE singleton_key=true FOR UPDATE NOWAIT;
  IF NOT FOUND OR fence.epoch <= 0 OR fence.owner_transaction_id IS NULL
     OR fence.owner_transaction_id IS DISTINCT FROM pg_current_xact_id_if_assigned() THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_EXCLUSIVE_ADMISSION_REQUIRED';
  END IF;
  RETURN fence.epoch;
END;
$$;

-- A direct row update cannot mint an owner capability without first excluding
-- every authority reader. NOWAIT here avoids an admission->authority wait cycle.
CREATE FUNCTION inventory.guard_cutover_admission_owner_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE authority_row inventory.availability_runtime_authority%ROWTYPE;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_SINGLETON_IMMUTABLE';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed'
     OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_READ_COMMITTED_TRANSACTION_REQUIRED';
  END IF;
  SELECT * INTO authority_row FROM inventory.availability_runtime_authority
    WHERE singleton_key=true FOR UPDATE NOWAIT;
  IF NOT FOUND OR authority_row.authority IS NULL OR authority_row.authority NOT IN ('legacy','canonical')
     OR authority_row.revision IS NULL OR authority_row.revision <= 0
     OR (authority_row.authority='legacy' AND authority_row.activation_run_id IS NOT NULL)
     OR (authority_row.authority='canonical' AND authority_row.activation_run_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_AUTHORITY_INVALID';
  END IF;
  IF NEW.singleton_key IS DISTINCT FROM OLD.singleton_key
     OR NEW.epoch IS DISTINCT FROM OLD.epoch + 1
     OR NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
     OR NEW.changed_at IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_OWNER_INVALID';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cutover_admission_owner_write_guard
BEFORE INSERT OR UPDATE OR DELETE ON inventory.cutover_admission_fence
FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_admission_owner_write();
CREATE TRIGGER cutover_admission_owner_truncate_guard
BEFORE TRUNCATE ON inventory.cutover_admission_fence
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_cutover_admission_owner_write();

CREATE FUNCTION inventory.acquire_cutover_admission_fence(
  expected_authority text, expected_configuration_run_id bigint
) RETURNS TABLE(epoch bigint, authority text, authority_revision bigint, configuration_run_id bigint)
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE authority_row inventory.availability_runtime_authority%ROWTYPE;
        current_epoch bigint; freeze_count bigint; open_run_id bigint;
BEGIN
  IF expected_authority IS NULL OR expected_authority NOT IN ('legacy','canonical')
     OR (expected_configuration_run_id IS NOT NULL AND expected_configuration_run_id <= 0) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CUTOVER_FENCE_EXPECTATION_INVALID';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed'
     OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_READ_COMMITTED_TRANSACTION_REQUIRED';
  END IF;
  -- This wait must precede admission. RC recapture after the drain sees committed
  -- legacy work. RR would preserve a stale pre-wait catalog/demand snapshot.
  SELECT * INTO authority_row FROM inventory.availability_runtime_authority
    WHERE singleton_key=true FOR UPDATE;
  IF NOT FOUND OR authority_row.authority IS NULL OR authority_row.authority NOT IN ('legacy','canonical')
     OR authority_row.revision IS NULL OR authority_row.revision <= 0
     OR (authority_row.authority='legacy' AND authority_row.activation_run_id IS NOT NULL)
     OR (authority_row.authority='canonical' AND authority_row.activation_run_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_AUTHORITY_INVALID';
  END IF;
  IF authority_row.authority <> expected_authority THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_AUTHORITY_CHANGED';
  END IF;
  SELECT admission.epoch INTO current_epoch FROM inventory.cutover_admission_fence admission
    WHERE singleton_key=true FOR UPDATE NOWAIT;
  IF NOT FOUND OR current_epoch <= 0 THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_SINGLETON_MISSING';
  END IF;
  SELECT count(*), max(configured_freeze.activation_run_id) INTO freeze_count,open_run_id
    FROM inventory.availability_activation_freezes configured_freeze WHERE configured_freeze.released_at IS NULL;
  IF freeze_count > 1 OR open_run_id IS DISTINCT FROM expected_configuration_run_id THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_CONFIGURATION_FREEZE_CHANGED';
  END IF;
  UPDATE inventory.cutover_admission_fence
    SET epoch=current_epoch+1, owner_transaction_id=pg_current_xact_id(), changed_at=transaction_timestamp()
    WHERE singleton_key=true;
  RETURN QUERY SELECT current_epoch+1, authority_row.authority::text, authority_row.revision, open_run_id;
END;
$$;

CREATE FUNCTION inventory.pin_cutover_writer_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE current_epoch bigint;
BEGIN
  -- Hold SHARE until commit. Never wait behind a cutover owner after obtaining
  -- order/graph/cost locks elsewhere. A stale RR row-lock read raises 40001.
  SELECT epoch INTO current_epoch FROM inventory.cutover_admission_fence
    WHERE singleton_key=true FOR SHARE NOWAIT;
  IF NOT FOUND OR current_epoch <= 0 THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_SINGLETON_MISSING';
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION inventory.guard_cutover_control_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION inventory.guard_cutover_configuration_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE owner_xid xid8; frozen_run_id bigint; field_path text;
        old_row jsonb; new_row jsonb; semantic_changed boolean;
BEGIN
  -- The statement trigger already pinned admission SHARE. Therefore the freeze
  -- cannot change until this statement's transaction completes.
  SELECT owner_transaction_id INTO owner_xid FROM inventory.cutover_admission_fence WHERE singleton_key=true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_SINGLETON_MISSING';
  END IF;
  IF owner_xid IS NOT NULL AND owner_xid = pg_current_xact_id_if_assigned() THEN
    IF TG_LEVEL='STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT activation_run_id INTO frozen_run_id FROM inventory.availability_activation_freezes WHERE released_at IS NULL;
  IF frozen_run_id IS NULL THEN
    IF TG_LEVEL='STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  semantic_changed := TG_OP <> 'UPDATE';
  IF TG_OP='UPDATE' THEN
    old_row := to_jsonb(OLD); new_row := to_jsonb(NEW);
    FOREACH field_path IN ARRAY TG_ARGV LOOP
      IF field_path='*' THEN
        semantic_changed := (old_row - 'updated_at') IS DISTINCT FROM (new_row - 'updated_at');
      ELSE
        semantic_changed := (old_row #> string_to_array(field_path,'.'))
          IS DISTINCT FROM (new_row #> string_to_array(field_path,'.'));
      END IF;
      EXIT WHEN semantic_changed;
    END LOOP;
  END IF;
  IF semantic_changed THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_CONFIGURATION_FROZEN',
      DETAIL=format('activation_run_id=%s table=%I.%I',frozen_run_id,TG_TABLE_SCHEMA,TG_TABLE_NAME);
  END IF;
  IF TG_LEVEL='STATEMENT' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $install$
DECLARE entry record; relation regclass; field_path text; trigger_record record; arguments text;
BEGIN
  -- Remove only old freeze triggers bound to the replaced function; preserve
  -- immutable version, lifecycle, cost, reservation and ownership constraints.
  FOR trigger_record IN
    SELECT installed_trigger.tgname, installed_trigger.tgrelid::regclass AS relation
    FROM pg_trigger installed_trigger WHERE NOT installed_trigger.tgisinternal
      AND installed_trigger.tgfoid='inventory.guard_cutover_configuration_write()'::regprocedure
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %s',trigger_record.tgname,trigger_record.relation);
  END LOOP;
  FOR entry IN SELECT * FROM (VALUES
    ('catalog.products', ARRAY['id','sku','base_unit','inventory_strategy','safety_stock_days','status','inventory_type','is_active' ]::text[]),
    ('catalog.product_variants', ARRAY['id','product_id','sku','uom_type','units_per_variant','hierarchy_level','parent_variant_id','is_base_unit','requires_shipping','track_inventory','sales_eligibility','inventory_policy','shopify_variant_id','shopify_inventory_item_id','is_active','dropship_eligible' ]::text[]),
    ('inventory.build_recipes', ARRAY['*' ]::text[]),
    ('inventory.build_recipe_components', ARRAY['*' ]::text[]),
    ('inventory.transformation_model_heads', ARRAY['*' ]::text[]),
    ('inventory.transformation_model_versions', ARRAY['*' ]::text[]),
    ('inventory.transformation_model_paths', ARRAY['*' ]::text[]),
    ('inventory.transformation_recipe_bindings', ARRAY['*' ]::text[]),
    ('inventory.transformation_recipe_component_snapshots', ARRAY['*' ]::text[]),
    ('inventory.transformation_model_reviews', ARRAY['*' ]::text[]),
    ('inventory.location_promise_policy_heads', ARRAY['*' ]::text[]),
    ('inventory.location_promise_policy_versions', ARRAY['*' ]::text[]),
    ('inventory.promise_safety_policy_heads', ARRAY['*' ]::text[]),
    ('inventory.promise_safety_policy_versions', ARRAY['*' ]::text[]),
    ('inventory.channel_exposure_policy_heads', ARRAY['*' ]::text[]),
    ('inventory.channel_exposure_policy_versions', ARRAY['*' ]::text[]),
    ('inventory.publication_source_binding_heads', ARRAY['*' ]::text[]),
    ('inventory.publication_source_binding_versions', ARRAY['*' ]::text[]),
    ('inventory.publication_source_binding_members', ARRAY['*' ]::text[]),
    ('inventory.publication_variant_mapping_heads', ARRAY['*' ]::text[]),
    ('inventory.publication_variant_mapping_versions', ARRAY['*' ]::text[]),
    ('inventory.inventory_publication_targets', ARRAY['*' ]::text[]),
    ('warehouse.warehouses', ARRAY['id','code','warehouse_type','hub_warehouse_id','is_active','is_default','shopify_location_id','inventory_source_type','inventory_source_config','feed_enabled','shipping_config' ]::text[]),
    ('warehouse.warehouse_locations', ARRAY['id','warehouse_id','code','location_type','is_pickable','parent_location_id','movement_policy','is_active' ]::text[]),
    ('warehouse.product_locations', ARRAY['id','product_id','product_variant_id','warehouse_location_id','is_primary','status' ]::text[]),
    ('warehouse.fulfillment_nodes', ARRAY['id','code','node_type','warehouse_id','provider_account_id','provider_location_id','inventory_authority','fulfillment_authority','lifecycle_status' ]::text[]),
    ('warehouse.fulfillment_provider_accounts', ARRAY['id','provider','account_namespace','identity_scheme','external_account_id','lifecycle_status','evidence_hash' ]::text[]),
    ('warehouse.fulfillment_provider_locations', ARRAY['id','provider_account_id','identity_scheme','external_location_id','lifecycle_status','evidence_hash' ]::text[]),
    ('warehouse.fulfillment_node_provider_bindings', ARRAY['id','fulfillment_node_id','warehouse_id','provider_account_id','provider_location_id','capability','lifecycle_status' ]::text[]),
    ('channels.channels', ARRAY['id','type','provider','is_default','allocation_pct','allocation_fixed_qty','sync_enabled','sync_mode','shipping_config' ]::text[]),
    ('channels.channel_connections', ARRAY['id','channel_id','shop_domain','api_version','shopify_location_id','metadata.environment','metadata.siteId','metadata.merchantLocationKey' ]::text[]),
    ('channels.channel_warehouse_assignments', ARRAY['*' ]::text[]),
    ('channels.channel_allocation_rules', ARRAY['*' ]::text[]),
    ('dropship.dropship_store_connections', ARRAY['id','vendor_id','platform','external_account_id','provider_environment','external_account_identity_scheme','shop_domain' ]::text[]),
    ('wms.orders', NULL::text[]),
    ('wms.order_items', NULL::text[]),
    ('wms.outbound_shipments', NULL::text[]),
    ('wms.outbound_shipment_items', NULL::text[]),
    ('wms.physical_shipments', NULL::text[]),
    ('wms.physical_shipment_items', NULL::text[]),
    ('wms.physical_shipment_item_quantity_adjustments', NULL::text[]),
    ('wms.fulfillment_plans', NULL::text[]),
    ('wms.fulfillment_plan_lines', NULL::text[]),
    ('oms.oms_orders', NULL::text[]),
    ('oms.oms_order_lines', NULL::text[]),
    ('oms.oms_order_line_authority_events', NULL::text[]),
    ('oms.order_item_costs', NULL::text[]),
    ('inventory.inventory_levels', NULL::text[]),
    ('inventory.inventory_lots', NULL::text[]),
    ('inventory.inventory_transactions', NULL::text[]),
    ('inventory.build_orders', NULL::text[]),
    ('inventory.build_order_components', NULL::text[]),
    ('inventory.build_order_dependencies', NULL::text[]),
    ('inventory.build_component_reservations', NULL::text[]),
    ('inventory.build_runs', NULL::text[]),
    ('inventory.build_run_consumptions', NULL::text[]),
    ('inventory.build_run_reversals', NULL::text[]),
    ('inventory.availability_claims', NULL::text[]),
    ('inventory.availability_claim_lines', NULL::text[]),
    ('inventory.availability_claim_resources', NULL::text[]),
    ('inventory.availability_claim_lot_allocations', NULL::text[]),
    ('inventory.availability_claim_operations', NULL::text[]),
    ('inventory.availability_claim_operation_inputs', NULL::text[]),
    ('inventory.availability_claim_commands', NULL::text[]),
    ('inventory.availability_claim_events', NULL::text[]),
    ('inventory.availability_claim_build_handoffs', NULL::text[]),
    ('inventory.availability_claim_pick_movements', NULL::text[]),
    ('inventory.availability_claim_dispatch_receipts', NULL::text[]),
    ('inventory.availability_claim_dispatch_movements', NULL::text[]),
    ('inventory.demand_evidence_snapshots', NULL::text[]),
    ('inventory.lot_cost_origins', NULL::text[]),
    ('inventory.lot_cost_contributions', NULL::text[]),
    ('inventory.cost_component_protections', NULL::text[]),
    ('inventory.cost_applications', NULL::text[]),
    ('inventory.cost_application_lots', NULL::text[]),
    ('inventory.cost_reporting_events', NULL::text[]),
    ('channels.channel_reservations', NULL::text[])
  ) AS manifest(table_name,semantic_columns)
  LOOP
    relation := to_regclass(entry.table_name);
    IF relation IS NULL THEN
      RAISE EXCEPTION 'cutover admission prerequisite table missing: %',entry.table_name;
    END IF;
    IF entry.semantic_columns IS NOT NULL THEN
      FOREACH field_path IN ARRAY entry.semantic_columns LOOP
        IF field_path <> '*' AND NOT EXISTS (
          SELECT 1 FROM pg_attribute WHERE attrelid=relation
            AND attname=split_part(field_path,'.',1) AND attnum>0 AND NOT attisdropped
        ) THEN
          RAISE EXCEPTION 'cutover semantic prerequisite column missing: %.%',entry.table_name,field_path;
        END IF;
      END LOOP;
    END IF;
    EXECUTE format('CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission()',relation);
    IF entry.semantic_columns IS NOT NULL THEN
      SELECT string_agg(quote_literal(field),' , ') INTO arguments FROM unnest(entry.semantic_columns) field;
      EXECUTE format('CREATE TRIGGER ab_cutover_configuration_freeze BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION inventory.guard_cutover_configuration_write(%s)',relation,arguments);
      EXECUTE format('CREATE TRIGGER ab_cutover_configuration_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_cutover_configuration_write(%s)',relation,arguments);
    END IF;
  END LOOP;
  FOREACH field_path IN ARRAY ARRAY['inventory.availability_runtime_authority','inventory.availability_activation_freezes'] LOOP
    relation := to_regclass(field_path);
    IF relation IS NULL THEN RAISE EXCEPTION 'cutover control table missing: %',field_path; END IF;
    EXECUTE format('CREATE TRIGGER aa_cutover_control_owner BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_cutover_control_write()',relation);
  END LOOP;
END;
$install$;

COMMENT ON TABLE inventory.cutover_admission_fence IS
  'Versioned transaction admission barrier only. availability_activation_freezes remains the single durable configuration-freeze truth; no provider/HTTP suppression is implied.';
