-- Extend the reviewed recreation handoff to catalog-matched offers. A catalog
-- match changes the submission method, never the seller SKU or selling unit.
-- Preserve the original rejection/recreation, lease, freshness and audit guards.
CREATE OR REPLACE FUNCTION marketplace.guard_channel_listing_claim_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.account_key,NEW.external_sku,NEW.channel_id,NEW.product_variant_id,NEW.created_at)
    IS DISTINCT FROM (OLD.account_key,OLD.external_sku,OLD.channel_id,OLD.product_variant_id,OLD.created_at)
    OR NEW.operation_id=OLD.operation_id THEN
    RAISE EXCEPTION 'Listing claim identity is immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM marketplace.channel_listing_operations o,
      jsonb_array_elements(o.progress->'items') i,
      jsonb_array_elements(o.progress->'batches') b
    WHERE o.id=OLD.operation_id AND i->>'variantId'=OLD.product_variant_id::text
      AND i->>'sku'=OLD.external_sku AND i->>'state'='needs_attention' AND i->>'canRetry'='true'
      AND b->>'state'='processed' AND b->'variantIds' @> to_jsonb(ARRAY[OLD.product_variant_id])
  ) AND NOT EXISTS (
    SELECT 1 FROM marketplace.channel_listing_operations old_op
    JOIN marketplace.channel_listing_operations next_op ON next_op.id=NEW.operation_id,
      jsonb_array_elements(old_op.progress->'items') i,
      jsonb_array_elements(old_op.progress->'batches') b,
      jsonb_array_elements(old_op.snapshot->'draft'->'items') old_d,
      jsonb_array_elements(old_op.snapshot->'catalog') old_c,
      jsonb_array_elements(next_op.snapshot->'recreations') r,
      jsonb_array_elements(next_op.snapshot->'draft'->'items') d,
      jsonb_array_elements(next_op.snapshot->'catalog') c,
      jsonb_array_elements(next_op.snapshot->'prepared') p
    WHERE old_op.id=OLD.operation_id AND old_op.channel_id=NEW.channel_id
      AND next_op.channel_id=NEW.channel_id AND next_op.account_key=NEW.account_key
      AND old_op.account_key=NEW.account_key AND next_op.snapshot->'account'->>'provider'='walmart'
      AND next_op.snapshot->'review'->>'canSubmit'='true'
      AND next_op.state='queued' AND old_op.lease_token IS NULL
      AND i->>'variantId'=NEW.product_variant_id::text AND i->>'sku'=NEW.external_sku
      AND i->>'state'='superseded' AND i->>'recreatedByOperationId'=NEW.operation_id::text
      AND b->>'state'='processed' AND b->'variantIds' @> to_jsonb(ARRAY[NEW.product_variant_id])
      AND r->>'operationId'=OLD.operation_id::text AND r->>'sku'=NEW.external_sku
      AND r->>'variantId'=NEW.product_variant_id::text
      AND (i->'externalProductId'='null'::jsonb OR r->'previousExternalProductId' IS NOT DISTINCT FROM i->'externalProductId')
      AND r->>'sourceHash' ~ '^[a-f0-9]{64}$'
      AND (r->>'checkedAt')::timestamptz <= next_op.created_at
      AND (r->>'checkedAt')::timestamptz >= next_op.created_at - interval '15 minutes'
      AND d->>'variantId'=NEW.product_variant_id::text AND d->>'method' IN ('create','match')
      AND d->>'recreateFromOperationId'=OLD.operation_id::text
      AND p->>'variantId'=NEW.product_variant_id::text AND p->>'sku'=NEW.external_sku
      AND p->>'feedType'=CASE d->>'method' WHEN 'match' THEN 'MP_ITEM_MATCH' ELSE 'MP_ITEM' END
      AND old_d->>'variantId'=NEW.product_variant_id::text
      AND old_c->>'variantId'=NEW.product_variant_id::text AND old_c->>'sku'=NEW.external_sku
      AND c->>'variantId'=NEW.product_variant_id::text AND c->>'sku'=NEW.external_sku
      AND jsonb_typeof(COALESCE(NULLIF(old_d->'identifier','null'::jsonb),old_c->'identifier'))='object'
      AND COALESCE(NULLIF(d->'identifier','null'::jsonb),c->'identifier')
        = COALESCE(NULLIF(old_d->'identifier','null'::jsonb),old_c->'identifier')
  ) THEN
    RAISE EXCEPTION 'Only a rejected claim or an explicitly reviewed missing listing may transfer';
  END IF;
  RETURN NEW;
END;
$$;
