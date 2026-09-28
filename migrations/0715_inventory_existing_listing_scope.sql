-- Deployment only extends the audited preparation contract. No target, mapping,
-- listing, quantity, authority, or provider state is changed by this migration.
-- Derived exclusions preserve the existing publisher's skips; callers still
-- cannot supply these reasons through the preparation request.
CREATE OR REPLACE FUNCTION inventory.guard_initial_publication_scope_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected_ids integer[]; expected_excluded_ids integer[];
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),'{}'::integer[]) INTO expected_ids
    FROM unnest(NEW.included_variant_ids) AS item(value);
  SELECT COALESCE(array_agg(DISTINCT value ORDER BY value),'{}'::integer[]) INTO expected_excluded_ids
    FROM unnest(NEW.excluded_variant_ids) AS item(value);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NEW.included_variant_ids IS DISTINCT FROM expected_ids
    OR NEW.excluded_variant_ids IS DISTINCT FROM expected_excluded_ids
    OR NEW.included_variant_ids && NEW.excluded_variant_ids
    OR EXISTS(SELECT 1 FROM unnest(expected_ids) AS item(value) WHERE value<=0)
    OR EXISTS(SELECT 1 FROM unnest(expected_excluded_ids) AS item(value) WHERE value<=0)
    OR NOT EXISTS(SELECT 1 FROM inventory.availability_runtime_authority
      WHERE singleton_key=true AND authority='legacy' AND activation_run_id IS NULL AND revision=NEW.authority_revision)
    OR EXISTS(SELECT 1 FROM inventory.availability_activation_freezes WHERE released_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM inventory.inventory_publication_targets WHERE id=NEW.publication_target_id
      AND revision=NEW.previous_revision AND state='preview' AND publication_authority='echelon' AND membership_mode='whole_product')
    OR EXISTS(SELECT 1 FROM inventory.publication_membership_heads WHERE publication_target_id=NEW.publication_target_id)
    OR EXISTS(SELECT 1 FROM inventory.publication_membership_versions WHERE publication_target_id=NEW.publication_target_id)
    OR NEW.evidence->'review'->'ready' IS DISTINCT FROM 'true'::jsonb
    OR NEW.evidence->'review'->>'reviewHash' IS DISTINCT FROM NEW.review_hash
    OR NEW.evidence->'review'->'includedVariantIds' IS DISTINCT FROM to_jsonb(expected_ids)
    OR NEW.excluded_variant_ids IS DISTINCT FROM ARRAY(
      SELECT (value->>'productVariantId')::integer
      FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb))
      ORDER BY (value->>'productVariantId')::integer)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb))
      WHERE value->>'reason' IS NULL OR value->>'reason' NOT IN
        ('unsupported_bundle','legacy_inactive_catalog','legacy_quarantined','legacy_missing_inventory_identity'))
    OR COALESCE(NEW.receipt->'excludedVariants','[]'::jsonb)
      IS DISTINCT FROM COALESCE(NEW.evidence->'review'->'excludedVariants','[]'::jsonb)
    OR NEW.receipt->>'publicationTargetId' IS DISTINCT FROM NEW.publication_target_id::text
    OR NEW.receipt->>'previousRevision' IS DISTINCT FROM NEW.previous_revision::text
    OR NEW.receipt->>'revision' IS DISTINCT FROM (NEW.previous_revision+1)::text
    OR NEW.receipt->>'reviewHash' IS DISTINCT FROM NEW.review_hash
    OR NEW.receipt->>'preparedBy' IS DISTINCT FROM NEW.actor
    OR (NEW.receipt->>'preparedAt')::timestamptz IS DISTINCT FROM NEW.occurred_at
    OR NEW.receipt->'includedVariantIds' IS DISTINCT FROM to_jsonb(expected_ids)
    OR NEW.receipt->'alreadyApplied' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'runtimeAuthorityChanged' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'providerWriteAttempted' IS DISTINCT FROM 'false'::jsonb
    OR NEW.receipt->'outboxEnqueued' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'INITIAL_SCOPE_RECEIPT_INVALID' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- Missing snapshot writes must roll back the whole preparation, even if a
-- trigger silently omits an INSERT. Existing sealed mappings are never changed.
CREATE FUNCTION inventory.assert_initial_scope_mapping_imports() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE expected_ids integer[];
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT COALESCE(array_agg((item->>'productVariantId')::integer ORDER BY (item->>'productVariantId')::integer),'{}'::integer[])
    INTO expected_ids FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'mappingImports','[]'::jsonb)) item;
  IF COALESCE(NEW.receipt->'importedVariantIds','[]'::jsonb) IS DISTINCT FROM to_jsonb(expected_ids)
    OR NOT expected_ids <@ NEW.included_variant_ids
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.evidence->'review'->'mappingImports','[]'::jsonb)) item
      LEFT JOIN inventory.publication_variant_mapping_heads head
        ON head.publication_target_id=NEW.publication_target_id AND head.product_variant_id=(item->>'productVariantId')::integer
      LEFT JOIN inventory.publication_variant_mapping_versions mapping ON mapping.id=head.draft_mapping_id
      WHERE mapping.id IS NULL OR mapping.version<>1 OR mapping.lifecycle_status<>'draft'
        OR head.active_mapping_id IS NOT NULL OR head.revision<>1
        OR mapping.external_inventory_item_id IS DISTINCT FROM item->>'externalInventoryItemId'
        OR mapping.external_sku IS DISTINCT FROM item->>'externalSku'
        OR mapping.request_hash IS DISTINCT FROM NEW.request_hash
        OR mapping.idempotency_key IS DISTINCT FROM 'initial-scope-map:'||NEW.request_hash||':'||(item->>'productVariantId')
        OR mapping.created_by IS DISTINCT FROM NEW.actor OR mapping.created_at IS DISTINCT FROM NEW.occurred_at
    ) THEN
    RAISE EXCEPTION 'INITIAL_SCOPE_MAPPING_IMPORT_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER initial_scope_mapping_imports_complete
AFTER INSERT ON inventory.publication_initial_scope_receipts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION inventory.assert_initial_scope_mapping_imports();
