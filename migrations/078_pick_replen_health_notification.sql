-- Notification emitted by the scheduled Pick/Replen Health monitor.

INSERT INTO notifications.notification_types (key, label, description, category) VALUES
  ('pick_replen_health_attention', 'Pick/Replen Health Attention', 'Pick/Replen Health has stale tasks, duplicates, unresolved shorts, or allocation exceptions needing review', 'picking')
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category;

DO $$
DECLARE
  admin_role_id INTEGER;
  lead_role_id INTEGER;
  picker_role_id INTEGER;
  notification_type_id INTEGER;
BEGIN
  SELECT id INTO admin_role_id FROM public.auth_roles WHERE name = 'admin';
  SELECT id INTO lead_role_id FROM public.auth_roles WHERE name = 'lead';
  SELECT id INTO picker_role_id FROM public.auth_roles WHERE name = 'picker';
  SELECT id INTO notification_type_id FROM notifications.notification_types WHERE key = 'pick_replen_health_attention';

  IF notification_type_id IS NOT NULL AND admin_role_id IS NOT NULL THEN
    INSERT INTO notifications.notification_preferences (notification_type_id, role_id, user_id, enabled)
    VALUES (notification_type_id, admin_role_id, NULL, 1)
    ON CONFLICT DO NOTHING;
  END IF;

  IF notification_type_id IS NOT NULL AND lead_role_id IS NOT NULL THEN
    INSERT INTO notifications.notification_preferences (notification_type_id, role_id, user_id, enabled)
    VALUES (notification_type_id, lead_role_id, NULL, 1)
    ON CONFLICT DO NOTHING;
  END IF;

  IF notification_type_id IS NOT NULL AND picker_role_id IS NOT NULL THEN
    INSERT INTO notifications.notification_preferences (notification_type_id, role_id, user_id, enabled)
    VALUES (notification_type_id, picker_role_id, NULL, 0)
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
