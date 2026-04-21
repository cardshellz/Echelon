-- 0559_pick_priority_settings.sql
-- Seed configurable pick priority settings into warehouse.echelon_settings.
-- These drive sort_rank computation (shipping base scores) and SLA fallback.
-- Admin Pick Priority page will read + edit these rows.

INSERT INTO warehouse.echelon_settings (key, value, type, category, description)
VALUES
  ('priority.shipping_base.standard',  '100', 'number', 'pick_priority',
    'Base priority score for standard shipping orders. Added to plan priority_modifier to produce the PPPP slot of sort_rank.'),
  ('priority.shipping_base.expedited', '300', 'number', 'pick_priority',
    'Base priority score for expedited shipping orders.'),
  ('priority.shipping_base.overnight', '500', 'number', 'pick_priority',
    'Base priority score for overnight shipping orders.'),
  ('priority.sla_default_days',        '3',   'number', 'pick_priority',
    'Default business days for SLA due_at when no channel ship-by date or partner profile SLA is provided.')
ON CONFLICT (key) DO NOTHING;
