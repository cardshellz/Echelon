-- Notification system: types, preferences, and notifications

-- Static registry of notification events
CREATE TABLE IF NOT EXISTS notification_types (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  key VARCHAR(100) NOT NULL UNIQUE,
  label VARCHAR(200) NOT NULL,
  description TEXT,
  category VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

-- Role defaults + per-user overrides
CREATE TABLE IF NOT EXISTS notification_preferences (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  notification_type_id INTEGER NOT NULL REFERENCES notification_types(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES auth_roles(id) ON DELETE CASCADE,
  user_id VARCHAR REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_pref_type_role_user_idx
  ON notification_preferences(notification_type_id, role_id, user_id);

-- Delivered notifications
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notification_type_id INTEGER NOT NULL REFERENCES notification_types(id) ON DELETE CASCADE,
  title VARCHAR(300) NOT NULL,
  message TEXT,
  data JSONB,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS notifications_user_read_idx ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications(user_id, created_at DESC);

-- Seed notification types
INSERT INTO notification_types (key, label, description, category) VALUES
  ('pallet_drop_needed', 'Pallet Drop Needed', 'A replenishment task requires a pallet drop from non-pickable storage', 'replenishment'),
  ('case_break_needed', 'Case Break Needed', 'A replenishment task requires breaking a case or pallet', 'replenishment'),
  ('stockout', 'Stockout Detected', 'A bin has reached zero inventory with no replenishment source available', 'inventory'),
  ('shipment_arrived', 'Shipment Arrived', 'An inbound shipment status changed to arrived', 'receiving'),
  ('po_received', 'PO Received', 'A purchase order has been fully received', 'receiving'),
  ('pick_wave_ready', 'Pick Wave Ready', 'A new pick wave has been created and is ready for picking', 'picking')
ON CONFLICT (key) DO NOTHING;

-- Seed role defaults: admin=all on, lead=replen+receiving on, picker=all off
-- Get role IDs dynamically
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

  -- Admin: all notification types enabled
  IF admin_role_id IS NOT NULL THEN
    FOR nt IN SELECT id FROM notification_types LOOP
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
        VALUES (nt.id, admin_role_id, NULL, 1)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Lead: replenishment + receiving enabled
  IF lead_role_id IS NOT NULL THEN
    FOR nt IN SELECT id, category FROM notification_types LOOP
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
        VALUES (nt.id, lead_role_id, NULL, CASE WHEN nt.category IN ('replenishment', 'receiving') THEN 1 ELSE 0 END)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;

  -- Picker: all off
  IF picker_role_id IS NOT NULL THEN
    FOR nt IN SELECT id FROM notification_types LOOP
      INSERT INTO notification_preferences (notification_type_id, role_id, user_id, enabled)
        VALUES (nt.id, picker_role_id, NULL, 0)
        ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;
