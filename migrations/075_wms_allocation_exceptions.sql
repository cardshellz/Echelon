-- Allocation exception trail for picker-side bin overrides and setup repairs.
--
-- This is not a full allocation engine. It records cases where a WMS order item
-- could not be confidently assigned from slotting data, then the picker or lead
-- resolved the physical truth by entering/scanning the actual bin. The order
-- item remains the current picker-facing assignment cache; this table preserves
-- the reason, decision, and whether product-location setup was auto-repaired.

CREATE TABLE IF NOT EXISTS wms.allocation_exceptions (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id INTEGER NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES wms.order_items(id) ON DELETE CASCADE,
  order_number VARCHAR(50),
  sku VARCHAR(100) NOT NULL,
  product_variant_id INTEGER REFERENCES catalog.product_variants(id) ON DELETE SET NULL,
  exception_type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  requested_qty INTEGER NOT NULL DEFAULT 0,
  selected_location_id INTEGER REFERENCES warehouse.warehouse_locations(id) ON DELETE SET NULL,
  selected_location_code VARCHAR(50),
  resolution VARCHAR(50),
  auto_fixed_setup BOOLEAN NOT NULL DEFAULT FALSE,
  review_reason TEXT,
  resolved_by VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS allocation_exceptions_order_item_status_idx
  ON wms.allocation_exceptions(order_item_id, status);

CREATE INDEX IF NOT EXISTS allocation_exceptions_status_created_idx
  ON wms.allocation_exceptions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS allocation_exceptions_sku_status_idx
  ON wms.allocation_exceptions(sku, status);

INSERT INTO notification_types (key, label, description, category) VALUES
  ('allocation_auto_fixed', 'Allocation Auto-Fixed', 'A picker bin override also repaired missing product-location setup', 'picking'),
  ('allocation_review_needed', 'Allocation Review Needed', 'A picker bin override needs lead review before setup should be changed', 'picking'),
  ('allocation_blocked', 'Allocation Blocked', 'A picker bin override could not be safely accepted', 'picking')
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category;

DO $$
DECLARE
  admin_role_id INTEGER;
  lead_role_id INTEGER;
  picker_role_id INTEGER;
  nt RECORD;
BEGIN
  SELECT id INTO admin_role_id FROM auth_roles WHERE name = 'admin';
  SELECT id INTO lead_role_id FROM auth_roles WHERE name = 'lead';
  SELECT id INTO picker_role_id FROM auth_roles WHERE name = 'picker';

  FOR nt IN
    SELECT id FROM notification_types
    WHERE key IN ('allocation_auto_fixed', 'allocation_review_needed', 'allocation_blocked')
  LOOP
    IF admin_role_id IS NOT NULL THEN
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
      VALUES (nt.id, admin_role_id, NULL, 1)
      ON CONFLICT DO NOTHING;
    END IF;

    IF lead_role_id IS NOT NULL THEN
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
      VALUES (nt.id, lead_role_id, NULL, 1)
      ON CONFLICT DO NOTHING;
    END IF;

    IF picker_role_id IS NOT NULL THEN
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
      VALUES (nt.id, picker_role_id, NULL, 0)
      ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
END $$;
