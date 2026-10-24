-- Catalog owns the physical shipping form. No existing package fact is backfilled
-- or changed; NULL means unspecified and preserves verified channel package data.
ALTER TABLE catalog.product_variants
  ADD COLUMN shipping_package_type varchar(30),
  ADD CONSTRAINT product_variants_shipping_package_type_check
    CHECK (shipping_package_type IS NULL OR shipping_package_type IN ('parcel', 'letter', 'large_envelope'));

-- Extend the existing source-change owner, retaining all currently installed
-- scope/actor fields. Do not install a second invalidation writer.
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
    SELECT DISTINCT unnest(string_to_array(arguments[2], ',') || ARRAY['length_mm','width_mm','height_mm','shipping_package_type']) AS field
  ) fields;
  EXECUTE format('CREATE OR REPLACE TRIGGER listing_intent_invalidation AFTER INSERT OR UPDATE OR DELETE ON catalog.product_variants
    FOR EACH ROW EXECUTE FUNCTION marketplace.capture_listing_intent_change(%L,%L,%L,%L)',
    arguments[1], watched, arguments[3], arguments[4]);
END; $$;
