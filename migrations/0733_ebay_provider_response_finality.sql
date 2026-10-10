-- Retain request finality separately from delivery success. Historical rows remain
-- NULL; installing this migration resolves no attempt and sends no provider call.
ALTER TABLE inventory.quantity_provider_request_results ADD COLUMN IF NOT EXISTS request_terminated boolean;
ALTER TABLE inventory.quantity_provider_request_results DROP CONSTRAINT IF EXISTS quantity_provider_finality_requires_response;
ALTER TABLE inventory.quantity_provider_request_results ADD CONSTRAINT quantity_provider_finality_requires_response
  CHECK(request_terminated IS DISTINCT FROM true OR (http_status IS NOT NULL AND response_hash IS NOT NULL
    AND (http_status IN (200,201,204,207) OR (http_status BETWEEN 400 AND 599 AND http_status<>408))));
COMMENT ON COLUMN inventory.quantity_provider_request_results.request_terminated IS
  'Validated synchronous provider response has terminated; does not prove successful quantity application. NULL means no finality evidence was retained.';
DO $migration$
BEGIN
  IF to_regprocedure('inventory.guard_publication_response_recovery()') IS NOT NULL THEN
    EXECUTE $definition$
CREATE OR REPLACE FUNCTION inventory.guard_publication_response_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual jsonb;owned_keys text[];scope_key text;lock_key bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND classid=918419 AND objid=0 AND objsubid=2 AND mode='ShareLock' AND granted)
    OR NEW.owner_transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM inventory.quantity_publication_attempts a WHERE a.id=NEW.attempt_id
      AND a.owner_kind IN ('legacy','outbox') AND a.state IN ('running','uncertain') AND a.scope->>'providerKey'='ebay'
      AND to_jsonb(a)=NEW.before_record) THEN
    RAISE EXCEPTION 'Response recovery requires exclusive exact unresolved ownership' USING ERRCODE='23514';
  END IF;
  SELECT affected_scope_keys INTO owned_keys FROM inventory.quantity_publication_attempts WHERE id=NEW.attempt_id;
  IF cardinality(owned_keys)<1 THEN RAISE EXCEPTION 'Response recovery requires every exact owned scope' USING ERRCODE='23514';END IF;
  FOREACH scope_key IN ARRAY owned_keys LOOP
    -- The identical 64-bit advisory key used by existing inventory admission.
    lock_key:=hashtextextended(scope_key,918420);
    IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
      AND classid=((lock_key>>32)&4294967295)::oid AND objid=(lock_key&4294967295)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) THEN
      RAISE EXCEPTION 'Response recovery requires exclusive exact-scope ownership' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('requestId',q.id::text,'ordinal',q.ordinal,'method',q.method,'path',q.path,
    'requestHash',q.request_hash,'outcome',r.outcome,'httpStatus',r.http_status,'responseHash',r.response_hash,
    'requestTerminated',r.request_terminated,'errorCodes',COALESCE(r.error_codes,'{}'::text[]),'recordedAt',
    CASE WHEN r.recorded_at IS NULL THEN NULL ELSE to_char(r.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) ORDER BY q.ordinal)
    INTO actual FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
    WHERE q.attempt_id=NEW.attempt_id;
  IF actual IS NULL OR actual IS DISTINCT FROM NEW.request_receipts THEN
    RAISE EXCEPTION 'Response recovery must retain every immutable request receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
$definition$;
  END IF;
END $migration$;
