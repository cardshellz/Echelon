-- Daily allocation includes cancelled/voided documents and custom references.
-- Existing active-only uniqueness indexes cannot support that complete prefix
-- search. These nonunique indexes preserve every identifier and uniqueness rule.
--
-- The release runner owns BEGIN/COMMIT, so CREATE INDEX CONCURRENTLY is not valid
-- here. Ordinary index creation allows reads but holds SHARE locks until commit,
-- temporarily blocking writes on these tables. No business records are changed.

CREATE INDEX IF NOT EXISTS purchase_orders_po_number_prefix_idx
  ON procurement.purchase_orders (po_number varchar_pattern_ops);

CREATE INDEX IF NOT EXISTS receiving_orders_receipt_number_prefix_idx
  ON procurement.receiving_orders (receipt_number varchar_pattern_ops);

CREATE INDEX IF NOT EXISTS ap_payments_payment_number_prefix_idx
  ON procurement.ap_payments (payment_number varchar_pattern_ops);

CREATE INDEX IF NOT EXISTS inventory_lots_lot_number_prefix_idx
  ON inventory.inventory_lots (lot_number varchar_pattern_ops);

CREATE INDEX IF NOT EXISTS vendor_invoices_invoice_number_prefix_idx
  ON procurement.vendor_invoices (invoice_number varchar_pattern_ops);

-- IF NOT EXISTS must not silently accept an unrelated or invalid same-name
-- index. Fail the release transaction if any existing definition is unsuitable.
DO $guard$
DECLARE
  expected record;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('procurement', 'purchase_orders', 'po_number', 'purchase_orders_po_number_prefix_idx'),
      ('procurement', 'receiving_orders', 'receipt_number', 'receiving_orders_receipt_number_prefix_idx'),
      ('procurement', 'ap_payments', 'payment_number', 'ap_payments_payment_number_prefix_idx'),
      ('inventory', 'inventory_lots', 'lot_number', 'inventory_lots_lot_number_prefix_idx'),
      ('procurement', 'vendor_invoices', 'invoice_number', 'vendor_invoices_invoice_number_prefix_idx')
    ) AS definitions(schema_name, table_name, column_name, index_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index definition
      JOIN pg_class index_relation ON index_relation.oid = definition.indexrelid
      JOIN pg_class source_relation ON source_relation.oid = definition.indrelid
      JOIN pg_namespace source_schema ON source_schema.oid = source_relation.relnamespace
      JOIN pg_namespace index_schema ON index_schema.oid = index_relation.relnamespace
      JOIN pg_attribute source_column ON source_column.attrelid = source_relation.oid
        AND source_column.attnum = definition.indkey[0]
      JOIN pg_opclass operator_class ON operator_class.oid = definition.indclass[0]
      JOIN pg_am access_method ON access_method.oid = index_relation.relam
      WHERE source_schema.nspname = expected.schema_name
        AND index_schema.nspname = expected.schema_name
        AND source_relation.relname = expected.table_name
        AND index_relation.relname = expected.index_name
        AND source_column.attname = expected.column_name
        AND definition.indisvalid AND definition.indisready
        AND NOT definition.indisunique
        AND definition.indnkeyatts = 1 AND definition.indnatts = 1
        AND definition.indpred IS NULL AND definition.indexprs IS NULL
        AND access_method.amname = 'btree'
        AND operator_class.opcname = 'varchar_pattern_ops'
    ) THEN
      RAISE EXCEPTION 'Document number prefix index %.% has an incompatible definition',
        expected.schema_name, expected.index_name USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$guard$;
