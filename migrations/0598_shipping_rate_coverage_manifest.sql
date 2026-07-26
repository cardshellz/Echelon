-- First-class destination groups and frozen destination/service coverage.
--
-- Existing quote selection remains on shipping.rate_table_rows. These tables
-- preserve operator intent and names without changing live prices. Existing
-- revisions are read through compatibility derivation and acquire manifests
-- when cloned or saved through the admin editor.

CREATE TABLE shipping.rate_book_destination_groups (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_book_id INTEGER NOT NULL
    REFERENCES shipping.rate_books(id) ON DELETE CASCADE,
  source_destination_scope_id INTEGER
    REFERENCES shipping.destination_scopes(id) ON DELETE RESTRICT,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  lock_version INTEGER NOT NULL DEFAULT 1,
  created_by VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_book_destination_group_name_chk
    CHECK (name = btrim(name) AND name <> ''),
  CONSTRAINT shipping_rate_book_destination_group_status_chk
    CHECK (status IN ('active', 'retired')),
  CONSTRAINT shipping_rate_book_destination_group_sort_chk
    CHECK (sort_order >= 0),
  CONSTRAINT shipping_rate_book_destination_group_lock_chk
    CHECK (lock_version > 0),
  CONSTRAINT shipping_rate_book_destination_group_actor_chk
    CHECK (created_by = btrim(created_by) AND created_by <> '')
);

CREATE UNIQUE INDEX shipping_rate_book_destination_group_name_idx
  ON shipping.rate_book_destination_groups(rate_book_id, lower(name))
  WHERE status = 'active';

CREATE INDEX shipping_rate_book_destination_group_book_idx
  ON shipping.rate_book_destination_groups(
    rate_book_id,
    status,
    sort_order,
    id
  );

CREATE TABLE shipping.rate_book_destination_group_members (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  destination_group_id INTEGER NOT NULL
    REFERENCES shipping.rate_book_destination_groups(id) ON DELETE CASCADE,
  destination_country VARCHAR(2) NOT NULL,
  destination_region VARCHAR(10),
  postal_prefix VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_book_destination_group_member_country_chk
    CHECK (destination_country ~ '^[A-Z]{2}$'),
  CONSTRAINT shipping_rate_book_destination_group_member_region_chk
    CHECK (
      destination_region IS NULL
      OR destination_region ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    ),
  CONSTRAINT shipping_rate_book_destination_group_member_postal_chk
    CHECK (
      postal_prefix IS NULL
      OR (
        destination_region IS NOT NULL
        AND
        postal_prefix = btrim(postal_prefix)
        AND postal_prefix ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    )
);

CREATE UNIQUE INDEX shipping_rate_book_destination_group_member_idx
  ON shipping.rate_book_destination_group_members(
    destination_group_id,
    destination_country,
    COALESCE(destination_region, ''),
    COALESCE(postal_prefix, '')
  );

CREATE INDEX shipping_rate_book_destination_group_member_lookup_idx
  ON shipping.rate_book_destination_group_members(
    destination_country,
    destination_region,
    postal_prefix,
    destination_group_id
  );

CREATE TABLE shipping.rate_table_coverages (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_table_id INTEGER NOT NULL
    REFERENCES shipping.rate_tables(id) ON DELETE CASCADE,
  destination_group_id INTEGER NOT NULL
    REFERENCES shipping.rate_book_destination_groups(id) ON DELETE RESTRICT,
  origin_warehouse_id INTEGER
    REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  availability VARCHAR(20) NOT NULL,
  destination_group_lock_version INTEGER NOT NULL,
  destination_group_name VARCHAR(160) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_table_coverage_availability_chk
    CHECK (availability IN ('offered', 'not_offered')),
  CONSTRAINT shipping_rate_table_coverage_group_version_chk
    CHECK (destination_group_lock_version > 0),
  CONSTRAINT shipping_rate_table_coverage_name_chk
    CHECK (
      destination_group_name = btrim(destination_group_name)
      AND destination_group_name <> ''
    ),
  CONSTRAINT shipping_rate_table_coverage_sort_chk
    CHECK (sort_order >= 0)
);

CREATE UNIQUE INDEX shipping_rate_table_coverage_group_idx
  ON shipping.rate_table_coverages(
    rate_table_id,
    destination_group_id,
    COALESCE(origin_warehouse_id, 0)
  );

CREATE INDEX shipping_rate_table_coverage_table_idx
  ON shipping.rate_table_coverages(rate_table_id, sort_order, id);

CREATE TABLE shipping.rate_table_coverage_destinations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_table_coverage_id INTEGER NOT NULL
    REFERENCES shipping.rate_table_coverages(id) ON DELETE CASCADE,
  destination_country VARCHAR(2) NOT NULL,
  destination_region VARCHAR(10),
  postal_prefix VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_table_coverage_destination_country_chk
    CHECK (destination_country ~ '^[A-Z]{2}$'),
  CONSTRAINT shipping_rate_table_coverage_destination_region_chk
    CHECK (
      destination_region IS NULL
      OR destination_region ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    ),
  CONSTRAINT shipping_rate_table_coverage_destination_postal_chk
    CHECK (
      postal_prefix IS NULL
      OR (
        destination_region IS NOT NULL
        AND
        postal_prefix = btrim(postal_prefix)
        AND postal_prefix ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    )
);

CREATE UNIQUE INDEX shipping_rate_table_coverage_destination_idx
  ON shipping.rate_table_coverage_destinations(
    rate_table_coverage_id,
    destination_country,
    COALESCE(destination_region, ''),
    COALESCE(postal_prefix, '')
  );

CREATE INDEX shipping_rate_table_coverage_destination_lookup_idx
  ON shipping.rate_table_coverage_destinations(
    destination_country,
    destination_region,
    postal_prefix,
    rate_table_coverage_id
  );

COMMENT ON TABLE shipping.rate_book_destination_groups IS
  'Stable named destination groups within one pricing program.';

COMMENT ON TABLE shipping.rate_table_coverages IS
  'Frozen offered or not-offered destination-group intent for one rate-table revision.';

COMMENT ON TABLE shipping.rate_table_coverage_destinations IS
  'Frozen geography snapshot preventing later group edits from changing active revision meaning.';
