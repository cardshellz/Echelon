-- The release executor owns the transaction and its migration-record insert.

-- Picker-observation reconciliation writes composite references such as
-- claim:{id}:resource:{id}:observation:{64-hex hash}:to-lot:{lot} (~118 chars).
-- varchar(100) rejected every such pick with "value too long for type character
-- varying(100)" (2026-10-18). Raising a varchar limit is metadata-only in
-- PostgreSQL: no table rewrite and no index rebuild.
ALTER TABLE inventory.inventory_transactions
  ALTER COLUMN reference_id TYPE varchar(500);
