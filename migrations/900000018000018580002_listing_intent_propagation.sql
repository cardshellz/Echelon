-- Listing intent facts and delivery obligations. These tables never hold
-- provider payloads or execute stock/provider mutations.
CREATE TABLE marketplace.listing_intent_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_relation text NOT NULL,
  source_kind text NOT NULL,
  changed_fields text[] NOT NULL CHECK(cardinality(changed_fields)>0),
  operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  before_scope jsonb,
  after_scope jsonb,
  before_hash text,
  after_hash text,
  actor_provenance jsonb NOT NULL,
  source_transaction xid8 NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  cursor_key text NOT NULL DEFAULT '',
  expanded_at timestamptz,
  CHECK(before_scope IS NOT NULL OR after_scope IS NOT NULL),
  CHECK(before_hash IS NULL OR before_hash ~ '^[a-f0-9]{64}$'),
  CHECK(after_hash IS NULL OR after_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX listing_intent_changes_pending ON marketplace.listing_intent_changes(id) WHERE expanded_at IS NULL;
CREATE INDEX listing_intent_changes_pending_transaction ON marketplace.listing_intent_changes(source_transaction) WHERE expanded_at IS NULL;
CREATE TABLE marketplace.listing_intent_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_id bigint NOT NULL REFERENCES marketplace.listing_intent_changes(id),
  source_transaction xid8 NOT NULL,
  destination_key text NOT NULL,
  destination jsonb NOT NULL,
  product_id integer NOT NULL CHECK(product_id>0),
  variant_ids jsonb NOT NULL CHECK(jsonb_typeof(variant_ids)='array'),
  command_key uuid NOT NULL UNIQUE,
  retry_generation integer NOT NULL DEFAULT 0 CHECK(retry_generation>=0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','needs_review','blocked')),
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  receipt jsonb,
  last_error_code text,
  last_error_message text,
  last_error_resolution text,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE(source_transaction,destination_key,product_id),
  CHECK((lease_token IS NULL)=(lease_until IS NULL)),
  CHECK((state='delivered')=(receipt IS NOT NULL))
);
CREATE INDEX listing_intent_deliveries_pending ON marketplace.listing_intent_deliveries(next_attempt_at,id) WHERE state='pending';
CREATE TABLE marketplace.listing_intent_delivery_sources (
  delivery_id bigint NOT NULL REFERENCES marketplace.listing_intent_deliveries(id),
  change_id bigint NOT NULL REFERENCES marketplace.listing_intent_changes(id),
  PRIMARY KEY(delivery_id,change_id)
);
CREATE TABLE marketplace.listing_intent_delivery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  delivery_id bigint NOT NULL REFERENCES marketplace.listing_intent_deliveries(id),
  actor text NOT NULL,
  action text NOT NULL,
  before_state jsonb,
  after_state jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE FUNCTION marketplace.guard_listing_intent_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LISTING_INTENT_EVIDENCE_IMMUTABLE';
END; $$;
CREATE TRIGGER listing_intent_delivery_sources_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON marketplace.listing_intent_delivery_sources
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.guard_listing_intent_evidence();
CREATE TRIGGER listing_intent_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON marketplace.listing_intent_delivery_events
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.guard_listing_intent_evidence();
CREATE FUNCTION marketplace.guard_listing_intent_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR (NEW.id,NEW.source_relation,NEW.source_kind,NEW.changed_fields,NEW.operation,NEW.before_scope,NEW.after_scope,
    NEW.before_hash,NEW.after_hash,NEW.actor_provenance,NEW.source_transaction,NEW.occurred_at)
    IS DISTINCT FROM (OLD.id,OLD.source_relation,OLD.source_kind,OLD.changed_fields,OLD.operation,OLD.before_scope,OLD.after_scope,
    OLD.before_hash,OLD.after_hash,OLD.actor_provenance,OLD.source_transaction,OLD.occurred_at)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LISTING_INTENT_SOURCE_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER listing_intent_changes_immutable BEFORE UPDATE OR DELETE ON marketplace.listing_intent_changes
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_intent_change();
CREATE TRIGGER listing_intent_changes_no_truncate BEFORE TRUNCATE ON marketplace.listing_intent_changes
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.guard_listing_intent_evidence();
CREATE FUNCTION marketplace.guard_listing_intent_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'UPDATE' OR (NEW.id,NEW.change_id,NEW.source_transaction,NEW.destination_key,NEW.destination,NEW.product_id,NEW.variant_ids,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.change_id,OLD.source_transaction,OLD.destination_key,OLD.destination,OLD.product_id,OLD.variant_ids,OLD.created_at)
    OR ((NEW.command_key,NEW.retry_generation) IS DISTINCT FROM (OLD.command_key,OLD.retry_generation)
      AND NOT (OLD.receipt IS NULL AND OLD.state='blocked' AND NEW.state='pending'
        AND NEW.retry_generation=OLD.retry_generation+1 AND NEW.command_key<>OLD.command_key))
    OR (OLD.receipt IS NOT NULL AND (NEW.receipt,NEW.state) IS DISTINCT FROM (OLD.receipt,OLD.state))
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LISTING_INTENT_DELIVERY_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER listing_intent_deliveries_immutable BEFORE UPDATE OR DELETE ON marketplace.listing_intent_deliveries
  FOR EACH ROW EXECUTE FUNCTION marketplace.guard_listing_intent_delivery();
CREATE TRIGGER listing_intent_deliveries_no_truncate BEFORE TRUNCATE ON marketplace.listing_intent_deliveries
  FOR EACH STATEMENT EXECUTE FUNCTION marketplace.guard_listing_intent_evidence();

-- A typed row projection avoids converting file_data to JSON/base64. Bytes are
-- compared by their digest only; credentials are never selected by the manifest.
CREATE FUNCTION marketplace.listing_intent_row_projection(source_row anyelement, columns text[])
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expression text; answer jsonb;
BEGIN
  SELECT string_agg(format('%L,%s',field,
    CASE WHEN field='file_data' THEN format('encode(sha256(($1).%I),''hex'')',field)
      WHEN field='external_account_verified_at' THEN format('(($1).%I IS NOT NULL)',field)
      WHEN field='metadata' THEN '(SELECT jsonb_object_agg(key,value) FROM jsonb_each(COALESCE(($1).metadata,''{}''::jsonb))
        WHERE key IN (''fulfillmentPolicyId'',''returnPolicyId'',''paymentPolicyId'',''marketplaceId'',''merchantLocationKey'',''environment'',''market''))'
      ELSE format('($1).%I',field) END),',') INTO expression FROM unnest(columns) field;
  EXECUTE 'SELECT jsonb_build_object('||expression||')' INTO answer USING source_row;
  RETURN answer;
END; $$;
CREATE FUNCTION marketplace.capture_listing_intent_change() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE prior jsonb; current_row jsonb; before_scope jsonb; after_scope jsonb; fields text[];
  actor_field text; actor_value text; provenance jsonb; actor_row jsonb;
BEGIN
  fields:=string_to_array(TG_ARGV[1],',');
  IF TG_OP<>'INSERT' THEN prior:=marketplace.listing_intent_row_projection(OLD,fields); END IF;
  IF TG_OP<>'DELETE' THEN current_row:=marketplace.listing_intent_row_projection(NEW,fields); END IF;
  IF prior IS NOT DISTINCT FROM current_row THEN RETURN NULL; END IF;
  -- Scope is a retained source fact, including OLD scope on deletes/moves.
  SELECT jsonb_object_agg(key,value) INTO before_scope FROM jsonb_each(prior)
    WHERE key=ANY(string_to_array(TG_ARGV[2],','));
  SELECT jsonb_object_agg(key,value) INTO after_scope FROM jsonb_each(current_row)
    WHERE key=ANY(string_to_array(TG_ARGV[2],','));
  -- Actor-only updates do not invalidate content. Capture available attribution
  -- separately after the desired-value comparison, without reading credentials.
  IF COALESCE(TG_ARGV[3],'')<>'' THEN
    IF TG_OP='DELETE' THEN actor_row:=marketplace.listing_intent_row_projection(OLD,string_to_array(TG_ARGV[3],','));
    ELSE actor_row:=marketplace.listing_intent_row_projection(NEW,string_to_array(TG_ARGV[3],',')); END IF;
  END IF;
  actor_field:=CASE WHEN actor_row?'updated_by' THEN 'updated_by'
    WHEN actor_row?'actor_id' THEN 'actor_id' WHEN actor_row?'created_by' THEN 'created_by' ELSE NULL END;
  actor_value:=actor_row->>actor_field;
  provenance:=jsonb_build_object('databasePrincipal',session_user,'humanActorKnown',false,
    'sourceActorField',actor_field,'sourceActorValue',actor_value,
    'sourceRevisionId',COALESCE(current_row,prior)->'revision_id');
  INSERT INTO marketplace.listing_intent_changes(source_relation,source_kind,changed_fields,operation,before_scope,after_scope,
    before_hash,after_hash,actor_provenance,source_transaction)
    VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,TG_ARGV[0],
      ARRAY(SELECT key FROM jsonb_object_keys(COALESCE(prior,'{}')||COALESCE(current_row,'{}')) key
        WHERE prior->key IS DISTINCT FROM current_row->key ORDER BY key),TG_OP,before_scope,after_scope,
      CASE WHEN prior IS NOT NULL THEN encode(sha256(convert_to(prior::text,'UTF8')),'hex') END,
      CASE WHEN current_row IS NOT NULL THEN encode(sha256(convert_to(current_row::text,'UTF8')),'hex') END,
      provenance,pg_current_xact_id());
  RETURN NULL;
END; $$;
DO $$
DECLARE entry record; relation regclass; field text; actual_fields text[]; scope_fields text[]; actor_fields text[]; required_scope text[];
BEGIN
  FOR entry IN SELECT * FROM (VALUES
    ('catalog.products','product','id,product_type,category,category_id','name,title,description,brand,product_type,category,category_id,price_cents,is_active,status,ebay_browse_category_id,ebay_browse_category_name,ebay_fulfillment_policy_override,ebay_return_policy_override,ebay_payment_policy_override,ebay_listing_excluded'),
    ('catalog.product_variants','variant','id,product_id,sku','name,sku,barcode,gtin,shopify_variant_id,currency,option1_name,option1_value,option2_name,option2_value,option3_name,option3_value,price_cents,compare_at_price_cents,weight_grams,position,is_active,ebay_fulfillment_policy_override,ebay_return_policy_override,ebay_payment_policy_override,ebay_listing_excluded'),
    ('catalog.product_assets','asset','id,product_id,product_variant_id','asset_type,url,alt_text,position,is_primary,storage_type,mime_type,file_data'),
    ('public.shopify_variants','retail_cache','id,sku','price'),
    ('channels.channel_product_overrides','product','id,channel_id,product_id','title_override,description_override,bullet_points_override,category_override,tags_override,item_specifics,marketplace_category_id,listing_format,condition_id,is_listed'),
    ('channels.channel_variant_overrides','variant','id,channel_id,product_variant_id','name_override,sku_override,barcode_override,weight_override,is_listed'),
    ('channels.channel_pricing','variant','id,channel_id,product_variant_id','price,compare_at_price,cost,currency'),
    ('channels.channel_asset_overrides','asset_override','id,channel_id,product_asset_id','url_override,alt_text_override,position_override,is_included'),
    ('channels.channel_pricing_rules','price_rule','id,channel_id,scope,scope_id','rule_type,value'),
    ('channels.channel_connections','connection','id,channel_id','metadata'),
    ('channels.walmart_connections','connection','channel_id,connection_id','partner_id,environment,ship_node_id,warehouse_id,revision'),
    ('ebay.ebay_oauth_tokens','connection','channel_id,environment','external_account_id,external_account_identity_scheme,external_account_verified_at'),
    ('dropship.dropship_store_connections','store','id,vendor_id','platform,external_account_id,provider_environment,external_account_identity_scheme,external_account_verified_at,status'),
    ('ebay.ebay_category_mappings','product_type','id,channel_id,product_type_slug','ebay_browse_category_id,ebay_browse_category_name,ebay_store_category_id,ebay_store_category_name,fulfillment_policy_override,return_policy_override,payment_policy_override,listing_enabled'),
    ('ebay.ebay_type_aspect_defaults','product_type','id,product_type_slug','aspect_name,aspect_value'),
    ('ebay.ebay_product_aspect_overrides','product','id,product_id','aspect_name,aspect_value'),
    ('dropship.dropship_product_listing_settings','product','store_connection_id,vendor_id,product_id','revision_id'),
    ('dropship.dropship_category_listing_settings','category','store_connection_id,vendor_id,category_id','revision_id'),
    ('dropship.dropship_listing_price_settings','variant','store_connection_id,vendor_id,product_variant_id','revision_id,override_price_cents,pricing_mode'),
    ('dropship.dropship_listing_content_settings','variant','store_connection_id,vendor_id,product_variant_id','revision_id'),
    ('dropship.dropship_pricing_profiles','store','store_connection_id,vendor_id','revision_id'),
    ('dropship.dropship_content_profiles','store','store_connection_id,vendor_id','revision_id'),
    ('dropship.dropship_ebay_category_rule_profiles','store','store_connection_id,vendor_id','revision_id'),
    ('dropship.dropship_store_listing_configs','store','id,store_connection_id','revision,listing_mode,price_mode,marketplace_config,required_config_keys,required_product_fields,is_active')
  ) manifest(table_name,kind,scope_columns,desired_columns) LOOP
    relation:=to_regclass(entry.table_name);
    IF relation IS NULL THEN RAISE EXCEPTION 'listing intent prerequisite table missing: %',entry.table_name; END IF;
    -- Some additive Catalog fields differ across supported installations. Scope
    -- columns and every present desired field are captured; require a value field.
    SELECT array_agg(DISTINCT c ORDER BY c) INTO actual_fields
      FROM unnest(string_to_array(entry.scope_columns||','||entry.desired_columns,',')) c
      WHERE EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=relation AND attname=c AND attnum>0 AND NOT attisdropped);
    SELECT array_agg(c ORDER BY c) INTO scope_fields FROM unnest(string_to_array(entry.scope_columns,',')) c
      WHERE c=ANY(actual_fields);
    required_scope:=CASE
      WHEN entry.table_name='catalog.products' THEN ARRAY['id']
      WHEN entry.table_name='catalog.product_variants' THEN ARRAY['id','product_id']
      WHEN entry.kind='product' THEN ARRAY['product_id']
      WHEN entry.kind='variant' THEN ARRAY['product_variant_id']
      WHEN entry.kind='asset' THEN ARRAY['product_id']
      WHEN entry.kind='asset_override' THEN ARRAY['channel_id','product_asset_id']
      WHEN entry.kind='product_type' THEN ARRAY['product_type_slug']
      WHEN entry.kind='category' THEN ARRAY['category_id','store_connection_id','vendor_id']
      WHEN entry.kind='retail_cache' THEN ARRAY['id','sku']
      WHEN entry.kind='price_rule' THEN ARRAY['channel_id','scope','scope_id']
      WHEN entry.kind='connection' THEN ARRAY['channel_id']
      WHEN entry.table_name='dropship.dropship_store_connections' THEN ARRAY['id','vendor_id']
      WHEN entry.kind='store' THEN ARRAY['store_connection_id'] END;
    IF NOT required_scope <@ scope_fields THEN
      RAISE EXCEPTION 'listing intent required source scope missing: %',entry.table_name;
    END IF;
    IF cardinality(scope_fields)=0 OR NOT EXISTS(SELECT 1 FROM unnest(string_to_array(entry.desired_columns,',')) c WHERE c=ANY(actual_fields))
      THEN RAISE EXCEPTION 'listing intent prerequisite columns missing: %',entry.table_name; END IF;
    SELECT array_agg(attname ORDER BY attname) INTO actor_fields FROM pg_attribute
      WHERE attrelid=relation AND attnum>0 AND NOT attisdropped AND attname IN ('updated_by','actor_id','created_by');
    EXECUTE format('CREATE TRIGGER listing_intent_invalidation AFTER INSERT OR UPDATE OR DELETE ON %s
      FOR EACH ROW EXECUTE FUNCTION marketplace.capture_listing_intent_change(%L,%L,%L,%L)',
      relation,entry.kind,array_to_string(actual_fields,','),array_to_string(scope_fields,','),COALESCE(array_to_string(actor_fields,','),''));
  END LOOP;
END; $$;


-- Existing Dropship admission keeps its original account/scope as a receipt.
-- Worker status/result updates remain allowed; admitted source evidence cannot
-- be redirected after a lost acknowledgement.
CREATE FUNCTION dropship.guard_managed_listing_intent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.requested_scope ? 'managedIntentScope' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='DROPSHIP_MANAGED_INTENT_RECEIPT_IMMUTABLE'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.requested_scope ? 'managedIntentScope' AND
    (NEW.vendor_id,NEW.store_connection_id,NEW.idempotency_key,NEW.request_hash,NEW.requested_scope)
      IS DISTINCT FROM (OLD.vendor_id,OLD.store_connection_id,OLD.idempotency_key,OLD.request_hash,OLD.requested_scope)
  THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='DROPSHIP_MANAGED_INTENT_RECEIPT_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dropship_managed_intent_receipt_immutable BEFORE UPDATE OR DELETE ON dropship.dropship_listing_push_jobs
  FOR EACH ROW EXECUTE FUNCTION dropship.guard_managed_listing_intent_receipt();
