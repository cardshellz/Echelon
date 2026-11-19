-- Retain historical values for audit and rollback. Catalog no longer exposes,
-- writes or publishes this field; provider package settings remain untouched.
COMMENT ON COLUMN catalog.product_variants.shipping_package_type IS
  'Retired catalog field: retained for history/rollback only; not used by current listing publication.';

-- Remove only the retired field from the existing invalidation owner. Preserve
-- measurement propagation, actor arguments and every other watched field.
DO $$
DECLARE arguments text[]; watched text;
BEGIN
  SELECT string_to_array(encode(tgargs, 'escape'), '\000') INTO arguments
    FROM pg_trigger WHERE tgrelid = 'catalog.product_variants'::regclass
      AND tgname = 'listing_intent_invalidation'
      AND tgfoid = 'marketplace.capture_listing_intent_change()'::regprocedure;
  IF arguments IS NULL OR arguments[1] <> 'variant' OR cardinality(arguments) <> 5 THEN
    RAISE EXCEPTION 'Expected Catalog listing-intent trigger is missing or incompatible';
  END IF;
  SELECT string_agg(field, ',' ORDER BY field) INTO watched FROM (
    SELECT DISTINCT unnest(string_to_array(arguments[2], ',')) AS field
  ) fields WHERE field <> 'shipping_package_type';
  IF watched IS NULL OR watched = '' THEN
    RAISE EXCEPTION 'Catalog listing-intent watched fields cannot be empty';
  END IF;
  EXECUTE format('CREATE OR REPLACE TRIGGER listing_intent_invalidation AFTER INSERT OR UPDATE OR DELETE ON catalog.product_variants
    FOR EACH ROW EXECUTE FUNCTION marketplace.capture_listing_intent_change(%L,%L,%L,%L)',
    arguments[1], watched, arguments[3], arguments[4]);
END; $$;
