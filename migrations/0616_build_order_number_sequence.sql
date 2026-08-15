-- Deterministic, concurrency-safe build order numbering. Sequence allocation
-- may contain gaps after rollbacks; identifiers remain unique and auditable.

CREATE SEQUENCE IF NOT EXISTS inventory.build_order_number_seq START WITH 1;

ALTER TABLE inventory.build_orders
  ALTER COLUMN system_number SET DEFAULT (
    'BLD-' || lpad(nextval('inventory.build_order_number_seq')::text, 8, '0')
  );
