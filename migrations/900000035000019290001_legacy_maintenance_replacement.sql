-- Retain unknown outcomes; this authorizes fresh maintenance, never a replay
-- or an assertion that an old request was not sent. No provider calls/backfill.
ALTER TABLE inventory.ebay_automatic_publication_recoveries ADD COLUMN legacy_maintenance_source jsonb
  CHECK(legacy_maintenance_source IS NULL OR jsonb_typeof(legacy_maintenance_source)='object');

-- Projection only: mutable inclusion/content flags are not provider identity.
CREATE FUNCTION channels.maintenance_resource_identity(target jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('channelId',target->'channelId','connectionId',target->'connectionId','productId',target->'productId',
    'accountId',target->'accountId','marketplaceId',target->'marketplaceId','groupKey',target->'groupKey',
    'retainedGroupSkus',COALESCE((SELECT jsonb_agg(s ORDER BY s) FROM jsonb_array_elements(COALESCE(target->'retainedGroupSkus','[]')) s),'[]'::jsonb),
    'variants',(SELECT jsonb_agg(jsonb_build_object('variantId',m->'variantId','sku',m->'sku','externalSku',m->'externalSku',
      'offerId',m->'offerId','listingId',m->'listingId') ORDER BY m->>'variantId') FROM jsonb_array_elements(target->'variants') m))
$$;

-- Bounded raw-source reader. It returns up to two possible command windows;
-- ambiguity is retained rather than selecting the most convenient old job.
-- The adapter classifies stages; the insert guard independently checks evidence.
CREATE FUNCTION channels.legacy_maintenance_replacement_sources(attempt_id bigint,current_job_id uuid,current_revision bigint)
RETURNS TABLE(source jsonb) LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'job',jsonb_build_object('id',j.id::text,'operation',j.operation,'identity',COALESCE(j.provider_identity,j.identity)),
    'current',jsonb_build_object('id',c.id::text,'revision',c.claimed_revision::text,'identity',c.provider_identity),
    'attempt',jsonb_build_object('id',a.id::text,'startedAt',a.started_at::text,'scope',a.scope,'affectedScopes',a.affected_scopes),
    'stage',jsonb_build_object('id',s.id::text,'revision',s.revision::text,'event',s.event,'ownerToken',s.owner_token::text,'evidence',s.evidence,'createdAt',s.created_at::text),
    'next',jsonb_build_object('id',n.id::text,'revision',n.revision::text,'event',n.event,'ownerToken',n.owner_token::text,'evidence',n.evidence,'createdAt',n.created_at::text))
  FROM inventory.quantity_publication_attempts a
  JOIN channels.ebay_listing_sync_jobs c ON c.id=current_job_id AND c.state='running'
    AND c.claimed_revision=current_revision AND c.revision=current_revision AND c.owner_token IS NOT NULL AND c.provider_identity IS NOT NULL
    AND c.operation='sync' AND c.connection_id::text=a.scope->>'connectionId' AND c.identity->>'accountId'=a.scope->>'externalScopeId'
  JOIN channels.ebay_listing_sync_jobs j ON j.channel_id=c.channel_id AND j.connection_id=c.connection_id AND j.product_id=c.product_id
    AND j.created_at<=a.started_at AND j.identity->>'accountId'=a.scope->>'externalScopeId'
  CROSS JOIN LATERAL(SELECT e.* FROM channels.ebay_listing_sync_events e WHERE e.job_id=j.id AND e.created_at<=a.started_at ORDER BY e.id DESC LIMIT 1) s
  CROSS JOIN LATERAL(SELECT e.* FROM channels.ebay_listing_sync_events e WHERE e.job_id=j.id AND e.id>s.id ORDER BY e.id LIMIT 1) n
  WHERE a.id=attempt_id AND a.owner_kind='legacy' AND a.state IN ('running','uncertain') AND a.request_journal_contract IS NULL
    AND a.scope->>'providerKey'='ebay' AND n.created_at>=a.started_at
    AND EXISTS(SELECT 1 FROM channels.ebay_listing_sync_events e WHERE e.job_id=c.id AND e.revision=c.claimed_revision
      AND e.owner_token=c.owner_token AND e.event='stage_started' AND e.evidence->>'key'='recover_prior_requests')
  ORDER BY j.id LIMIT 2
$$;

CREATE OR REPLACE FUNCTION inventory.guard_ebay_automatic_publication_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt inventory.quantity_publication_attempts%ROWTYPE; actual jsonb; request_count integer; legacy_proven boolean := false; source_count integer; source jsonb; old_target jsonb; new_target jsonb; expected_skus text[];
BEGIN
  SELECT * INTO attempt FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  PERFORM inventory.assert_ebay_operator_resume_locks(NEW.scope_keys);
  IF NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR attempt.state NOT IN ('running','uncertain') OR attempt.owner_kind NOT IN ('legacy','outbox')
    OR attempt.scope->>'providerKey' IS DISTINCT FROM 'ebay'
    OR attempt.scope->>'providerScopeType' IS DISTINCT FROM 'account'
    OR NOT attempt.affected_scope_keys <@ NEW.scope_keys
    OR to_jsonb(attempt) IS DISTINCT FROM NEW.before_record
    OR NOT EXISTS(SELECT 1 FROM inventory.ebay_publication_reconciliation_watches watch WHERE watch.id=NEW.watch_id
      AND watch.scope_hash=NEW.scope_hash AND watch.state='pending') THEN
    RAISE EXCEPTION 'Automatic replacement requires exact unresolved ownership and durable recurring reconciliation' USING ERRCODE='23514';
  END IF;

  IF NEW.legacy_maintenance_source IS NOT NULL THEN
    SELECT count(*),jsonb_agg(s.source)->0 INTO source_count,source
      FROM channels.legacy_maintenance_replacement_sources(NEW.attempt_id,NEW.sync_job_id,NEW.sync_revision) s;
    old_target := source->'job'->'identity'; new_target := source->'current'->'identity';
    IF source_count IS DISTINCT FROM 1 OR source IS DISTINCT FROM NEW.legacy_maintenance_source
      OR attempt.owner_kind<>'legacy' OR attempt.request_journal_contract IS NOT NULL
      OR source#>>'{job,operation}' IS DISTINCT FROM 'sync'
      OR source#>>'{stage,event}' IS DISTINCT FROM 'stage_started'
      OR source#>>'{next,event}' NOT IN ('recovering','awaiting_evidence','needs_attention')
      OR source#>>'{stage,revision}' IS DISTINCT FROM source#>>'{next,revision}'
      OR source#>>'{stage,ownerToken}' IS NULL
      OR source#>>'{stage,ownerToken}' IS DISTINCT FROM source#>>'{next,ownerToken}'
      OR COALESCE(source#>>'{stage,evidence,preparedIntentHash}','') !~ '^[a-f0-9]{64}$'
      OR source#>>'{next,evidence,code}' IS DISTINCT FROM 'EBAY_LISTING_SYNC_FAILED'
      OR COALESCE(source#>>'{next,evidence,message}','') !~ '^eBay API (GET|PUT) /sell/inventory/v1/(inventory_item|inventory_item_group|offer)(/[^[:space:]?#]+|\?[^[:space:]#]+) failed \([45][0-9]{2}\): '
      OR channels.maintenance_resource_identity(old_target) IS DISTINCT FROM channels.maintenance_resource_identity(new_target)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(old_target->'variants') m WHERE
        COALESCE(m->>'offerId','')='' OR COALESCE(m->>'listingId','')='' OR m->>'externalSku' IS DISTINCT FROM m->>'sku') THEN
      RAISE EXCEPTION 'Legacy replacement requires uniquely attributable failed maintenance and the same verified resources' USING ERRCODE='23514';
    END IF;
    IF old_target->>'groupKey' IS NOT NULL AND source#>>'{stage,evidence,key}'='group:'||(old_target->>'groupKey') THEN
      expected_skus := ARRAY(SELECT m->>'sku' FROM jsonb_array_elements(old_target->'variants') m) || ARRAY['group:'||(old_target->>'groupKey')];
      legacy_proven := attempt.scope->>'externalInventoryItemId'='group:'||(old_target->>'groupKey');
    ELSE
      SELECT ARRAY[m->>'sku'] INTO expected_skus FROM jsonb_array_elements(old_target->'variants') m
        WHERE source#>>'{stage,evidence,key}' IN ('item:'||(m->>'sku'),'offer:'||(m->>'offerId'));
      legacy_proven := cardinality(expected_skus)=1 AND attempt.scope->>'externalInventoryItemId'=expected_skus[1];
    END IF;
    IF legacy_proven IS DISTINCT FROM true OR cardinality(expected_skus)<>jsonb_array_length(attempt.affected_scopes)
      OR ARRAY(SELECT DISTINCT s->>'externalInventoryItemId' FROM jsonb_array_elements(attempt.affected_scopes) s ORDER BY 1)
        IS DISTINCT FROM ARRAY(SELECT unnest(expected_skus) ORDER BY 1)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(attempt.affected_scopes) s WHERE
        s->>'connectionId' IS DISTINCT FROM old_target->>'connectionId' OR s->>'externalScopeId' IS DISTINCT FROM old_target->>'accountId'
        OR s->>'providerKey' IS DISTINCT FROM 'ebay' OR s->>'providerScopeType' IS DISTINCT FROM 'account'
        OR s->>'destinationKind' IS DISTINCT FROM 'channel_connection')
      OR NOT EXISTS(SELECT 1 FROM inventory.ebay_publication_reconciliation_watches w WHERE w.id=NEW.watch_id
        AND w.connection_id=(new_target->>'connectionId')::integer AND w.product_id=(new_target->>'productId')::integer
        AND w.external_scope_id=new_target->>'accountId'
        AND jsonb_array_length(w.scopes)=jsonb_array_length(new_target->'variants')+CASE WHEN new_target->>'groupKey' IS NULL THEN 0 ELSE 1 END
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.scopes) s WHERE
          s->>'connectionId' IS DISTINCT FROM new_target->>'connectionId' OR s->>'externalScopeId' IS DISTINCT FROM new_target->>'accountId'
          OR s->>'productId' IS DISTINCT FROM new_target->>'productId' OR s->>'providerKey' IS DISTINCT FROM 'ebay'
          OR s->>'providerScopeType' IS DISTINCT FROM 'account' OR s->>'destinationKind' IS DISTINCT FROM 'channel_connection'
          OR NOT ((s->>'externalInventoryItemId'='group:'||(new_target->>'groupKey') AND s->>'productVariantId' IS NULL)
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(new_target->'variants') m
              WHERE m->>'sku'=s->>'externalInventoryItemId' AND m->>'variantId'=s->>'productVariantId')))) THEN
      RAISE EXCEPTION 'Legacy replacement must cover every exact old effect and current catalog resource' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT count(*),COALESCE(jsonb_agg(jsonb_build_object('request_record',to_jsonb(q),'result_record',to_jsonb(r)) ORDER BY q.ordinal),'[]'::jsonb)
    INTO request_count,actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS DISTINCT FROM NEW.request_evidence OR EXISTS(
    SELECT 1 FROM (SELECT q.*,row_number() OVER(ORDER BY q.ordinal) AS expected FROM inventory.quantity_provider_requests q WHERE q.attempt_id=NEW.attempt_id) q
    WHERE q.ordinal<>q.expected OR NOT (
      (q.method='POST' AND q.path='/sell/inventory/v1/bulk_update_price_quantity')
      OR (q.method='PUT' AND q.path ~ '^/sell/inventory/v1/(inventory_item|inventory_item_group|offer)/[^/?#[:space:]]+$')))
    OR (request_count=0 AND NOT (legacy_proven OR (attempt.owner_kind='outbox' AND cardinality(attempt.affected_scope_keys)=1 AND EXISTS(
      SELECT 1 FROM inventory.inventory_publication_outbox o WHERE o.id=attempt.outbox_id
        AND o.provider_key_snapshot='ebay' AND o.provider_scope_type_snapshot='account'
        AND o.destination_kind_snapshot=attempt.scope->>'destinationKind'
        AND COALESCE(o.channel_connection_id_snapshot,o.dropship_store_connection_id_snapshot)::text=attempt.scope->>'connectionId'
        AND o.external_scope_id_snapshot=attempt.scope->>'externalScopeId'
        AND o.external_inventory_item_id_snapshot=attempt.scope->>'externalInventoryItemId'
        AND o.product_variant_id::text=attempt.scope->>'productVariantId')))) THEN
    RAISE EXCEPTION 'Automatic replacement must preserve every request and prove supported synchronous intent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
