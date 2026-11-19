/**
 * The release-time conversion of a vendor's saved selection rules into one-time picks (step 1 plan S2-5,
 * PR B, PLAN-B v4.1 §6 steps 4 and 7), as exported SQL text. The migration
 * `migrations/*_dropship_vendor_selected_variants.sql` contains each constant verbatim (pinned by
 * `__tests__/unit/dropship-selection-picks-migration-text.test.ts`), so:
 * - the conversion follow-up (§11.2) reads the very same per-rule match as a column of each catalog row
 *   (FIDELITY-1), and repairs only where it and the TypeScript matcher disagree on that row;
 * - reduced PostgreSQL fixtures install the same picks triggers production has (V33).
 *
 * Nothing here runs a query. This module names the frozen rules table on purpose (V5: the static guard
 * allows it): the rules are the conversion's input.
 */

/**
 * The code points `String.prototype.trim` removes (ECMAScript WhiteSpace and LineTerminator: TAB, LF, VT,
 * FF, CR, every Unicode Space_Separator, LS, PS and the BOM), as the body of a PostgreSQL regular-expression
 * bracket. Each is a `\uXXXX` escape, never the character itself, so the SQL text stays ASCII. The unit text
 * test proves this list equals what `trim()` removes over every code point.
 */
export const JS_TRIM_CHARACTER_CLASS =
  "\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006"
  + "\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF";

/**
 * The SQL twin of `normalizeCatalogCategory` (catalog-exposure.ts): `trim()`, then `toLowerCase()`, and an
 * empty result is no category. HYPOTHESIS A10: PostgreSQL `lower()` equals JavaScript `toLowerCase()` for
 * every production category name (ASCII agrees; collation INSUFFICIENT EVIDENCE); the follow-up repairs any
 * row where they differ.
 */
function normalizedCategorySql(column: string): string {
  return `NULLIF(lower(regexp_replace(${column}, '^[${JS_TRIM_CHARACTER_CLASS}]+|[${JS_TRIM_CHARACTER_CLASS}]+$', '', 'g')), '')`;
}

/**
 * Whether one vendor rule `r` matches the size `pv` of the product `p`: the SQL twin of
 * `dropshipCatalogRuleMatchesVariant` (catalog-exposure.ts). Attribute-only, no time, no exposure. The
 * category is the products' text column `p.category`, the one every evaluator reads (SAFETY-11). Every branch
 * is true or false, never NULL: a rule without its target matches nothing. The caller binds `r`, `p` and `pv`.
 */
export const SELECTION_RULE_MATCH_SQL = `CASE r.scope_type
    WHEN 'catalog' THEN true
    WHEN 'product_line' THEN EXISTS (SELECT 1 FROM catalog.product_line_products plp
      WHERE plp.product_id = p.id AND plp.product_line_id = r.product_line_id)
    WHEN 'category' THEN COALESCE(${normalizedCategorySql("r.category")}
      = ${normalizedCategorySql("p.category")}, false)
    WHEN 'product' THEN COALESCE(r.product_id = p.id, false)
    WHEN 'variant' THEN COALESCE(r.product_variant_id = pv.id, false)
    ELSE false
  END`;

/**
 * Every (vendor, size) one of the vendor's active rules of `action` matches, as `vendor_id, product_variant_id, named`
 * rows, with SELECTION_RULE_MATCH_SQL deciding each (rule, size) pair. Only the pairs a rule can match are tried
 * (MIG-4): a `variant` rule against the size it names, a `product` rule against its product's sizes (both by equi-join),
 * every other scope against every size. A `variant` or `product` rule matches no other size (the fragment's own
 * branches), and an unknown scope matches nothing, so the rows are exactly the pairs some such rule matches. `named` is
 * true on the rows of a `variant` rule: it names the size. A pair may appear more than once.
 */
function matchedRulePairsSql(action: "include" | "exclude"): string {
  return `  SELECT r.vendor_id, pv.id AS product_variant_id, true AS named
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.product_variants pv ON pv.id = r.product_variant_id
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type = 'variant'
    AND ${SELECTION_RULE_MATCH_SQL}
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  JOIN catalog.products p ON p.id = r.product_id
  JOIN catalog.product_variants pv ON pv.product_id = p.id
  WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type = 'product'
    AND ${SELECTION_RULE_MATCH_SQL}
  UNION ALL
  SELECT r.vendor_id, pv.id, false
  FROM dropship.dropship_vendor_selection_rules r
  CROSS JOIN catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
  WHERE r.is_active = true AND r.action = '${action}' AND r.scope_type NOT IN ('variant', 'product')
    AND ${SELECTION_RULE_MATCH_SQL}`;
}

/**
 * The current matcher inputs of one catalog size `pv` of product `p` that SELECTION_RULE_MATCH_SQL and the TypeScript
 * matcher read besides the size id: its product, the products' text category and the product's lines, in line order.
 */
export const SIZE_MATCH_INPUTS_SQL = {
  productLineIds: "ARRAY(SELECT plp.product_line_id FROM catalog.product_line_products plp WHERE plp.product_id = p.id ORDER BY plp.product_line_id)",
} as const;

/**
 * Every Card Shellz size's matcher inputs as the conversion read them (FUP-1), written by a data-modifying WITH
 * of the conversion's own statement: every part of one statement reads one snapshot, so these rows are exactly the
 * inputs the conversion decided from, even when a product, category or product line edit commits while the file runs
 * (the catalog is not locked during the read). The follow-up repairs only a size whose inputs are still these.
 */
const CONVERSION_SIZES_CTE = `WITH conversion_sizes AS (
  INSERT INTO dropship.dropship_selection_conversion_sizes (product_variant_id, product_id, category, product_line_ids)
  SELECT pv.id, p.id, p.category, ${SIZE_MATCH_INPUTS_SQL.productLineIds}
  FROM catalog.product_variants pv
  JOIN catalog.products p ON p.id = pv.product_id
)`;

/**
 * The conversion (§6 step 4): for every vendor with an active include rule and every Card Shellz size of a
 * product, one row when some active include rule of the vendor matches the size and no active exclude rule
 * does: the rule part of A's evaluator, order-free (VS:88-117). The same statement records what it read
 * (CONVERSION_SIZES_CTE). No exposure, sellable or active filter, on
 * purpose: exposure depends on time and stays a read-time filter, so the picks equal the rules for every size
 * at every time. Each (vendor, size) pair is produced once (the GROUP BY) and lands in the keyed temp table
 * `selection_conversion` the migration creates (its primary key makes the ON CONFLICT real, SAFETY-2); the
 * source is decided in the same row: a size an active variant include names is `legacy_variant_rule`.
 *
 * Set-based by rule (MIG-4): the matched include pairs less the matched exclude pairs (a hash or merge anti-join on
 * the pair), so the work grows with the pairs the rules match, not with sizes × rules. Stage 1 saved one variant rule
 * per ticked size, up to 500 per vendor; testing every rule against every size of every converted vendor held the
 * revisions for 60 s on the 30,000-size fixture with such vendors (BUILD-NOTES "Review round 1").
 */
export const SELECTION_RULE_CONVERSION_SQL = `${CONVERSION_SIZES_CTE}
INSERT INTO selection_conversion (vendor_id, product_variant_id, source)
SELECT m.vendor_id, m.product_variant_id,
  CASE WHEN bool_or(m.named) THEN 'legacy_variant_rule' ELSE 'legacy_broad_rule' END
FROM (
${matchedRulePairsSql("include")}
) m
WHERE NOT EXISTS (
  SELECT 1 FROM (
${matchedRulePairsSql("exclude")}
  ) x
  WHERE x.vendor_id = m.vendor_id AND x.product_variant_id = m.product_variant_id
)
GROUP BY m.vendor_id, m.product_variant_id
ON CONFLICT (vendor_id, product_variant_id) DO NOTHING;`;

/**
 * The picks table's publication selection wiring (§6 step 7): the vendor overrides' wiring of 0743 (manifest
 * row 'variant', gated; functions 0743:63-102): every statement that adds, removes or moves a pick takes the
 * global selection gate, and the product of every changed size is re-planned through inventory's own
 * `invalidate_publication_selection_product`. Created after the conversion's copy, so the migration takes no
 * gate and queues no work.
 *
 * One difference from the overrides, measured at the final gate (R4; v3 Risk 2's statement-level lever): an
 * INSERT or DELETE re-plans each product it touched ONCE, in product order, from the statement's transition
 * table, instead of once per row. A save or tidy of 10,000 picks (2,000 products of 5 sizes) otherwise made
 * 10,000 calls inside the gate, each scanning every mapping head, and held the gate over its 5 s budget. The
 * same products are invalidated in the same transaction either way (the work row's revision moves once per
 * transaction, 0743:55-56). An UPDATE of a pick's vendor or size keeps 0743's row function, which skips a row
 * whose watched columns did not change; PostgreSQL allows no transition table on a column-list UPDATE trigger.
 */
export const PICKS_SELECTION_TRIGGERS_SQL = `CREATE FUNCTION dropship.invalidate_picked_products() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
  FOR EACH STATEMENT EXECUTE FUNCTION dropship.invalidate_picked_products();`;
