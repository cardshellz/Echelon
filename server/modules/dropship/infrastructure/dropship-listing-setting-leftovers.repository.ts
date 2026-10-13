import type { PoolClient } from "pg";
import { LISTING_SETTING_ACTOR_TYPES, LISTING_SETTING_KEY_PATTERN } from "../../../../shared/dropship/listing-setting-values";
import type { ClearSizeLeftoversInput, ClearSizeLeftoversResult } from "../application/dropship-listing-setting-writes";
import {
  LISTING_SETTING_LEFTOVER_FIELDS,
  listingSettingChildKeyPrefix,
  listingSettingsInvariantFailed,
  type ListingSettingLeftoverField,
} from "../domain/listing-setting-values";
import { MAX_LISTING_SETTING_ACTOR_ID_LENGTH, type ListingSettingWriteScope } from "./dropship-listing-setting-shared.repository";

/**
 * Per-size leftover clean-ups (plan PR 9, P17, section 6.6). A size's own
 * policy override, store shelf or main text, left by today's per-size
 * panels, beats the product's and the category's value. When a product or
 * category change touches one of those fields (a value or a reset), every
 * size of the products loses its own row for it, so the change takes effect
 * and nothing "comes back later".
 *
 * - Runs on the listing-settings transaction's client, after the parent
 *   writer and the size prices, with the store lock, the owner rows and
 *   lockCatalog's product locks held (the caller's). It relies on the product
 *   locks, not size locks: a leftover can sit on a size that is no longer
 *   sellable, which no size list would name.
 * - Takes the old per-size writers' own feature locks, policy then shelf,
 *   before any row. Those writers never take the store lock, so this order
 *   adds no cycle (plan 3.9 step 7).
 * - Set-based: one statement per kind, whatever the size count. Each locks
 *   its rows FOR UPDATE in ascending size order, writes one revision per size
 *   under the request's child key with the parent request hash (plan D10),
 *   updates or deletes the current rows and writes one audit row per size,
 *   and returns ids and counts only.
 * - Every statement is the vendor's and the store's rows only: the per-size
 *   tables hold every vendor's rows over one shared catalog.
 * - No text crosses into the heap: a main text reset's audit carries the
 *   text's UTF-8 byte count and sha256, built in SQL.
 *
 * Repositories do not log; the service does.
 */

type QueryClient = Pick<PoolClient, "query">;

/** int4 keys (product, vendor, store). */
const MAX_INT4_ID = 2_147_483_647;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** The old per-size writers' own feature locks (dropship-ebay-listing-policy-override.repository.ts, dropship-ebay-store-category.repository.ts). */
export const POLICY_FEATURE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_listing_policy_override'), $1::integer)";
export const SHELF_FEATURE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('dropship_ebay_store_category_assignment'), $1::integer)";

/** Each kind's statement returns the cleared sizes and the rows it wrote, so a partial write is caught before commit. */
interface KindResultRow {
  size_ids: unknown;
  revisions: unknown;
  current_rows: unknown;
  audits: unknown;
}

/**
 * Policy overrides: rows with an id in a cleared field. One revision per size
 * with the cleared ids null and the others kept; a row left with no id is
 * deleted (the table's nonempty CHECK), the others point at their new
 * revision. $4-$6 say which of the three ids are cleared.
 */
export const CLEAR_POLICY_LEFTOVERS_SQL = `WITH target AS MATERIALIZED (
  SELECT o.id, o.product_variant_id,
    o.fulfillment_policy_id AS before_fulfillment, o.return_policy_id AS before_return, o.payment_policy_id AS before_payment,
    CASE WHEN $4::boolean THEN NULL ELSE o.fulfillment_policy_id END AS after_fulfillment,
    CASE WHEN $5::boolean THEN NULL ELSE o.return_policy_id END AS after_return,
    CASE WHEN $6::boolean THEN NULL ELSE o.payment_policy_id END AS after_payment
  FROM dropship.dropship_ebay_listing_policy_overrides o
  JOIN catalog.product_variants pv ON pv.id = o.product_variant_id AND pv.product_id = ANY($3::int[])
  WHERE o.vendor_id = $1 AND o.store_connection_id = $2
    AND (($4::boolean AND o.fulfillment_policy_id IS NOT NULL) OR ($5::boolean AND o.return_policy_id IS NOT NULL)
      OR ($6::boolean AND o.payment_policy_id IS NOT NULL))
  ORDER BY o.product_variant_id
  FOR UPDATE OF o
), revision AS (
  INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions
    (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash,
     fulfillment_policy_id, return_policy_id, payment_policy_id, actor_type, actor_id, created_at)
  SELECT $1::integer, $2::integer, t.product_variant_id, $7::text || t.product_variant_id::text, $8::text,
    t.after_fulfillment, t.after_return, t.after_payment, $9::text, $10::text, $11::timestamptz
  FROM target t ORDER BY t.product_variant_id
  RETURNING id, product_variant_id
), removed AS (
  DELETE FROM dropship.dropship_ebay_listing_policy_overrides o USING target t
  WHERE o.id = t.id AND o.vendor_id = $1 AND o.store_connection_id = $2
    AND t.after_fulfillment IS NULL AND t.after_return IS NULL AND t.after_payment IS NULL
  RETURNING o.product_variant_id
), kept AS (
  UPDATE dropship.dropship_ebay_listing_policy_overrides o
  SET revision_id = r.id, fulfillment_policy_id = t.after_fulfillment, return_policy_id = t.after_return,
    payment_policy_id = t.after_payment, updated_at = $11::timestamptz
  FROM target t JOIN revision r ON r.product_variant_id = t.product_variant_id
  WHERE o.id = t.id AND o.vendor_id = $1 AND o.store_connection_id = $2
    AND NOT (t.after_fulfillment IS NULL AND t.after_return IS NULL AND t.after_payment IS NULL)
  RETURNING o.product_variant_id
), audit AS (
  INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
  SELECT $1::integer, $2::integer, 'dropship_ebay_listing_policy_override', t.product_variant_id::text,
    'ebay_listing_policy_override_replaced', $9::text, $10::text, 'info', jsonb_build_object(
      'revisionId', r.id,
      'before', jsonb_build_object('fulfillmentPolicyId', t.before_fulfillment, 'returnPolicyId', t.before_return,
        'paymentPolicyId', t.before_payment),
      'after', CASE WHEN t.after_fulfillment IS NULL AND t.after_return IS NULL AND t.after_payment IS NULL THEN NULL
        ELSE jsonb_build_object('fulfillmentPolicyId', t.after_fulfillment, 'returnPolicyId', t.after_return,
          'paymentPolicyId', t.after_payment) END,
      'requestKey', $12::text, 'cleared', $13::jsonb), $11::timestamptz
  FROM target t JOIN revision r ON r.product_variant_id = t.product_variant_id
  RETURNING id
)
SELECT (SELECT COALESCE(array_agg(product_variant_id ORDER BY product_variant_id), '{}'::int[]) FROM target) AS size_ids,
  (SELECT count(*) FROM revision)::int AS revisions,
  ((SELECT count(*) FROM removed) + (SELECT count(*) FROM kept))::int AS current_rows,
  (SELECT count(*) FROM audit)::int AS audits`;

/** Store shelves: every row of the sizes. An empty revision (0 shelves is allowed there), then the row is deleted. */
export const CLEAR_SHELF_LEFTOVERS_SQL = `WITH target AS MATERIALIZED (
  SELECT a.id, a.product_variant_id, a.store_category_ids AS before_ids, a.store_category_names AS before_names
  FROM dropship.dropship_ebay_store_category_assignments a
  JOIN catalog.product_variants pv ON pv.id = a.product_variant_id AND pv.product_id = ANY($3::int[])
  WHERE a.vendor_id = $1 AND a.store_connection_id = $2
  ORDER BY a.product_variant_id
  FOR UPDATE OF a
), revision AS (
  INSERT INTO dropship.dropship_ebay_store_category_assignment_revisions
    (vendor_id, store_connection_id, product_variant_id, idempotency_key, request_hash,
     store_category_ids, store_category_names, actor_type, actor_id, created_at)
  SELECT $1::integer, $2::integer, t.product_variant_id, $4::text || t.product_variant_id::text, $5::text, '[]'::jsonb, '[]'::jsonb,
    $6::text, $7::text, $8::timestamptz
  FROM target t ORDER BY t.product_variant_id
  RETURNING id, product_variant_id
), removed AS (
  DELETE FROM dropship.dropship_ebay_store_category_assignments a USING target t
  WHERE a.id = t.id AND a.vendor_id = $1 AND a.store_connection_id = $2
  RETURNING a.product_variant_id
), audit AS (
  INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
  SELECT $1::integer, $2::integer, 'dropship_ebay_store_category_assignment', t.product_variant_id::text,
    'ebay_store_category_assignment_replaced', $6::text, $7::text, 'info', jsonb_build_object(
      'revisionId', r.id,
      'before', jsonb_build_object('storeCategoryIds', t.before_ids, 'storeCategoryNames', t.before_names),
      'after', NULL::jsonb,
      'requestKey', $9::text), $8::timestamptz
  FROM target t JOIN revision r ON r.product_variant_id = t.product_variant_id
  RETURNING id
)
SELECT (SELECT COALESCE(array_agg(product_variant_id ORDER BY product_variant_id), '{}'::int[]) FROM target) AS size_ids,
  (SELECT count(*) FROM revision)::int AS revisions,
  (SELECT count(*) FROM removed)::int AS current_rows,
  (SELECT count(*) FROM audit)::int AS audits`;

/**
 * Own main texts: current rows whose revision holds a text. A revision with
 * no text that succeeds the current one (the coherence trigger checks the
 * predecessor; a delete is refused), keeping its catalog hash and template
 * revision, then the row points at it. The audit names the text by its UTF-8
 * byte count and sha256, never its words.
 */
export const CLEAR_CONTENT_LEFTOVERS_SQL = `WITH target AS MATERIALIZED (
  SELECT s.product_variant_id, s.revision_id, r.custom_text, r.catalog_hash, r.profile_revision_id
  FROM dropship.dropship_listing_content_settings s
  JOIN dropship.dropship_listing_content_revisions r ON r.id = s.revision_id AND r.vendor_id = s.vendor_id
    AND r.store_connection_id = s.store_connection_id AND r.product_variant_id = s.product_variant_id
  JOIN catalog.product_variants pv ON pv.id = s.product_variant_id AND pv.product_id = ANY($3::int[])
  WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND r.custom_text IS NOT NULL
  ORDER BY s.product_variant_id
  FOR UPDATE OF s
), revision AS (
  INSERT INTO dropship.dropship_listing_content_revisions
    (vendor_id, store_connection_id, product_variant_id, previous_revision_id, custom_text, catalog_hash,
     profile_revision_id, idempotency_key, request_hash, actor_id, created_at)
  SELECT $1::integer, $2::integer, t.product_variant_id, t.revision_id, NULL, t.catalog_hash, t.profile_revision_id,
    $4::text || t.product_variant_id::text, $5::text, $6::text, $7::timestamptz
  FROM target t ORDER BY t.product_variant_id
  RETURNING id, product_variant_id
), moved AS (
  UPDATE dropship.dropship_listing_content_settings s SET revision_id = r.id
  FROM revision r
  WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_variant_id = r.product_variant_id
  RETURNING s.product_variant_id
), audit AS (
  INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
  SELECT $1::integer, $2::integer, 'dropship_listing_content_setting', t.product_variant_id::text, 'listing_content_saved',
    $8::text, $6::text, 'info', jsonb_build_object(
      'revisionId', r.id,
      'previousRevisionId', t.revision_id,
      'before', jsonb_build_object('bytes', octet_length(convert_to(t.custom_text, 'UTF8')),
        'sha256', encode(sha256(convert_to(t.custom_text, 'UTF8')), 'hex')),
      'after', NULL::jsonb,
      'requestKey', $9::text), $7::timestamptz
  FROM target t JOIN revision r ON r.product_variant_id = t.product_variant_id
  RETURNING id
)
SELECT (SELECT COALESCE(array_agg(product_variant_id ORDER BY product_variant_id), '{}'::int[]) FROM target) AS size_ids,
  (SELECT count(*) FROM revision)::int AS revisions,
  (SELECT count(*) FROM moved)::int AS current_rows,
  (SELECT count(*) FROM audit)::int AS audits`;

/** The policy fields' columns, in the statement's $4-$6 order. */
const POLICY_FIELD_ORDER = ["shippingPolicy", "returnPolicy", "paymentPolicy"] as const;
/** A result names at most this many sizes; the count gives the total. */
const MAX_LISTED_SIZES = 100;

/**
 * Clears the products' per-size leftovers for `fields`. The caller (the
 * wrapper) guarantees the products were locked by lockCatalog and that this
 * runs once per transaction; a call outside this contract is a programming
 * fault (fatal), refused before any statement.
 */
export async function clearSizeLeftoversWithClient(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  input: ClearSizeLeftoversInput,
): Promise<ClearSizeLeftoversResult> {
  assertClearInput(scope, input);
  const fields = new Set<ListingSettingLeftoverField>(input.fields);
  const productIds = [...new Set(input.productIds)].sort((left, right) => left - right);
  const clearsPolicy = POLICY_FIELD_ORDER.some((field) => fields.has(field));
  const actor = [scope.actor.actorType, scope.actor.actorId] as const;
  // The feature locks first, policy then shelf: the old per-size writers' order of their own (plan 3.9 step 7).
  if (clearsPolicy) await client.query(POLICY_FEATURE_LOCK_SQL, [scope.storeConnectionId]);
  if (fields.has("storeShelf")) await client.query(SHELF_FEATURE_LOCK_SQL, [scope.storeConnectionId]);

  const cleared = new Set<number>();
  const byKind = { policy: 0, shelf: 0, content: 0 };
  if (clearsPolicy) {
    const clearedFields = POLICY_FIELD_ORDER.filter((field) => fields.has(field));
    byKind.policy = await runKind(client, "policy", CLEAR_POLICY_LEFTOVERS_SQL, [
      scope.vendorId, scope.storeConnectionId, productIds,
      fields.has("shippingPolicy"), fields.has("returnPolicy"), fields.has("paymentPolicy"),
      listingSettingChildKeyPrefix(scope.requestKey, "policy"), input.requestHash, ...actor, input.now,
      scope.requestKey, JSON.stringify(clearedFields),
    ], cleared);
  }
  if (fields.has("storeShelf")) {
    byKind.shelf = await runKind(client, "shelf", CLEAR_SHELF_LEFTOVERS_SQL, [
      scope.vendorId, scope.storeConnectionId, productIds,
      listingSettingChildKeyPrefix(scope.requestKey, "shelf"), input.requestHash, ...actor, input.now, scope.requestKey,
    ], cleared);
  }
  if (fields.has("mainText")) {
    byKind.content = await runKind(client, "content", CLEAR_CONTENT_LEFTOVERS_SQL, [
      scope.vendorId, scope.storeConnectionId, productIds,
      listingSettingChildKeyPrefix(scope.requestKey, "content"), input.requestHash, scope.actor.actorId, input.now,
      scope.actor.actorType, scope.requestKey,
    ], cleared);
  }
  const sizes = [...cleared].sort((left, right) => left - right);
  return { clearedSizeCount: sizes.length, byKind, productVariantIds: sizes.slice(0, MAX_LISTED_SIZES) };
}

/**
 * One kind's statement. Every cleared size must have its revision, its
 * current-row change and its audit row; anything else means a statement
 * broke its own contract, so the transaction rolls back as fatal.
 */
async function runKind(client: QueryClient, kind: "policy" | "shelf" | "content", sql: string, params: unknown[],
  cleared: Set<number>): Promise<number> {
  const result = await client.query<KindResultRow>(sql, params);
  const row = result.rows[0];
  const sizeIds = row?.size_ids;
  if (!row || !Array.isArray(sizeIds) || !sizeIds.every(isInt4Id) || new Set(sizeIds).size !== sizeIds.length
    || row.revisions !== sizeIds.length || row.current_rows !== sizeIds.length || row.audits !== sizeIds.length) {
    throw listingSettingsInvariantFailed("A per-size leftover clean-up wrote a different number of rows than it cleared.", { kind });
  }
  for (const id of sizeIds) cleared.add(id);
  return sizeIds.length;
}

function assertClearInput(scope: ListingSettingWriteScope, input: ClearSizeLeftoversInput): void {
  const actorId = scope.actor.actorId;
  const invalid = [
    isInt4Id(scope.vendorId) ? null : "vendorId",
    isInt4Id(scope.storeConnectionId) ? null : "storeConnectionId",
    typeof scope.requestKey === "string" && LISTING_SETTING_KEY_PATTERN.test(scope.requestKey) ? null : "requestKey",
    (LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(scope.actor.actorType) ? null : "actorType",
    typeof actorId === "string" && actorId.trim() !== "" && actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH ? null : "actorId",
    Array.isArray(input.productIds) && input.productIds.length > 0 && input.productIds.every(isInt4Id) ? null : "productIds",
    Array.isArray(input.fields) && input.fields.length > 0
      && input.fields.every((field) => (LISTING_SETTING_LEFTOVER_FIELDS as readonly string[]).includes(field)) ? null : "fields",
    typeof input.requestHash === "string" && REQUEST_HASH_PATTERN.test(input.requestHash) ? null : "requestHash",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A per-size leftover clean-up was called outside its contract.", { invalid });
  }
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
