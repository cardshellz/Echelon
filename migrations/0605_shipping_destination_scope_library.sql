BEGIN;

ALTER TABLE shipping.rate_book_destination_groups
  ADD COLUMN IF NOT EXISTS source_destination_scope_lock_version integer;

ALTER TABLE shipping.rate_table_coverages
  ADD COLUMN IF NOT EXISTS source_destination_scope_id integer
    REFERENCES shipping.destination_scopes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_destination_scope_lock_version integer;

UPDATE shipping.rate_book_destination_groups AS destination_group
SET source_destination_scope_lock_version = destination_scope.lock_version
FROM shipping.destination_scopes AS destination_scope
WHERE destination_group.source_destination_scope_id = destination_scope.id
  AND destination_group.source_destination_scope_lock_version IS NULL;

DO $$
DECLARE
  destination_group record;
  matching_scope_id integer;
  matching_scope_lock_version integer;
BEGIN
  FOR destination_group IN
    SELECT destination_group_row.id,
           destination_group_row.rate_book_id,
           destination_group_row.name
    FROM shipping.rate_book_destination_groups AS destination_group_row
    WHERE destination_group_row.status = 'active'
      AND destination_group_row.source_destination_scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM shipping.rate_book_destination_group_members AS member
        WHERE member.destination_group_id = destination_group_row.id
      )
    ORDER BY destination_group_row.id
  LOOP
    matching_scope_id := NULL;
    matching_scope_lock_version := NULL;

    SELECT destination_scope.id,
           destination_scope.lock_version
    INTO matching_scope_id,
         matching_scope_lock_version
    FROM shipping.destination_scopes AS destination_scope
    WHERE destination_scope.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM shipping.rate_book_destination_groups AS used_group
        WHERE used_group.rate_book_id = destination_group.rate_book_id
          AND used_group.status = 'active'
          AND used_group.source_destination_scope_id = destination_scope.id
      )
      AND NOT EXISTS (
        SELECT member.destination_country,
               member.destination_region,
               member.postal_prefix
        FROM shipping.rate_book_destination_group_members AS member
        WHERE member.destination_group_id = destination_group.id
        EXCEPT
        SELECT member.destination_country,
               member.destination_region,
               member.postal_prefix
        FROM shipping.destination_scope_members AS member
        WHERE member.destination_scope_id = destination_scope.id
      )
      AND NOT EXISTS (
        SELECT member.destination_country,
               member.destination_region,
               member.postal_prefix
        FROM shipping.destination_scope_members AS member
        WHERE member.destination_scope_id = destination_scope.id
        EXCEPT
        SELECT member.destination_country,
               member.destination_region,
               member.postal_prefix
        FROM shipping.rate_book_destination_group_members AS member
        WHERE member.destination_group_id = destination_group.id
      )
    ORDER BY destination_scope.id
    LIMIT 1;

    IF matching_scope_id IS NULL THEN
      INSERT INTO shipping.destination_scopes (
        code,
        name,
        status,
        metadata,
        created_by,
        lock_version
      ) VALUES (
        'pricing-scope-' || destination_group.id,
        destination_group.name,
        'active',
        jsonb_build_object(
          'source', 'migration:0605',
          'legacyRateBookDestinationGroupId', destination_group.id
        ),
        'migration:0605',
        1
      )
      RETURNING id, lock_version
      INTO matching_scope_id, matching_scope_lock_version;

      INSERT INTO shipping.destination_scope_members (
        destination_scope_id,
        destination_country,
        destination_region,
        postal_prefix
      )
      SELECT matching_scope_id,
             member.destination_country,
             member.destination_region,
             member.postal_prefix
      FROM shipping.rate_book_destination_group_members AS member
      WHERE member.destination_group_id = destination_group.id;
    END IF;

    UPDATE shipping.rate_book_destination_groups
    SET source_destination_scope_id = matching_scope_id,
        source_destination_scope_lock_version = matching_scope_lock_version
    WHERE id = destination_group.id;
  END LOOP;
END $$;

UPDATE shipping.rate_table_coverages AS coverage
SET source_destination_scope_id = destination_group.source_destination_scope_id,
    source_destination_scope_lock_version =
      destination_group.source_destination_scope_lock_version
FROM shipping.rate_book_destination_groups AS destination_group
WHERE coverage.destination_group_id = destination_group.id
  AND coverage.source_destination_scope_id IS NULL
  AND destination_group.source_destination_scope_id IS NOT NULL;

ALTER TABLE shipping.rate_book_destination_groups
  DROP CONSTRAINT IF EXISTS shipping_rate_book_destination_group_source_version_chk;

ALTER TABLE shipping.rate_book_destination_groups
  ADD CONSTRAINT shipping_rate_book_destination_group_source_version_chk
  CHECK (
    (source_destination_scope_id IS NULL AND source_destination_scope_lock_version IS NULL)
    OR
    (source_destination_scope_id IS NOT NULL AND source_destination_scope_lock_version > 0)
  );

ALTER TABLE shipping.rate_table_coverages
  DROP CONSTRAINT IF EXISTS shipping_rate_table_coverage_source_version_chk;

ALTER TABLE shipping.rate_table_coverages
  ADD CONSTRAINT shipping_rate_table_coverage_source_version_chk
  CHECK (
    (source_destination_scope_id IS NULL AND source_destination_scope_lock_version IS NULL)
    OR
    (source_destination_scope_id IS NOT NULL AND source_destination_scope_lock_version > 0)
  );

CREATE INDEX IF NOT EXISTS shipping_rate_table_coverage_source_idx
  ON shipping.rate_table_coverages (
    source_destination_scope_id,
    source_destination_scope_lock_version
  );

CREATE UNIQUE INDEX IF NOT EXISTS shipping_rate_book_destination_group_scope_idx
  ON shipping.rate_book_destination_groups (rate_book_id, source_destination_scope_id)
  WHERE status = 'active' AND source_destination_scope_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shipping_rate_book_destination_group_source_idx
  ON shipping.rate_book_destination_groups (source_destination_scope_id, status);

COMMIT;
