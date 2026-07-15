-- Shared shipping rate tables have not entered production use. Reset the
-- unused drafts and replace internal zone keys with the geography operators
-- actually price: country, state/territory, and optional ZIP prefix.
--
-- This intentionally does not touch dropship.* legacy rate tables or
-- shipping.rate_books / shipping.rate_book_assignments.

TRUNCATE TABLE shipping.rate_table_rows, shipping.rate_tables RESTART IDENTITY;

DROP INDEX IF EXISTS shipping.shipping_rate_row_band_idx;

ALTER TABLE shipping.rate_table_rows
  DROP COLUMN destination_zone,
  ADD COLUMN destination_country varchar(2) NOT NULL DEFAULT 'US',
  ADD COLUMN destination_region varchar(2) NOT NULL,
  ADD COLUMN postal_prefix varchar(5);

ALTER TABLE shipping.rate_table_rows
  DROP CONSTRAINT IF EXISTS rate_table_rows_origin_warehouse_id_fkey;

ALTER TABLE shipping.rate_table_rows
  ADD CONSTRAINT shipping_rate_row_origin_warehouse_fk
  FOREIGN KEY (origin_warehouse_id)
  REFERENCES warehouse.warehouses(id)
  ON DELETE RESTRICT;

ALTER TABLE shipping.rate_table_rows
  ADD CONSTRAINT shipping_rate_row_country_chk
    CHECK (destination_country ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT shipping_rate_row_region_chk
    CHECK (destination_region ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT shipping_rate_row_postal_prefix_chk
    CHECK (postal_prefix IS NULL OR postal_prefix ~ '^[0-9]{1,5}$');

CREATE UNIQUE INDEX shipping_rate_row_band_idx
  ON shipping.rate_table_rows (
    rate_table_id,
    COALESCE(origin_warehouse_id, 0),
    destination_country,
    destination_region,
    COALESCE(postal_prefix, ''),
    min_weight_grams,
    max_weight_grams
  );

CREATE INDEX shipping_rate_row_lookup_idx
  ON shipping.rate_table_rows (
    rate_table_id,
    destination_country,
    destination_region,
    postal_prefix,
    origin_warehouse_id
  );
