CREATE TABLE IF NOT EXISTS oms.channel_order_intakes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  channel_id INTEGER REFERENCES channels.channels(id) ON DELETE SET NULL,
  source_domain VARCHAR(255),
  external_order_id VARCHAR(200) NOT NULL,
  external_order_number VARCHAR(100),
  first_observation_method VARCHAR(50) NOT NULL,
  last_observation_method VARCHAR(50) NOT NULL,
  source_inbox_id INTEGER REFERENCES oms.webhook_inbox(id) ON DELETE SET NULL,
  source_event_id VARCHAR(200),
  raw_payload JSONB,
  is_shippable BOOLEAN,
  status VARCHAR(20) NOT NULL DEFAULT 'observed',
  observation_count INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  source_ordered_at TIMESTAMPTZ,
  source_observed_at TIMESTAMPTZ,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_at TIMESTAMPTZ,
  ingested_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  oms_order_id BIGINT REFERENCES oms.oms_orders(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT channel_order_intakes_provider_external_uidx
    UNIQUE (provider, external_order_id),
  CONSTRAINT channel_order_intakes_status_chk
    CHECK (status IN ('observed', 'processing', 'ingested', 'failed', 'ignored')),
  CONSTRAINT channel_order_intakes_counts_chk
    CHECK (observation_count >= 1 AND attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_channel_order_intakes_status_observed
  ON oms.channel_order_intakes (status, last_observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_order_intakes_channel_ordered
  ON oms.channel_order_intakes (channel_id, source_ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_order_intakes_provider_ordered
  ON oms.channel_order_intakes (provider, source_ordered_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_order_intakes_oms_order
  ON oms.channel_order_intakes (oms_order_id)
  WHERE oms_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_channel_order_intakes_source_inbox
  ON oms.channel_order_intakes (source_inbox_id)
  WHERE source_inbox_id IS NOT NULL;

CREATE OR REPLACE FUNCTION oms.record_channel_order_intake(
  p_provider TEXT,
  p_external_order_id TEXT,
  p_external_order_number TEXT DEFAULT NULL,
  p_channel_id INTEGER DEFAULT NULL,
  p_observation_method TEXT DEFAULT 'unknown',
  p_source_domain TEXT DEFAULT NULL,
  p_source_inbox_id INTEGER DEFAULT NULL,
  p_source_event_id TEXT DEFAULT NULL,
  p_raw_payload JSONB DEFAULT NULL,
  p_is_shippable BOOLEAN DEFAULT NULL,
  p_status TEXT DEFAULT 'observed',
  p_oms_order_id BIGINT DEFAULT NULL,
  p_last_error TEXT DEFAULT NULL,
  p_source_ordered_at TIMESTAMPTZ DEFAULT NULL,
  p_observed_at TIMESTAMPTZ DEFAULT NOW(),
  p_increment_observation BOOLEAN DEFAULT TRUE,
  p_is_source_observation BOOLEAN DEFAULT TRUE
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_external_order_id TEXT;
  v_status TEXT;
  v_id BIGINT;
BEGIN
  v_external_order_id := BTRIM(COALESCE(p_external_order_id, ''));
  IF LOWER(p_provider) = 'shopify' THEN
    v_external_order_id := split_part(v_external_order_id, '/', -1);
  END IF;

  IF v_external_order_id = '' THEN
    RAISE EXCEPTION 'channel order intake requires an external order id';
  END IF;

  v_status := CASE
    WHEN p_status IN ('observed', 'processing', 'ingested', 'failed', 'ignored')
      THEN p_status
    ELSE 'observed'
  END;

  INSERT INTO oms.channel_order_intakes (
    provider,
    channel_id,
    source_domain,
    external_order_id,
    external_order_number,
    first_observation_method,
    last_observation_method,
    source_inbox_id,
    source_event_id,
    raw_payload,
    is_shippable,
    status,
    observation_count,
    attempt_count,
    source_ordered_at,
    source_observed_at,
    first_observed_at,
    last_observed_at,
    processing_at,
    ingested_at,
    failed_at,
    oms_order_id,
    last_error,
    created_at,
    updated_at
  ) VALUES (
    LOWER(p_provider),
    p_channel_id,
    NULLIF(BTRIM(p_source_domain), ''),
    v_external_order_id,
    NULLIF(BTRIM(p_external_order_number), ''),
    p_observation_method,
    p_observation_method,
    p_source_inbox_id,
    p_source_event_id,
    p_raw_payload,
    p_is_shippable,
    v_status,
    1,
    CASE WHEN v_status = 'failed' THEN 1 ELSE 0 END,
    p_source_ordered_at,
    CASE WHEN p_is_source_observation THEN COALESCE(p_observed_at, NOW()) END,
    COALESCE(p_observed_at, NOW()),
    COALESCE(p_observed_at, NOW()),
    CASE WHEN v_status = 'processing' THEN NOW() END,
    CASE WHEN v_status = 'ingested' THEN NOW() END,
    CASE WHEN v_status = 'failed' THEN NOW() END,
    p_oms_order_id,
    CASE WHEN v_status = 'failed' THEN p_last_error END,
    NOW(),
    NOW()
  )
  ON CONFLICT (provider, external_order_id) DO UPDATE SET
    channel_id = COALESCE(EXCLUDED.channel_id, channel_order_intakes.channel_id),
    source_domain = COALESCE(EXCLUDED.source_domain, channel_order_intakes.source_domain),
    external_order_number = COALESCE(EXCLUDED.external_order_number, channel_order_intakes.external_order_number),
    last_observation_method = EXCLUDED.last_observation_method,
    source_inbox_id = COALESCE(EXCLUDED.source_inbox_id, channel_order_intakes.source_inbox_id),
    source_event_id = COALESCE(EXCLUDED.source_event_id, channel_order_intakes.source_event_id),
    raw_payload = CASE
      WHEN EXCLUDED.raw_payload IS NULL THEN channel_order_intakes.raw_payload
      WHEN channel_order_intakes.raw_payload IS NULL THEN EXCLUDED.raw_payload
      WHEN jsonb_typeof(channel_order_intakes.raw_payload) = 'object'
        AND jsonb_typeof(EXCLUDED.raw_payload) = 'object'
        THEN channel_order_intakes.raw_payload || EXCLUDED.raw_payload
      ELSE EXCLUDED.raw_payload
    END,
    is_shippable = COALESCE(EXCLUDED.is_shippable, channel_order_intakes.is_shippable),
    status = CASE
      WHEN channel_order_intakes.oms_order_id IS NOT NULL OR EXCLUDED.status = 'ingested'
        THEN 'ingested'
      ELSE EXCLUDED.status
    END,
    observation_count = channel_order_intakes.observation_count
      + CASE WHEN p_increment_observation THEN 1 ELSE 0 END,
    attempt_count = channel_order_intakes.attempt_count
      + CASE WHEN EXCLUDED.status = 'failed' THEN 1 ELSE 0 END,
    source_ordered_at = COALESCE(channel_order_intakes.source_ordered_at, EXCLUDED.source_ordered_at),
    source_observed_at = CASE
      WHEN channel_order_intakes.source_observed_at IS NULL THEN EXCLUDED.source_observed_at
      WHEN EXCLUDED.source_observed_at IS NULL THEN channel_order_intakes.source_observed_at
      ELSE LEAST(channel_order_intakes.source_observed_at, EXCLUDED.source_observed_at)
    END,
    first_observed_at = LEAST(channel_order_intakes.first_observed_at, EXCLUDED.first_observed_at),
    last_observed_at = GREATEST(channel_order_intakes.last_observed_at, EXCLUDED.last_observed_at),
    processing_at = CASE
      WHEN EXCLUDED.status = 'processing' THEN NOW()
      ELSE channel_order_intakes.processing_at
    END,
    ingested_at = CASE
      WHEN EXCLUDED.status = 'ingested' THEN COALESCE(channel_order_intakes.ingested_at, NOW())
      ELSE channel_order_intakes.ingested_at
    END,
    failed_at = CASE
      WHEN EXCLUDED.status = 'failed' AND channel_order_intakes.oms_order_id IS NULL THEN NOW()
      ELSE channel_order_intakes.failed_at
    END,
    oms_order_id = COALESCE(EXCLUDED.oms_order_id, channel_order_intakes.oms_order_id),
    last_error = CASE
      WHEN channel_order_intakes.oms_order_id IS NOT NULL OR EXCLUDED.status = 'ingested' THEN NULL
      WHEN EXCLUDED.status = 'failed' THEN EXCLUDED.last_error
      ELSE channel_order_intakes.last_error
    END,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION oms.capture_order_webhook_intake()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_external_order_id TEXT;
  v_external_order_number TEXT;
  v_channel_id INTEGER;
  v_is_shippable BOOLEAN;
  v_source_ordered_at TIMESTAMPTZ;
  v_status TEXT;
BEGIN
  IF LOWER(NEW.provider) = 'shopify'
     AND LOWER(NEW.topic) IN ('orders/paid', 'orders/updated', 'orders/cancelled', 'orders/fulfilled') THEN
    v_external_order_id := NEW.payload->>'id';
    v_external_order_number := COALESCE(NEW.payload->>'name', NEW.payload->>'order_number');
    IF jsonb_typeof(NEW.payload->'line_items') = 'array' THEN
      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.payload->'line_items') item
        WHERE COALESCE((item->>'quantity')::INTEGER, 0) > 0
          AND LOWER(COALESCE(item->>'requires_shipping', 'true')) NOT IN ('false', 'f', '0')
      ) INTO v_is_shippable;
    END IF;
    BEGIN
      v_source_ordered_at := NULLIF(NEW.payload->>'created_at', '')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
      v_source_ordered_at := NULL;
    END;

    SELECT c.id
    INTO v_channel_id
    FROM channels.channels c
    LEFT JOIN channels.channel_connections cc ON cc.channel_id = c.id
    WHERE c.provider = 'shopify'
      AND (
        (NEW.source_domain IS NOT NULL AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(NEW.source_domain)))
        OR c.is_default = 1
      )
    ORDER BY CASE
      WHEN NEW.source_domain IS NOT NULL AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(NEW.source_domain)) THEN 0
      ELSE 1
    END, c.priority DESC, c.id
    LIMIT 1;
  ELSIF LOWER(NEW.provider) = 'ebay'
        AND LOWER(NEW.topic) LIKE '%order%' THEN
    v_external_order_id := COALESCE(
      NEW.payload #>> '{notification,data,orderId}',
      NEW.payload->>'orderId'
    );
    v_external_order_number := v_external_order_id;
    v_is_shippable := TRUE;

    SELECT c.id
    INTO v_channel_id
    FROM channels.channels c
    WHERE c.provider = 'ebay'
    ORDER BY c.is_default DESC, c.priority DESC, c.id
    LIMIT 1;
  ELSE
    RETURN NEW;
  END IF;

  IF NULLIF(BTRIM(COALESCE(v_external_order_id, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  v_status := CASE
    WHEN NEW.status = 'failed' THEN 'failed'
    WHEN NEW.status = 'processing' THEN 'processing'
    ELSE 'observed'
  END;

  PERFORM oms.record_channel_order_intake(
    p_provider => NEW.provider,
    p_external_order_id => v_external_order_id,
    p_external_order_number => v_external_order_number,
    p_channel_id => v_channel_id,
    p_observation_method => 'webhook',
    p_source_domain => NEW.source_domain,
    p_source_inbox_id => NEW.id,
    p_source_event_id => NEW.event_id,
    p_raw_payload => NEW.payload,
    p_is_shippable => v_is_shippable,
    p_status => v_status,
    p_last_error => NEW.last_error,
    p_source_ordered_at => v_source_ordered_at,
    p_observed_at => COALESCE(NEW.first_received_at, NEW.created_at, NOW()),
    p_increment_observation => TG_OP = 'INSERT'
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_order_intake_from_webhook ON oms.webhook_inbox;
CREATE TRIGGER channel_order_intake_from_webhook
AFTER INSERT OR UPDATE OF status, last_error, processed_at ON oms.webhook_inbox
FOR EACH ROW EXECUTE FUNCTION oms.capture_order_webhook_intake();

CREATE OR REPLACE FUNCTION oms.capture_shopify_raw_order_intake()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_channel_id INTEGER;
  v_source_ordered_at TIMESTAMPTZ;
BEGIN
  SELECT c.id
  INTO v_channel_id
  FROM channels.channels c
  LEFT JOIN channels.channel_connections cc ON cc.channel_id = c.id
  WHERE c.provider = 'shopify'
    AND (
      (NEW.shop_domain IS NOT NULL AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(NEW.shop_domain)))
      OR c.is_default = 1
    )
  ORDER BY CASE
    WHEN NEW.shop_domain IS NOT NULL AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(NEW.shop_domain)) THEN 0
    ELSE 1
  END, c.priority DESC, c.id
  LIMIT 1;

  v_source_ordered_at := COALESCE(NEW.order_date, NEW.created_at, NOW());

  PERFORM oms.record_channel_order_intake(
    p_provider => 'shopify',
    p_external_order_id => NEW.id,
    p_external_order_number => NEW.order_number,
    p_channel_id => v_channel_id,
    p_observation_method => 'shopify_raw',
    p_source_domain => NEW.shop_domain,
    p_raw_payload => to_jsonb(NEW),
    p_status => 'observed',
    p_source_ordered_at => v_source_ordered_at,
    p_increment_observation => TRUE
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_order_intake_from_shopify_raw ON public.shopify_orders;
CREATE TRIGGER channel_order_intake_from_shopify_raw
AFTER INSERT OR UPDATE ON public.shopify_orders
FOR EACH ROW EXECUTE FUNCTION oms.capture_shopify_raw_order_intake();

CREATE OR REPLACE FUNCTION oms.refresh_shopify_intake_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id TEXT;
  v_line_items JSONB;
  v_is_shippable BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id), '[]'::JSONB),
         COALESCE(BOOL_OR(
           COALESCE(item.quantity, 0) > 0
           AND LOWER(COALESCE(item.requires_shipping::TEXT, 'true')) NOT IN ('false', 'f', '0')
         ), FALSE)
  INTO v_line_items, v_is_shippable
  FROM public.shopify_order_items item
  WHERE item.order_id = v_order_id;

  UPDATE oms.channel_order_intakes
  SET raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::JSONB), '{line_items}', v_line_items, TRUE),
      is_shippable = v_is_shippable,
      updated_at = NOW()
  WHERE provider = 'shopify'
    AND external_order_id = split_part(v_order_id, '/', -1);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_order_intake_from_shopify_lines ON public.shopify_order_items;
CREATE TRIGGER channel_order_intake_from_shopify_lines
AFTER INSERT OR UPDATE OR DELETE ON public.shopify_order_items
FOR EACH ROW EXECUTE FUNCTION oms.refresh_shopify_intake_lines();

CREATE OR REPLACE FUNCTION oms.capture_oms_order_intake()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider TEXT;
BEGIN
  SELECT provider INTO v_provider
  FROM channels.channels
  WHERE id = NEW.channel_id;

  PERFORM oms.record_channel_order_intake(
    p_provider => COALESCE(v_provider, 'unknown'),
    p_external_order_id => NEW.external_order_id,
    p_external_order_number => NEW.external_order_number,
    p_channel_id => NEW.channel_id,
    p_observation_method => 'oms_ingest',
    p_raw_payload => NEW.raw_payload,
    p_status => 'ingested',
    p_oms_order_id => NEW.id,
    p_source_ordered_at => NEW.ordered_at,
    p_observed_at => NEW.created_at,
    p_increment_observation => FALSE,
    p_is_source_observation => FALSE
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_order_intake_from_oms_order ON oms.oms_orders;
CREATE TRIGGER channel_order_intake_from_oms_order
AFTER INSERT ON oms.oms_orders
FOR EACH ROW EXECUTE FUNCTION oms.capture_oms_order_intake();

CREATE OR REPLACE FUNCTION oms.refresh_intake_shippability_from_oms_line()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_order_id BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_order_id := OLD.order_id;
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  UPDATE oms.channel_order_intakes intake
  SET is_shippable = EXISTS (
        SELECT 1
        FROM oms.oms_order_lines line
        WHERE line.order_id = v_order_id
          AND line.quantity > 0
          AND COALESCE(line.requires_shipping, TRUE)
          AND NOT COALESCE(line.gift_card, FALSE)
      ),
      updated_at = NOW()
  WHERE intake.oms_order_id = v_order_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_order_intake_from_oms_lines ON oms.oms_order_lines;
CREATE TRIGGER channel_order_intake_from_oms_lines
AFTER INSERT OR UPDATE OR DELETE ON oms.oms_order_lines
FOR EACH ROW EXECUTE FUNCTION oms.refresh_intake_shippability_from_oms_line();

-- Existing OMS orders establish the authoritative source-to-OMS link.
SELECT oms.record_channel_order_intake(
  p_provider => COALESCE(c.provider, 'unknown'),
  p_external_order_id => oo.external_order_id,
  p_external_order_number => oo.external_order_number,
  p_channel_id => oo.channel_id,
  p_observation_method => 'backfill_oms',
  p_raw_payload => oo.raw_payload,
  p_is_shippable => EXISTS (
    SELECT 1
    FROM oms.oms_order_lines line
    WHERE line.order_id = oo.id
      AND line.quantity > 0
      AND COALESCE(line.requires_shipping, TRUE)
      AND NOT COALESCE(line.gift_card, FALSE)
  ),
  p_status => 'ingested',
  p_oms_order_id => oo.id,
  p_source_ordered_at => oo.ordered_at,
  p_observed_at => oo.created_at,
  p_increment_observation => FALSE,
  p_is_source_observation => oo.raw_payload IS NOT NULL
)
FROM oms.oms_orders oo
LEFT JOIN channels.channels c ON c.id = oo.channel_id
WHERE oo.ordered_at >= TIMESTAMPTZ '2026-07-01 00:00:00+00';

-- Raw Shopify rows preserve source evidence even when OMS ingestion never completed.
SELECT oms.record_channel_order_intake(
  p_provider => 'shopify',
  p_external_order_id => so.id,
  p_external_order_number => so.order_number,
  p_channel_id => COALESCE(domain_channel.id, default_channel.id),
  p_observation_method => 'backfill_shopify_raw',
  p_source_domain => so.shop_domain,
  p_raw_payload => to_jsonb(so) || jsonb_build_object(
    'line_items',
    COALESCE((
      SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
      FROM public.shopify_order_items item
      WHERE item.order_id = so.id
    ), '[]'::JSONB)
  ),
  p_is_shippable => EXISTS (
    SELECT 1
    FROM public.shopify_order_items item
    WHERE item.order_id = so.id
      AND COALESCE(item.quantity, 0) > 0
      AND LOWER(COALESCE(item.requires_shipping::TEXT, 'true')) NOT IN ('false', 'f', '0')
  ),
  p_status => 'observed',
  p_source_ordered_at => COALESCE(so.order_date, so.created_at),
  p_observed_at => so.created_at,
  p_increment_observation => FALSE
)
FROM public.shopify_orders so
LEFT JOIN LATERAL (
  SELECT c.id
  FROM channels.channels c
  JOIN channels.channel_connections cc ON cc.channel_id = c.id
  WHERE c.provider = 'shopify'
    AND so.shop_domain IS NOT NULL
    AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(so.shop_domain))
  ORDER BY c.priority DESC, c.id
  LIMIT 1
) domain_channel ON TRUE
LEFT JOIN LATERAL (
  SELECT c.id
  FROM channels.channels c
  WHERE c.provider = 'shopify'
  ORDER BY c.is_default DESC, c.priority DESC, c.id
  LIMIT 1
) default_channel ON TRUE
WHERE COALESCE(so.order_date, so.created_at) >= TIMESTAMPTZ '2026-07-01 00:00:00+00';

-- Preserve historical order webhooks that were received before this ledger existed.
SELECT oms.record_channel_order_intake(
  p_provider => wi.provider,
  p_external_order_id => CASE
    WHEN LOWER(wi.provider) = 'shopify' THEN wi.payload->>'id'
    ELSE COALESCE(wi.payload #>> '{notification,data,orderId}', wi.payload->>'orderId')
  END,
  p_external_order_number => CASE
    WHEN LOWER(wi.provider) = 'shopify' THEN COALESCE(wi.payload->>'name', wi.payload->>'order_number')
    ELSE COALESCE(wi.payload #>> '{notification,data,orderId}', wi.payload->>'orderId')
  END,
  p_channel_id => provider_channel.id,
  p_observation_method => 'backfill_webhook',
  p_source_domain => wi.source_domain,
  p_source_inbox_id => wi.id,
  p_source_event_id => wi.event_id,
  p_raw_payload => wi.payload,
  p_is_shippable => CASE
    WHEN LOWER(wi.provider) = 'ebay' THEN TRUE
    WHEN jsonb_typeof(wi.payload->'line_items') = 'array' THEN EXISTS (
      SELECT 1
      FROM jsonb_array_elements(wi.payload->'line_items') item
      WHERE COALESCE((item->>'quantity')::INTEGER, 0) > 0
        AND LOWER(COALESCE(item->>'requires_shipping', 'true')) NOT IN ('false', 'f', '0')
    )
    ELSE NULL
  END,
  p_status => CASE WHEN wi.status = 'failed' THEN 'failed' ELSE 'observed' END,
  p_last_error => wi.last_error,
  p_observed_at => COALESCE(wi.first_received_at, wi.created_at),
  p_increment_observation => FALSE
)
FROM oms.webhook_inbox wi
LEFT JOIN LATERAL (
  SELECT c.id
  FROM channels.channels c
  LEFT JOIN channels.channel_connections cc ON cc.channel_id = c.id
  WHERE c.provider = LOWER(wi.provider)
    AND (
      LOWER(wi.provider) <> 'shopify'
      OR wi.source_domain IS NULL
      OR LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(wi.source_domain))
      OR c.is_default = 1
    )
  ORDER BY CASE
    WHEN LOWER(wi.provider) = 'shopify'
      AND wi.source_domain IS NOT NULL
      AND LOWER(BTRIM(cc.shop_domain)) = LOWER(BTRIM(wi.source_domain)) THEN 0
    ELSE 1
  END, c.is_default DESC, c.priority DESC, c.id
  LIMIT 1
) provider_channel ON TRUE
WHERE (
  (
    LOWER(wi.provider) = 'shopify'
    AND LOWER(wi.topic) IN ('orders/paid', 'orders/updated', 'orders/cancelled', 'orders/fulfilled')
    AND NULLIF(wi.payload->>'id', '') IS NOT NULL
  ) OR (
    LOWER(wi.provider) = 'ebay'
    AND LOWER(wi.topic) LIKE '%order%'
    AND NULLIF(COALESCE(wi.payload #>> '{notification,data,orderId}', wi.payload->>'orderId'), '') IS NOT NULL
  )
)
AND COALESCE(wi.first_received_at, wi.created_at) >= TIMESTAMPTZ '2026-07-01 00:00:00+00';
