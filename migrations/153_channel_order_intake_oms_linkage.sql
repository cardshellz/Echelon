-- Keep the source-intake ledger linked to the authoritative OMS order even
-- when the source observation arrives after that order was created. The
-- original INSERT-only OMS trigger cannot repair that ordering by itself.
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
  v_provider TEXT;
  v_external_order_id TEXT;
  v_status TEXT;
  v_id BIGINT;
  v_match_count INTEGER := 0;
  v_resolved_oms_order_id BIGINT := p_oms_order_id;
  v_resolved_channel_id INTEGER;
  v_resolved_ordered_at TIMESTAMPTZ;
BEGIN
  v_provider := LOWER(BTRIM(COALESCE(p_provider, '')));
  IF v_provider = '' THEN
    RAISE EXCEPTION 'channel order intake requires a provider';
  END IF;

  v_external_order_id := BTRIM(COALESCE(p_external_order_id, ''));
  IF v_provider = 'shopify' THEN
    v_external_order_id := split_part(v_external_order_id, '/', -1);
  END IF;

  IF v_external_order_id = '' THEN
    RAISE EXCEPTION 'channel order intake requires an external order id';
  END IF;

  -- A supplied OMS id is authoritative. Otherwise resolve only an exact
  -- provider/external-id match within the supplied channel. If no channel is
  -- available, accept a provider-wide match only when it is unique.
  IF v_resolved_oms_order_id IS NOT NULL THEN
    SELECT oo.channel_id, oo.ordered_at
    INTO v_resolved_channel_id, v_resolved_ordered_at
    FROM oms.oms_orders oo
    WHERE oo.id = v_resolved_oms_order_id;
  ELSE
    SELECT COUNT(*)::INTEGER,
           MIN(oo.id),
           MIN(oo.channel_id),
           MIN(oo.ordered_at)
    INTO v_match_count,
         v_resolved_oms_order_id,
         v_resolved_channel_id,
         v_resolved_ordered_at
    FROM oms.oms_orders oo
    JOIN channels.channels c ON c.id = oo.channel_id
    WHERE LOWER(c.provider) = v_provider
      AND oo.external_order_id = v_external_order_id
      AND (p_channel_id IS NULL OR oo.channel_id = p_channel_id);

    IF v_match_count <> 1 THEN
      v_resolved_oms_order_id := NULL;
      v_resolved_channel_id := NULL;
      v_resolved_ordered_at := NULL;
    END IF;
  END IF;

  v_status := CASE
    WHEN v_resolved_oms_order_id IS NOT NULL THEN 'ingested'
    WHEN p_status IN ('observed', 'processing', 'ingested', 'failed', 'ignored') THEN p_status
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
    v_provider,
    COALESCE(p_channel_id, v_resolved_channel_id),
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
    COALESCE(p_source_ordered_at, v_resolved_ordered_at),
    CASE WHEN p_is_source_observation THEN COALESCE(p_observed_at, NOW()) END,
    COALESCE(p_observed_at, NOW()),
    COALESCE(p_observed_at, NOW()),
    CASE WHEN v_status = 'processing' THEN NOW() END,
    CASE WHEN v_status = 'ingested' THEN NOW() END,
    CASE WHEN v_status = 'failed' THEN NOW() END,
    v_resolved_oms_order_id,
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
      WHEN COALESCE(channel_order_intakes.oms_order_id, EXCLUDED.oms_order_id) IS NOT NULL
        THEN 'ingested'
      ELSE EXCLUDED.status
    END,
    observation_count = channel_order_intakes.observation_count
      + CASE WHEN p_increment_observation THEN 1 ELSE 0 END,
    attempt_count = channel_order_intakes.attempt_count
      + CASE WHEN EXCLUDED.status = 'failed' THEN 1 ELSE 0 END,
    source_ordered_at = COALESCE(
      channel_order_intakes.source_ordered_at,
      EXCLUDED.source_ordered_at,
      v_resolved_ordered_at
    ),
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
      WHEN COALESCE(channel_order_intakes.oms_order_id, EXCLUDED.oms_order_id) IS NOT NULL
        THEN COALESCE(channel_order_intakes.ingested_at, NOW())
      ELSE channel_order_intakes.ingested_at
    END,
    failed_at = CASE
      WHEN EXCLUDED.status = 'failed'
        AND COALESCE(channel_order_intakes.oms_order_id, EXCLUDED.oms_order_id) IS NULL
        THEN NOW()
      ELSE channel_order_intakes.failed_at
    END,
    oms_order_id = COALESCE(channel_order_intakes.oms_order_id, EXCLUDED.oms_order_id),
    last_error = CASE
      WHEN COALESCE(channel_order_intakes.oms_order_id, EXCLUDED.oms_order_id) IS NOT NULL THEN NULL
      WHEN EXCLUDED.status = 'failed' THEN EXCLUDED.last_error
      ELSE channel_order_intakes.last_error
    END,
    updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Repair every existing unlinked row that has exactly one authoritative OMS
-- match. Rows that are missing or ambiguous are deliberately left untouched
-- so the exception monitor continues to expose them for investigation.
WITH candidate_matches AS (
  SELECT intake.id AS intake_id,
         oo.id AS oms_order_id,
         oo.channel_id,
         oo.ordered_at
  FROM oms.channel_order_intakes intake
  JOIN channels.channels c
    ON LOWER(c.provider) = LOWER(intake.provider)
  JOIN oms.oms_orders oo
    ON oo.channel_id = c.id
   AND oo.external_order_id = intake.external_order_id
  WHERE intake.oms_order_id IS NULL
    AND (intake.channel_id IS NULL OR oo.channel_id = intake.channel_id)
), unambiguous_matches AS (
  SELECT intake_id,
         MIN(oms_order_id) AS oms_order_id,
         MIN(channel_id) AS channel_id,
         MIN(ordered_at) AS ordered_at
  FROM candidate_matches
  GROUP BY intake_id
  HAVING COUNT(*) = 1
)
UPDATE oms.channel_order_intakes intake
SET oms_order_id = matched.oms_order_id,
    channel_id = COALESCE(intake.channel_id, matched.channel_id),
    status = 'ingested',
    source_ordered_at = COALESCE(intake.source_ordered_at, matched.ordered_at),
    ingested_at = COALESCE(intake.ingested_at, NOW()),
    last_error = NULL,
    updated_at = NOW()
FROM unambiguous_matches matched
WHERE intake.id = matched.intake_id;
