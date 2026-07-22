-- Product-aware shipping pricing policies.
--
-- Product sets are reusable authoring aids. Every rate rule stores its own
-- variant-member snapshot so catalog changes cannot mutate an active revision.

CREATE TABLE shipping.product_sets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(100) NOT NULL,
  name varchar(160) NOT NULL,
  selector_kind varchar(30) NOT NULL,
  selector_ref varchar(160),
  status varchar(20) NOT NULL DEFAULT 'active',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipping_product_set_selector_kind_chk
    CHECK (selector_kind IN ('manual', 'shipping_group', 'product_line', 'category', 'sioc')),
  CONSTRAINT shipping_product_set_status_chk
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT shipping_product_set_selector_ref_chk CHECK (
    (selector_kind = 'manual' AND selector_ref IS NULL)
    OR (selector_kind <> 'manual' AND selector_ref IS NOT NULL)
  )
);

CREATE UNIQUE INDEX shipping_product_set_code_idx
  ON shipping.product_sets (code);

CREATE TABLE shipping.product_set_members (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_set_id integer NOT NULL
    REFERENCES shipping.product_sets(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shipping_product_set_member_idx
  ON shipping.product_set_members (product_set_id, product_variant_id);
CREATE INDEX shipping_product_set_member_variant_idx
  ON shipping.product_set_members (product_variant_id);

CREATE TABLE shipping.rate_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_table_id integer NOT NULL
    REFERENCES shipping.rate_tables(id) ON DELETE CASCADE,
  source_product_set_id integer
    REFERENCES shipping.product_sets(id) ON DELETE SET NULL,
  name varchar(160) NOT NULL,
  kind varchar(30) NOT NULL,
  action varchar(50) NOT NULL,
  measurement_scope varchar(30) NOT NULL,
  destination_scope jsonb NOT NULL,
  rate_cents bigint,
  per_started_pound_cents bigint,
  threshold_cents bigint,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_rule_kind_chk
    CHECK (kind IN ('restriction', 'base_charge', 'adjustment', 'threshold')),
  CONSTRAINT shipping_rate_rule_action_chk
    CHECK (action IN ('block', 'free', 'fixed', 'fixed_band', 'base_plus_per_started_pound', 'surcharge', 'free_threshold')),
  CONSTRAINT shipping_rate_rule_measurement_scope_chk
    CHECK (measurement_scope IN ('order', 'matched_items', 'each_item', 'carton')),
  CONSTRAINT shipping_rate_rule_money_chk CHECK (
    (rate_cents IS NULL OR rate_cents >= 0)
    AND (per_started_pound_cents IS NULL OR per_started_pound_cents >= 0)
    AND (threshold_cents IS NULL OR threshold_cents >= 0)
  )
);

CREATE INDEX shipping_rate_rule_table_idx
  ON shipping.rate_rules (rate_table_id, is_active);

CREATE TABLE shipping.rate_rule_members (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_rule_id integer NOT NULL
    REFERENCES shipping.rate_rules(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX shipping_rate_rule_member_idx
  ON shipping.rate_rule_members (rate_rule_id, product_variant_id);
CREATE INDEX shipping_rate_rule_member_variant_idx
  ON shipping.rate_rule_members (product_variant_id);

CREATE TABLE shipping.rate_rule_bands (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_rule_id integer NOT NULL
    REFERENCES shipping.rate_rules(id) ON DELETE CASCADE,
  min_measure integer NOT NULL DEFAULT 0,
  max_measure integer,
  rate_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_rule_band_measure_chk CHECK (
    min_measure >= 0 AND (max_measure IS NULL OR max_measure >= min_measure)
  ),
  CONSTRAINT shipping_rate_rule_band_rate_chk CHECK (rate_cents >= 0)
);

CREATE UNIQUE INDEX shipping_rate_rule_band_idx
  ON shipping.rate_rule_bands (rate_rule_id, min_measure, COALESCE(max_measure, -1));

COMMENT ON TABLE shipping.rate_rules IS
  'Immutable-with-revision product pricing and shipping restrictions attached to shipping.rate_tables.';
COMMENT ON TABLE shipping.rate_rule_members IS
  'Frozen variant membership used by a rate rule; live prices never depend on mutable catalog grouping.';
