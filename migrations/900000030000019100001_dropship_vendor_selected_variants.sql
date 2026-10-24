-- dropship_vendor_selected_variants: one-time picks replace a vendor's saved
-- selection rules (step 1 plan S2-5, PR B; PLAN-B v4.1 §6).
--
-- A vendor's selection becomes a set of Card Shellz sizes (a "pick" each,
-- dropship_vendor_selected_variants). Every vendor's active rules are turned,
-- here, into the sizes they match today, sellable or not, offered or not: some
-- active include rule matches the size and no active exclude rule does, the
-- rule part of the evaluator the previous release runs, with no time in it.
-- The rules are then frozen (every write raises
-- DROPSHIP_SELECTION_RULES_RETIRED, which the previous release answers with a
-- 410), and stay active, so a process of the previous release that still
-- reads them decides exactly what the picks decide, for every size and every
-- time, on the catalog the conversion read, less every size deleted before
-- the sizes lock below (a product, category or product line edit committed in
-- between is not reflected, like any edit after the commit: a pick is a size,
-- not a rule; the follow-up never repairs such a size, R19).
--
-- What the file writes: one 'picks_backfill' revision per vendor with an
-- active rule (its key carries the highest revision id read under the lock
-- below, so no key a vendor ever sent can collide with it), the picks, one
-- conversion record per vendor with an active rule of a broad scope (for the
-- follow-up and the one notice that come with the first B process), every
-- size's matcher inputs as the conversion read them (for the follow-up), and
-- one audit row per converted vendor naming the rules read and the sizes picked.
-- The selection revisions gain the request kind, the pick count and the
-- stored answer; every existing revision reads as before ('rules_replace',
-- no count, no answer). Two empty tables are new for the new-items notice.
--
-- Lock order. The first two statements lock the two tables a rules save
-- writes, in the save's order (dropship-selection-atp.repository.ts:
-- replaceSelectionRules): the revisions ACCESS EXCLUSIVE, which the ALTER
-- TABLE below needs anyway, then the rules SHARE ROW EXCLUSIVE, which the
-- freeze trigger needs. No later statement needs a stronger lock on either,
-- so no lock is upgraded on them. A save that already holds its replay read
-- or its revision insert is ahead of this file in the lock queue, finishes,
-- and is converted; a later save waits, then meets the freeze. While this file
-- runs, rules reads go through and revisions reads wait until commit.
--
-- The heavy read (the conversion) goes first, into a keyed temporary table,
-- while catalog writers go on; the new tables are created without foreign
-- keys. Then the Card Shellz sizes are locked SHARE ROW EXCLUSIVE (until
-- commit; the lock the size foreign key takes anyway) and every size deleted
-- since the read is dropped, so the copy and the foreign key see the same
-- sizes: a catalog write waits from that lock to commit, and the file waits
-- there for a long catalog writer while it holds nothing of the vendors. From
-- the backfill revisions on, each one's vendor foreign key holds that vendor's
-- row FOR KEY SHARE; the tables are filled, and only then do the foreign keys
-- take SHARE ROW EXCLUSIVE on the vendors (until commit), so any other vendor
-- write waits only from that step to commit. The picks'
-- publication selection triggers (0743's overrides wiring) come after the
-- copy, so this file takes no selection gate and queues no work. The picks
-- have no sellable-size trigger: they are the rule match for every size, and
-- every reader keeps its sellable filter.
--
-- No statement raises by design: the file has no precondition, and a size
-- the catalog deletes while it runs is dropped before the copy, never left for
-- the foreign key check. Its only failures are the executor's retried lock
-- timeouts, deadlocks and serialization failures (migration-executor.ts); a
-- failed attempt rolls back whole and the retry, under the same locks, writes
-- the same picks.
--
-- This file is applied once by the release runner, in one transaction; it is
-- not written to be re-run (the runner never re-runs an applied file).

LOCK TABLE dropship.dropship_vendor_selection_rule_set_revisions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE dropship.dropship_vendor_selection_rules IN SHARE ROW EXCLUSIVE MODE;

-- What a revision records (§6 step 1). rule_count stays NOT NULL: a picks
-- change and a follow-up write 0, a backfill the number of active rules read.
ALTER TABLE dropship.dropship_vendor_selection_rule_set_revisions
  ADD COLUMN request_kind varchar(30) NOT NULL DEFAULT 'rules_replace'
    CONSTRAINT dropship_selection_rule_rev_kind_chk
    CHECK (request_kind IN ('rules_replace', 'picks_change', 'picks_backfill', 'picks_conversion_followup')),
  ADD COLUMN pick_count integer
    CONSTRAINT dropship_selection_rule_rev_pick_count_chk CHECK (pick_count IS NULL OR pick_count >= 0),
  -- The original answer of a picks change, for an exact replay.
  ADD COLUMN result jsonb;

-- Every size's matcher inputs as the conversion reads them (FUP-1): its
-- product, the products' text category and the product's lines. Written by
-- the conversion's own statement below, so by the same snapshot, even when a
-- catalog edit commits while this file runs; read only by the conversion
-- follow-up, which repairs a size only while its inputs are still these.
-- Release history: no foreign key, never written again.
CREATE TABLE dropship.dropship_selection_conversion_sizes (
  product_variant_id integer PRIMARY KEY,
  product_id integer NOT NULL,
  category text,
  product_line_ids integer[] NOT NULL
);

-- The conversion (§6 step 4), one row per (vendor, size): the key makes its
-- ON CONFLICT real, and the source is decided in the same row. Each rule is
-- tried only against the sizes it can match (a variant rule its size, a
-- product rule its product's sizes, a broad rule every size), so the read
-- grows with the pairs the rules match, not with sizes times rules.
CREATE TEMP TABLE selection_conversion (
  vendor_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  source varchar(30) NOT NULL,
  PRIMARY KEY (vendor_id, product_variant_id)
) ON COMMIT DROP;
WITH conversion_sizes AS (
  INSERT INTO dropship.dropship_selection_conversion_sizes (product_variant_id, product_id, category, product_line_ids)
  SELECT pv.id, p.id, p.category, ARRAY(SELECT plp.product_line_id FROM catalog.product_line_products plp WHERE plp.product_id = p.id ORDER BY plp.product_line_id)
  FROM catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
)
INSERT INTO selection_conversion (vendor_id, product_variant_id, source)
SELECT m.vendor_id, m.product_variant_id,
  CASE WHEN bool_or(m.named) THEN 'legacy_variant_rule' ELSE 'legacy_broad_rule' END
FROM (
  SELECT r.vendor_id, pv.id AS product_variant_id, true AS named
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.product_variants pv ON pv.id = r.product_variant_id
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = 'include' AND r.scope_type = 'variant'
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.products p ON p.id = r.product_id
  JOIN catalog.product_variants pv ON pv.product_id = p.id
  WHERE r.is_active = true AND r.action = 'include' AND r.scope_type = 'product'
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  CROSS JOIN catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = 'include' AND r.scope_type NOT IN ('variant', 'product')
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
) m
WHERE NOT EXISTS (
  SELECT 1 FROM (
  SELECT r.vendor_id, pv.id AS product_variant_id, true AS named
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.product_variants pv ON pv.id = r.product_variant_id
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = 'exclude' AND r.scope_type = 'variant'
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.products p ON p.id = r.product_id
  JOIN catalog.product_variants pv ON pv.product_id = p.id
  WHERE r.is_active = true AND r.action = 'exclude' AND r.scope_type = 'product'
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  CROSS JOIN catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = 'exclude' AND r.scope_type NOT IN ('variant', 'product')
    AND CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(NULLIF(lower(regexp_replace(r.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), '')
      = NULLIF(lower(regexp_replace(p.category, '^[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$', '', 'g')), ''), false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END
  ) x
  WHERE x.vendor_id = m.vendor_id AND x.product_variant_id = m.product_variant_id
)
GROUP BY m.vendor_id, m.product_variant_id
ON CONFLICT (vendor_id, product_variant_id) DO NOTHING;

-- The picks (§6 step 2). Foreign keys added after the copy, below.
CREATE TABLE dropship.dropship_vendor_selected_variants (
  vendor_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  -- The revision that wrote the pick.
  revision_id integer NOT NULL,
  source varchar(30) NOT NULL
    CONSTRAINT dropship_vendor_selected_variants_source_chk
    CHECK (source IN ('vendor', 'legacy_variant_rule', 'legacy_broad_rule', 'conversion_repair')),
  -- History only: no reader decides anything from it.
  selected_at timestamptz NOT NULL,
  PRIMARY KEY (vendor_id, product_variant_id)
);
CREATE INDEX dropship_vendor_selected_variants_variant_idx
  ON dropship.dropship_vendor_selected_variants(product_variant_id);

-- The conversion records (§6 step 5): one per vendor with an active rule of a
-- broad scope. A record waiting for its follow-up or its notice is in the
-- partial index; one that needs review is not, so it is never retried.
CREATE TABLE dropship.dropship_selection_conversions (
  vendor_id integer PRIMARY KEY,
  backfill_revision_id integer NOT NULL,
  broad_rule_ids integer[] NOT NULL,
  converted_at timestamptz NOT NULL,
  followup_state varchar(20) NOT NULL
    CONSTRAINT dropship_selection_conversions_followup_state_chk
    CHECK (followup_state IN ('pending', 'done', 'requires_review')),
  followup_at timestamptz,
  followup_failures integer NOT NULL DEFAULT 0
    CONSTRAINT dropship_selection_conversions_followup_failures_chk CHECK (followup_failures >= 0),
  notice_state varchar(20) NOT NULL
    CONSTRAINT dropship_selection_conversions_notice_state_chk
    CHECK (notice_state IN ('not_needed', 'pending', 'sent', 'requires_review')),
  notice_at timestamptz,
  -- The structured code of a permanent failure.
  last_error_code varchar(80),
  CONSTRAINT dropship_selection_conversions_followup_done_chk CHECK ((followup_state = 'done') = (followup_at IS NOT NULL)),
  CONSTRAINT dropship_selection_conversions_notice_sent_chk CHECK ((notice_state = 'sent') = (notice_at IS NOT NULL)),
  CONSTRAINT dropship_selection_conversions_review_code_chk
    CHECK ((followup_state = 'requires_review' OR notice_state = 'requires_review') = (last_error_code IS NOT NULL))
);
CREATE INDEX dropship_selection_conversions_open_idx ON dropship.dropship_selection_conversions(vendor_id)
  WHERE followup_state = 'pending' OR notice_state = 'pending';

-- The sizes, from here to commit: no size is added or deleted until the file
-- commits. The prune is a statement of its own after the lock, so its snapshot
-- sees every delete committed since the conversion's read; the pick counts,
-- the copy, the audit and the size foreign key below all read the pruned rows.
LOCK TABLE catalog.product_variants IN SHARE ROW EXCLUSIVE MODE;
DELETE FROM selection_conversion c
WHERE NOT EXISTS (SELECT 1 FROM catalog.product_variants pv WHERE pv.id = c.product_variant_id);

-- One backfill revision per vendor with an active rule (§6 step 3). The key's
-- revision id is read once, under the revisions lock above.
INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
  (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, created_at, request_kind, pick_count)
SELECT r.vendor_id,
  'legacy-picks-backfill:' || r.vendor_id || ':' || head.max_id,
  repeat('0', 64), 'system', NULL, count(*)::integer, now(), 'picks_backfill',
  (SELECT count(*)::integer FROM selection_conversion c WHERE c.vendor_id = r.vendor_id)
FROM dropship.dropship_vendor_selection_rules r
CROSS JOIN (
  SELECT COALESCE(max(id), 0) AS max_id FROM dropship.dropship_vendor_selection_rule_set_revisions
) head
WHERE r.is_active = true
GROUP BY r.vendor_id, head.max_id
ORDER BY r.vendor_id;

-- The copy into the picks, each under its vendor's backfill revision (the
-- only 'picks_backfill' revisions there are).
INSERT INTO dropship.dropship_vendor_selected_variants (vendor_id, product_variant_id, revision_id, source, selected_at)
SELECT c.vendor_id, c.product_variant_id, rev.id, c.source, now()
FROM selection_conversion c
JOIN dropship.dropship_vendor_selection_rule_set_revisions rev
  ON rev.vendor_id = c.vendor_id AND rev.request_kind = 'picks_backfill'
ORDER BY c.vendor_id, c.product_variant_id;

-- The conversion records: the notice is due when a broad rule was an include.
INSERT INTO dropship.dropship_selection_conversions
  (vendor_id, backfill_revision_id, broad_rule_ids, converted_at, followup_state, notice_state)
SELECT r.vendor_id, rev.id, array_agg(r.id ORDER BY r.id), now(), 'pending',
  CASE WHEN bool_or(r.action = 'include') THEN 'pending' ELSE 'not_needed' END
FROM dropship.dropship_vendor_selection_rules r
JOIN dropship.dropship_vendor_selection_rule_set_revisions rev
  ON rev.vendor_id = r.vendor_id AND rev.request_kind = 'picks_backfill'
WHERE r.is_active = true AND r.scope_type <> 'variant'
GROUP BY r.vendor_id, rev.id
ORDER BY r.vendor_id;

-- One audit row per converted vendor (§6 step 6): the revision, the active
-- rules read, the picks by source and every picked size, sorted. A vendor's
-- picks are exactly its backfill revision's (the copy above); the vendor
-- term lets each read use the picks' key instead of scanning every pick.
INSERT INTO dropship.dropship_audit_events
  (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
SELECT rev.vendor_id, 'dropship_vendor_selection_ruleset', rev.id::text, 'vendor_selection_picks_backfilled',
  'system', NULL, 'info',
  jsonb_build_object(
    'revisionId', rev.id,
    'ruleIds', (SELECT jsonb_agg(r.id ORDER BY r.id) FROM dropship.dropship_vendor_selection_rules r
      WHERE r.vendor_id = rev.vendor_id AND r.is_active = true),
    'pickCountsBySource', jsonb_build_object(
      'legacy_variant_rule', (SELECT count(*) FROM dropship.dropship_vendor_selected_variants s
        WHERE s.vendor_id = rev.vendor_id AND s.revision_id = rev.id AND s.source = 'legacy_variant_rule'),
      'legacy_broad_rule', (SELECT count(*) FROM dropship.dropship_vendor_selected_variants s
        WHERE s.vendor_id = rev.vendor_id AND s.revision_id = rev.id AND s.source = 'legacy_broad_rule')),
    'pickedVariantIds', COALESCE((SELECT jsonb_agg(s.product_variant_id ORDER BY s.product_variant_id)
      FROM dropship.dropship_vendor_selected_variants s WHERE s.vendor_id = rev.vendor_id AND s.revision_id = rev.id), '[]'::jsonb)),
  now()
FROM dropship.dropship_vendor_selection_rule_set_revisions rev
WHERE rev.request_kind = 'picks_backfill'
ORDER BY rev.vendor_id;

-- The foreign keys, after the copy: one set-based check each (the sizes and
-- the revisions are already locked above; only the vendors are newly locked
-- here). A size Card Shellz deletes takes its picks with it (the catalog
-- hard-deletes sizes; a listed size stays undeletable by the listing's own
-- key), as the overrides do.
ALTER TABLE dropship.dropship_vendor_selected_variants
  ADD CONSTRAINT dropship_vendor_selected_variants_vendor_fk FOREIGN KEY (vendor_id)
    REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  ADD CONSTRAINT dropship_vendor_selected_variants_variant_fk FOREIGN KEY (product_variant_id)
    REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  ADD CONSTRAINT dropship_vendor_selected_variants_revision_fk FOREIGN KEY (revision_id)
    REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id);
ALTER TABLE dropship.dropship_selection_conversions
  ADD CONSTRAINT dropship_selection_conversions_vendor_fk FOREIGN KEY (vendor_id)
    REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  ADD CONSTRAINT dropship_selection_conversions_revision_fk FOREIGN KEY (backfill_revision_id)
    REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id);

-- The picks' publication selection wiring (§6 step 7), after the copy: 0743's gate, and
-- each product an INSERT or DELETE touched re-planned once per statement (R4).
CREATE FUNCTION dropship.invalidate_picked_products() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE affected integer;
BEGIN
  FOR affected IN SELECT DISTINCT v.product_id FROM changed_picks c
      JOIN catalog.product_variants v ON v.id = c.product_variant_id ORDER BY v.product_id
  LOOP PERFORM inventory.invalidate_publication_selection_product(affected); END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER ac_publication_selection_gate
  BEFORE INSERT OR DELETE OR UPDATE OF vendor_id, product_variant_id ON dropship.dropship_vendor_selected_variants
  FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change();
CREATE TRIGGER publication_selection_invalidation
  AFTER UPDATE OF vendor_id, product_variant_id ON dropship.dropship_vendor_selected_variants
  FOR EACH ROW EXECUTE FUNCTION inventory.notify_publication_selection_change('variant', 'vendor_id,product_variant_id');
CREATE TRIGGER publication_selection_invalidation_added
  AFTER INSERT ON dropship.dropship_vendor_selected_variants REFERENCING NEW TABLE AS changed_picks
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_picked_products();
CREATE TRIGGER publication_selection_invalidation_removed
  AFTER DELETE ON dropship.dropship_vendor_selected_variants REFERENCING OLD TABLE AS changed_picks
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_picked_products();

-- The freeze (§6 step 8): named aa_ so it fires before the rules' existing
-- ac_publication_selection_gate (same-event triggers fire in name order).
CREATE FUNCTION dropship.refuse_selection_rules_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'DROPSHIP_SELECTION_RULES_RETIRED' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER aa_selection_rules_retired
  BEFORE INSERT OR UPDATE OR DELETE ON dropship.dropship_vendor_selection_rules
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.refuse_selection_rules_write();

-- The new-items notice (§6 step 9; written by PR B's arrivals job). An
-- arrival is derived history, like the category marks (0739): no foreign key,
-- and never changed or deleted.
CREATE TABLE dropship.dropship_catalog_arrivals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_variant_id integer NOT NULL,
  product_id integer NOT NULL,
  category_id integer NOT NULL,
  first_seen_at timestamptz NOT NULL,
  baseline boolean NOT NULL,
  CONSTRAINT dropship_catalog_arrivals_variant_category_key UNIQUE (product_variant_id, category_id)
);
CREATE FUNCTION dropship.refuse_catalog_arrival_change() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'DROPSHIP_CATALOG_ARRIVALS_APPEND_ONLY';
END;
$$;
CREATE TRIGGER dropship_catalog_arrivals_append_only
  BEFORE UPDATE OR DELETE ON dropship.dropship_catalog_arrivals
  FOR EACH ROW EXECUTE FUNCTION dropship.refuse_catalog_arrival_change();
CREATE INDEX dropship_catalog_arrivals_category_idx ON dropship.dropship_catalog_arrivals(category_id, id);

-- How far each vendor has seen, and been told of, each category's arrivals.
CREATE TABLE dropship.dropship_vendor_category_notice_marks (
  vendor_id integer NOT NULL
    CONSTRAINT dropship_vendor_category_notice_marks_vendor_fk REFERENCES dropship.dropship_vendors(id),
  category_id integer NOT NULL,
  seen_through_arrival_id bigint NOT NULL
    CONSTRAINT dropship_vendor_category_notice_marks_seen_chk CHECK (seen_through_arrival_id >= 0),
  notified_through_arrival_id bigint NOT NULL
    CONSTRAINT dropship_vendor_category_notice_marks_notified_chk CHECK (notified_through_arrival_id >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (vendor_id, category_id)
);
