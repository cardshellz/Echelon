-- Echelon baseline reference data (`P4.1` empty-DB bootstrap).
--
-- Runs inside `applyBaselineToEmptyDatabase` immediately after `schema.sql`
-- and before `public._migrations` records the covered migrations, under an
-- empty `search_path` (`SELECT pg_catalog.set_config('search_path', '', true)`).
--
-- Every statement MUST:
--   1. Schema-qualify all table and function references.
--   2. Be 100% idempotent (`ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS`).
--   3. Restore any bootstrap-disabled singleton guard trigger before returning.
--
-- Production has migration records and never executes `applyBaselineToEmptyDatabase`.

-- ── 1. Inventory & Procurement Singleton Admission Fences ───────────────────
ALTER TABLE inventory.availability_runtime_authority
  DISABLE TRIGGER aa_cutover_control_owner;

INSERT INTO inventory.availability_runtime_authority (
  singleton_key,
  authority,
  activation_run_id,
  revision,
  changed_by,
  change_reason
) VALUES (
  true,
  'legacy',
  NULL,
  1,
  'baseline:reference-data',
  'Initialize inactive inventory availability cutover authority.'
) ON CONFLICT (singleton_key) DO NOTHING;

ALTER TABLE inventory.availability_runtime_authority
  ENABLE TRIGGER aa_cutover_control_owner;

ALTER TABLE inventory.cutover_admission_fence
  DISABLE TRIGGER cutover_admission_owner_write_guard;

INSERT INTO inventory.cutover_admission_fence (singleton_key, epoch)
VALUES (true, 1)
ON CONFLICT (singleton_key) DO NOTHING;

ALTER TABLE inventory.cutover_admission_fence
  ENABLE TRIGGER cutover_admission_owner_write_guard;

INSERT INTO inventory.quantity_publication_gate (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO procurement.receiving_custody_fence (singleton, revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO procurement.purchase_planning_policy (id, revision, policy)
VALUES (1, 0, '{"version":1,"growthPercent":0,"targetCoverDays":null,"products":[]}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── 2. OMS ISO Country Codes, Country Aliases & Bridge Checkpoint ───────────
INSERT INTO oms.order_country_codes (code)
SELECT pg_catalog.unnest(ARRAY[
  'AD','AE','AF','AG','AI','AL','AM','AO','AQ','AR','AS','AT','AU','AW','AX','AZ',
  'BA','BB','BD','BE','BF','BG','BH','BI','BJ','BL','BM','BN','BO','BQ','BR','BS',
  'BT','BV','BW','BY','BZ','CA','CC','CD','CF','CG','CH','CI','CK','CL','CM','CN',
  'CO','CR','CU','CV','CW','CX','CY','CZ','DE','DJ','DK','DM','DO','DZ','EC','EE',
  'EG','EH','ER','ES','ET','FI','FJ','FK','FM','FO','FR','GA','GB','GD','GE','GF',
  'GG','GH','GI','GL','GM','GN','GP','GQ','GR','GS','GT','GU','GW','GY','HK','HM',
  'HN','HR','HT','HU','ID','IE','IL','IM','IN','IO','IQ','IR','IS','IT','JE','JM',
  'JO','JP','KE','KG','KH','KI','KM','KN','KP','KR','KW','KY','KZ','LA','LB','LC',
  'LI','LK','LR','LS','LT','LU','LV','LY','MA','MC','MD','ME','MF','MG','MH','MK',
  'ML','MM','MN','MO','MP','MQ','MR','MS','MT','MU','MV','MW','MX','MY','MZ','NA',
  'NC','NE','NF','NG','NI','NL','NO','NP','NR','NU','NZ','OM','PA','PE','PF','PG',
  'PH','PK','PL','PM','PN','PR','PS','PT','PW','PY','QA','RE','RO','RS','RU','RW',
  'SA','SB','SC','SD','SE','SG','SH','SI','SJ','SK','SL','SM','SN','SO','SR','SS',
  'ST','SV','SX','SY','SZ','TC','TD','TF','TG','TH','TJ','TK','TL','TM','TN','TO',
  'TR','TT','TV','TW','TZ','UA','UG','UM','US','UY','UZ','VA','VC','VE','VG','VI',
  'VN','VU','WF','WS','YE','YT','ZA','ZM','ZW'
]::text[])
ON CONFLICT (code) DO NOTHING;

INSERT INTO oms.order_country_aliases (alias, code) VALUES
  ('united states', 'US'),
  ('united states of america', 'US'),
  ('usa', 'US'),
  ('u.s.a.', 'US'),
  ('u.s.', 'US'),
  ('puerto rico', 'PR'),
  ('guam', 'GU'),
  ('u.s. virgin islands', 'VI'),
  ('us virgin islands', 'VI'),
  ('american samoa', 'AS'),
  ('northern mariana islands', 'MP'),
  ('canada', 'CA'),
  ('united kingdom', 'GB'),
  ('great britain', 'GB'),
  ('britain', 'GB'),
  ('england', 'GB'),
  ('scotland', 'GB'),
  ('wales', 'GB'),
  ('northern ireland', 'GB'),
  ('uk', 'GB'),
  ('australia', 'AU'),
  ('new zealand', 'NZ'),
  ('ireland', 'IE'),
  ('germany', 'DE'),
  ('deutschland', 'DE'),
  ('france', 'FR'),
  ('spain', 'ES'),
  ('italy', 'IT'),
  ('netherlands', 'NL'),
  ('the netherlands', 'NL'),
  ('holland', 'NL'),
  ('belgium', 'BE'),
  ('switzerland', 'CH'),
  ('austria', 'AT'),
  ('sweden', 'SE'),
  ('norway', 'NO'),
  ('denmark', 'DK'),
  ('finland', 'FI'),
  ('iceland', 'IS'),
  ('poland', 'PL'),
  ('portugal', 'PT'),
  ('greece', 'GR'),
  ('czech republic', 'CZ'),
  ('czechia', 'CZ'),
  ('hungary', 'HU'),
  ('romania', 'RO'),
  ('bulgaria', 'BG'),
  ('croatia', 'HR'),
  ('slovakia', 'SK'),
  ('slovenia', 'SI'),
  ('estonia', 'EE'),
  ('latvia', 'LV'),
  ('lithuania', 'LT'),
  ('luxembourg', 'LU'),
  ('cyprus', 'CY'),
  ('malta', 'MT'),
  ('japan', 'JP'),
  ('china', 'CN'),
  ('hong kong', 'HK'),
  ('hong kong sar china', 'HK'),
  ('hong kong sar', 'HK'),
  ('macau', 'MO'),
  ('macao', 'MO'),
  ('macao sar china', 'MO'),
  ('south korea', 'KR'),
  ('korea, republic of', 'KR'),
  ('republic of korea', 'KR'),
  ('singapore', 'SG'),
  ('taiwan', 'TW'),
  ('taiwan, province of china', 'TW'),
  ('india', 'IN'),
  ('pakistan', 'PK'),
  ('bangladesh', 'BD'),
  ('sri lanka', 'LK'),
  ('nepal', 'NP'),
  ('mexico', 'MX'),
  ('brazil', 'BR'),
  ('argentina', 'AR'),
  ('chile', 'CL'),
  ('colombia', 'CO'),
  ('peru', 'PE'),
  ('ecuador', 'EC'),
  ('uruguay', 'UY'),
  ('venezuela', 'VE'),
  ('panama', 'PA'),
  ('guatemala', 'GT'),
  ('costa rica', 'CR'),
  ('dominican republic', 'DO'),
  ('united arab emirates', 'AE'),
  ('uae', 'AE'),
  ('saudi arabia', 'SA'),
  ('qatar', 'QA'),
  ('kuwait', 'KW'),
  ('bahrain', 'BH'),
  ('oman', 'OM'),
  ('jordan', 'JO'),
  ('lebanon', 'LB'),
  ('israel', 'IL'),
  ('turkey', 'TR'),
  ('turkiye', 'TR'),
  ('russia', 'RU'),
  ('russian federation', 'RU'),
  ('ukraine', 'UA'),
  ('egypt', 'EG'),
  ('morocco', 'MA'),
  ('nigeria', 'NG'),
  ('kenya', 'KE'),
  ('ghana', 'GH'),
  ('south africa', 'ZA'),
  ('philippines', 'PH'),
  ('malaysia', 'MY'),
  ('thailand', 'TH'),
  ('indonesia', 'ID'),
  ('vietnam', 'VN'),
  ('viet nam', 'VN'),
  ('can', 'CA'),
  ('gbr', 'GB'),
  ('aus', 'AU'),
  ('deu', 'DE'),
  ('fra', 'FR'),
  ('nld', 'NL')
ON CONFLICT (alias) DO NOTHING;

INSERT INTO oms.shopify_order_bridge_checkpoints (id, monitor_started_at)
VALUES (1, TIMESTAMPTZ '2026-07-01 00:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ── 3. Channels Global Sync Singleton & Internal Dropship Channel ───────────
INSERT INTO channels.sync_settings (
  singleton_key,
  global_enabled,
  sweep_interval_minutes,
  revision,
  changed_by,
  change_reason
) VALUES (
  true,
  false,
  15,
  1,
  'baseline:reference-data',
  'Created disabled pending an explicit operator command.'
) ON CONFLICT (singleton_key) DO NOTHING;

INSERT INTO channels.channels (
  name,
  type,
  provider,
  status,
  shipping_config,
  created_at,
  updated_at
)
SELECT
  'Dropship OMS',
  'internal',
  'manual',
  'active',
  '{}'::jsonb,
  pg_catalog.now(),
  pg_catalog.now()
WHERE NOT EXISTS (
  SELECT 1
  FROM channels.channels
  WHERE pg_catalog.lower(name) = 'dropship oms'
    AND type = 'internal'
    AND provider = 'manual'
);

-- ── 4. Catalog Taxonomies (Product Lines, Product Types, Shipping Groups) ───
INSERT INTO catalog.product_lines (code, name, description, sort_order)
VALUES (
  'TRADING_CARD_SUPPLIES',
  'Trading Card Supplies',
  'Card sleeves, toploaders, boxes, and accessories',
  0
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO catalog.product_types (slug, name, sort_order) VALUES
  ('toploaders', 'Toploaders', 1),
  ('easy-glide-sleeves', 'Easy Glide Soft Sleeves', 2),
  ('magnetic-holders', 'Magnetic Holders', 3),
  ('semi-rigids', 'Semi-Rigid Holders', 4),
  ('armalopes', 'Armalope Envelopes', 5),
  ('hero-cases', 'HERO Graded Card Cases', 6),
  ('binders', 'Binders & Pages', 7),
  ('storage-boxes', 'Storage Boxes (Quad Box, 400ct, etc.)', 8),
  ('glove-fit-toploader', 'Glove-Fit Toploader Sleeves', 9),
  ('glove-fit-mag', 'Glove-Fit Magnetic Holder Sleeves', 10),
  ('glove-fit-graded', 'Glove-Fit Graded Card Sleeves', 11),
  ('glove-fit-semi', 'Glove-Fit Semi-Rigid Sleeves', 12),
  ('sleeves-bags', 'Sleeves & Bags (team bags, 8x10, etc.)', 13),
  ('accessories', 'Accessories (mats, stamps, dividers, stands)', 14),
  ('wax', 'Wax/Sealed Products (boxes, packs)', 15),
  ('other', 'Other', 99)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO catalog.shipping_groups (code, name, description, sort_order) VALUES
  (
    'protection',
    'Protection',
    'Boxed plastic protection and general merchandise — combinable in a standard box.',
    0
  ),
  (
    'storage_boxes',
    'Storage Boxes',
    'Tough Box / Quad Box storage — ship flat in dedicated mailers, cannot combine with boxed protection.',
    1
  )
ON CONFLICT (code) DO NOTHING;

-- ── 5. Warehouse System Transit Node, Pick-Priority Settings, Notifications & Permissions ──
INSERT INTO warehouse.warehouses (
  code,
  name,
  warehouse_type,
  is_active,
  is_default,
  inventory_source_type,
  feed_enabled
) VALUES (
  'SYSTEM-TRANSIT',
  'Inventory in transit',
  'system_transit',
  1,
  0,
  'internal',
  false
) ON CONFLICT (code) DO NOTHING;

INSERT INTO warehouse.echelon_settings (key, value, type, category, description) VALUES
  (
    'priority.shipping_base.standard',
    '100',
    'number',
    'pick_priority',
    'Base priority score for standard shipping orders. Added to plan priority_modifier to produce the PPPP slot of sort_rank.'
  ),
  (
    'priority.shipping_base.expedited',
    '300',
    'number',
    'pick_priority',
    'Base priority score for expedited shipping orders.'
  ),
  (
    'priority.shipping_base.overnight',
    '500',
    'number',
    'pick_priority',
    'Base priority score for overnight shipping orders.'
  ),
  (
    'priority.sla_default_days',
    '3',
    'number',
    'pick_priority',
    'Default business days for SLA due_at when no channel ship-by date or partner profile SLA is provided.'
  )
ON CONFLICT (key) DO NOTHING;

INSERT INTO notifications.notification_types (key, label, description, category) VALUES
  ('pallet_drop_needed', 'Pallet Drop Needed', 'A replenishment task requires a pallet drop from non-pickable storage', 'replenishment'),
  ('case_break_needed', 'Case Break Needed', 'A replenishment task requires breaking a case or pallet', 'replenishment'),
  ('stockout', 'Stockout Detected', 'A bin has reached zero inventory with no replenishment source available', 'inventory'),
  ('shipment_arrived', 'Shipment Arrived', 'An inbound shipment status changed to arrived', 'receiving'),
  ('po_received', 'PO Received', 'A purchase order has been fully received', 'receiving'),
  ('pick_wave_ready', 'Pick Wave Ready', 'A new pick wave has been created and is ready for picking', 'picking'),
  ('allocation_auto_fixed', 'Allocation Auto-Fixed', 'A picker bin override also repaired missing product-location setup', 'picking'),
  ('allocation_review_needed', 'Allocation Review Needed', 'A picker bin override needs lead review before setup should be changed', 'picking'),
  ('allocation_blocked', 'Allocation Blocked', 'A picker bin override could not be safely accepted', 'picking'),
  ('pick_replen_health_attention', 'Pick/Replen Health Attention', 'Pick/Replen Health has stale tasks, duplicates, unresolved shorts, or allocation exceptions needing review', 'picking'),
  ('auto_draft_po_critical_stale', 'Critical Auto-Draft PO Aging', 'Auto-drafted purchase orders have crossed critical stale aging thresholds and need operator action', 'procurement'),
  ('procurement_health_critical', 'Critical Procurement Health', 'Aggregate procurement health monitor has critical supplier, purchase order, landed cost, or forecast readiness signals', 'procurement')
ON CONFLICT (key) DO NOTHING;

INSERT INTO identity.auth_permissions (resource, action, description, category) VALUES
  ('orders', 'override_priority', 'Systemic override of shipping SLAs (BUMP, HOLD, NORMAL)', 'orders'),
  ('inventory_planning', 'view', 'View inventory availability master data and draft evidence', 'inventory'),
  ('inventory_planning', 'edit', 'Create and edit inventory availability drafts', 'inventory'),
  ('inventory_planning', 'activate', 'Activate validated inventory availability authority', 'inventory')
ON CONFLICT (resource, action) DO NOTHING;

-- ── 6. Dropship Singleton Policies & Detection State ────────────────────────
INSERT INTO dropship.dropship_collection_config (
  version,
  grace_days,
  sweep_cadence_days,
  max_consecutive_failures,
  is_active
)
SELECT 1, 7, 7, 3, true
WHERE NOT EXISTS (
  SELECT 1 FROM dropship.dropship_collection_config WHERE is_active = true
);

INSERT INTO dropship.dropship_cost_change_policies (
  version,
  increase_notice_days,
  decrease_timing,
  price_protection,
  retail_changes_get_notice,
  notify_by_email,
  notify_in_portal,
  notify_on_decrease,
  notice_minimum_change_cents,
  notice_minimum_change_bps,
  rule_priced_listings,
  below_cost_fixed_listings,
  detection_interval_minutes,
  is_active,
  change_note,
  created_by_actor_type,
  created_by_actor_id
)
SELECT
  1,
  14,
  'immediate',
  true,
  true,
  true,
  true,
  true,
  0,
  0,
  'reprice_automatically',
  'warn',
  60,
  true,
  'Initial defaults from baseline reference seed (migration 0710).',
  'system',
  'baseline:reference-data'
WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_cost_change_policies);

INSERT INTO dropship.dropship_cost_detection_state (id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_cost_detection_state);

INSERT INTO dropship.dropship_return_policies (
  version,
  return_window_days,
  vendor_id,
  store_connection_id,
  priority,
  is_active,
  effective_from
)
SELECT 1, 30, NULL, NULL, 0, true, pg_catalog.now()
WHERE NOT EXISTS (
  SELECT 1
  FROM dropship.dropship_return_policies p
  WHERE p.vendor_id IS NULL
    AND p.store_connection_id IS NULL
    AND p.is_active = true
);

INSERT INTO dropship.dropship_wallet_policies (
  version,
  minimum_floor_cents,
  case_tier_minimum_cents,
  minimum_single_top_up_limit_cents,
  manual_top_up_minimum_cents,
  manual_top_up_maximum_cents,
  default_payment_hold_timeout_minutes,
  hold_expiry_warning_minutes,
  advance_fee_bps,
  advance_cap_cents,
  tier_change_grace_days,
  card_funding_fee_bps,
  card_funding_minimum_cents,
  rewards_rate_bank_bps,
  rewards_rate_usdc_bps,
  rewards_rate_card_bps,
  rewards_expiry_days,
  is_active,
  change_note,
  created_by_actor_type,
  created_by_actor_id
)
SELECT
  2,
  10000,
  50000,
  10000,
  1000,
  500000,
  1440,
  120,
  100,
  50000,
  14,
  0,
  10000,
  100,
  100,
  0,
  NULL,
  true,
  'Baseline reference seed (migrations 0683, 0701, 0702, 0705).',
  'system',
  NULL
WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_wallet_policies);

-- ── 7. Shipping Engine Static Service Levels, Zone Sets & Default Rate Books
INSERT INTO shipping.service_levels (
  code,
  display_name,
  description,
  sort_order,
  is_active,
  fulfillment_mode,
  promise_min_business_days,
  promise_max_business_days
) VALUES
  ('standard', 'Standard Shipping', 'Default ground service', 10, false, 'parcel', NULL, NULL),
  ('expedited', 'Expedited Shipping', 'Faster ground/2-3 day service', 20, false, 'parcel', NULL, NULL),
  ('express', 'Express Shipping', '1-2 day air service', 30, false, 'parcel', NULL, NULL),
  ('pallet_freight', 'Pallet Freight', 'Palletized freight delivery for larger orders', 40, false, 'freight', NULL, NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO shipping.zone_sets (code, name, status, metadata) VALUES
  ('retail-us-default', 'Retail US default zones', 'active', '{"source":"baseline:reference-data","migration":137}'::jsonb),
  ('retail-us-state-zip', 'Retail US states and ZIP overrides', 'active', '{"pricingGeography":"state_zip","country":"US"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO shipping.rate_books (code, name, zone_set_id, status, metadata)
SELECT
  'shopify-retail-default',
  'Shopify retail default',
  id,
  'active',
  '{"source":"baseline:reference-data","migration":137}'::jsonb
FROM shipping.zone_sets
WHERE code = 'retail-us-state-zip'
ON CONFLICT (code) DO NOTHING;

INSERT INTO shipping.rate_books (code, name, zone_set_id, status, metadata)
SELECT
  'dropship-vendor-default',
  'Dropship vendor fulfillment',
  id,
  'active',
  '{"source":"baseline:reference-data","migration":588}'::jsonb
FROM shipping.zone_sets
WHERE code = 'retail-us-state-zip'
ON CONFLICT (code) DO NOTHING;
