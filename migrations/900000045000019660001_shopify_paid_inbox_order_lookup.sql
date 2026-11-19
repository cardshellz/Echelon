-- Find one original paid receipt without scanning and detoasting every Shopify
-- paid payload. Both Control Tower and the scheduled recovery use this owner.
-- The release runner wraps migrations in a transaction; CONCURRENTLY is invalid.
-- Ordinary index creation allows reads and blocks inbox writes until commit.
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_shopify_paid_order
  ON oms.webhook_inbox (
    (COALESCE(payload->>'id', payload->>'order_id')), source_domain
  )
  WHERE provider = 'shopify' AND topic = 'orders/paid' AND status = 'succeeded';

-- Refuse a pre-existing, invalid or incompatible same-name index.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index definition
    JOIN pg_class index_relation ON index_relation.oid = definition.indexrelid
    JOIN pg_am method ON method.oid = index_relation.relam
    WHERE definition.indexrelid = to_regclass('oms.idx_webhook_inbox_shopify_paid_order')
      AND definition.indrelid = to_regclass('oms.webhook_inbox')
      AND definition.indisvalid AND definition.indisready AND NOT definition.indisunique
      AND definition.indnkeyatts = 2 AND definition.indnatts = 2
      AND method.amname = 'btree'
      AND regexp_replace(pg_get_indexdef(definition.indexrelid, 1, true),
        '[[:space:]()]|::text', '', 'g') = 'COALESCEpayload->>''id'',payload->>''order_id'''
      AND pg_get_indexdef(definition.indexrelid, 2, true) = 'source_domain'
      AND regexp_replace(pg_get_expr(definition.indpred, definition.indrelid),
        '[[:space:]()]|::text', '', 'g') =
        'provider=''shopify''ANDtopic=''orders/paid''ANDstatus=''succeeded'''
  ) THEN
    RAISE EXCEPTION 'Shopify paid inbox order lookup index has an incompatible definition'
      USING ERRCODE = '55000';
  END IF;
END;
$guard$;
