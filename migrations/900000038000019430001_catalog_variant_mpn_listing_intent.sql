-- The canonical variant MPN now participates in listing content. Extend the
-- existing change-capture owner; do not rewrite data or create another trigger.
DO $$
DECLARE arguments text[]; watched text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'catalog.product_variants'::regclass
      AND attname = 'mpn' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Canonical Catalog variant MPN column is missing';
  END IF;
  SELECT string_to_array(encode(tgargs, 'escape'), '\000') INTO arguments
    FROM pg_trigger WHERE tgrelid = 'catalog.product_variants'::regclass
      AND tgname = 'listing_intent_invalidation'
      AND tgfoid = 'marketplace.capture_listing_intent_change()'::regprocedure;
  IF arguments IS NULL OR arguments[1] <> 'variant' OR cardinality(arguments) <> 5
    OR NULLIF(btrim(arguments[2]), '') IS NULL OR NULLIF(btrim(arguments[3]), '') IS NULL
    OR NOT ARRAY['id', 'product_id'] <@ string_to_array(arguments[3], ',') THEN
    RAISE EXCEPTION 'Expected Catalog listing-intent trigger is missing or incompatible';
  END IF;
  SELECT string_agg(field, ',' ORDER BY field) INTO watched FROM (
    SELECT DISTINCT unnest(string_to_array(arguments[2], ',') || ARRAY['mpn']) AS field
  ) fields;
  EXECUTE format('CREATE OR REPLACE TRIGGER listing_intent_invalidation AFTER INSERT OR UPDATE OR DELETE ON catalog.product_variants
    FOR EACH ROW EXECUTE FUNCTION marketplace.capture_listing_intent_change(%L,%L,%L,%L)',
    arguments[1], watched, arguments[3], arguments[4]);
END; $$;
