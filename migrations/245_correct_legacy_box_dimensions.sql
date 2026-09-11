-- The owner confirmed that Box LxWxH names are the intended INNER inch sizes.
-- Correct only the matching BOX-LxWxH catalog family whose stored values match
-- the old whole-mm conversion (or an already-correct axis). Never derive outer
-- dimensions, change packaging eligibility, or rewrite historical parcel plans.
DO $$
DECLARE
  original shipping.box_catalog%ROWTYPE;
  corrected shipping.box_catalog%ROWTYPE;
  inches text[];
  target_length numeric;
  target_width numeric;
  target_height numeric;
  correction_id uuid;
  changed_count integer := 0;
BEGIN
  -- Same lock as the catalog command boundary: serialize with admin edits.
  PERFORM pg_advisory_xact_lock(hashtext('shipping-shared-config'));
  FOR original IN
    SELECT b.* FROM shipping.box_catalog b
    WHERE b.kind = 'box'
      AND b.name ~ '^Box [0-9]{1,5}(\.[0-9]{1,3})?x[0-9]{1,5}(\.[0-9]{1,3})?x[0-9]{1,5}(\.[0-9]{1,3})?$'
    ORDER BY b.id FOR UPDATE
  LOOP
    inches := regexp_match(original.name,
      '^Box ([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)x([0-9]+(?:\.[0-9]+)?)$');
    IF original.code <> 'BOX-' || inches[1] || 'x' || inches[2] || 'x' || inches[3] THEN
      RAISE NOTICE 'Box dimension correction skipped id %: name/code disagree', original.id;
      CONTINUE;
    END IF;
    target_length := inches[1]::numeric * 25.4;
    target_width := inches[2]::numeric * 25.4;
    target_height := inches[3]::numeric * 25.4;
    IF LEAST(target_length, target_width, target_height) <= 0 THEN
      RAISE NOTICE 'Box dimension correction skipped id %: nonpositive named size', original.id;
      CONTINUE;
    END IF;
    correction_id := md5('245_correct_legacy_box_dimensions:' || original.id)::uuid;
    IF EXISTS (SELECT 1 FROM shipping.configuration_commands WHERE command_id = correction_id) THEN
      CONTINUE;
    END IF;
    IF original.length_mm NOT IN (round(target_length), target_length)
      OR original.width_mm NOT IN (round(target_width), target_width)
      OR original.height_mm NOT IN (round(target_height), target_height) THEN
      RAISE NOTICE 'Box dimension correction skipped id %: measurements differ from legacy conversion', original.id;
      CONTINUE;
    END IF;
    IF original.length_mm = target_length AND original.width_mm = target_width
      AND original.height_mm = target_height THEN
      CONTINUE;
    END IF;
    IF original.outer_length_mm < target_length OR original.outer_width_mm < target_width
      OR original.outer_height_mm < target_height THEN
      RAISE NOTICE 'Box dimension correction skipped id %: measured outer dimensions conflict', original.id;
      CONTINUE;
    END IF;
    UPDATE shipping.box_catalog SET
      length_mm = target_length, width_mm = target_width, height_mm = target_height,
      configuration_revision = configuration_revision + 1,
      updated_at = transaction_timestamp()
    WHERE id = original.id RETURNING * INTO corrected;

    -- Immutable before/after evidence, committed atomically with the correction.
    INSERT INTO shipping.configuration_commands
      (command_id, request_hash, actor_id, resource_key, before_state, after_state, created_at)
    VALUES (
      correction_id,
      encode(sha256(convert_to(jsonb_build_object('id', original.id,
        'lengthMm', target_length, 'widthMm', target_width, 'heightMm', target_height)::text, 'UTF8')), 'hex'),
      'migration:245_correct_legacy_box_dimensions', 'box:' || original.id,
      to_jsonb(original), jsonb_build_object('box', to_jsonb(corrected),
        'reason', 'Owner-confirmed box name defines inner inch dimensions'), transaction_timestamp()
    );
    changed_count := changed_count + 1;
  END LOOP;
  RAISE NOTICE 'Corrected legacy inner dimensions for % catalog boxes', changed_count;
END $$;
