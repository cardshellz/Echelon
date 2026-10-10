import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  categoryMovesAcknowledgeItemsSchema,
  productCategoryMarkSchema,
  type CategoryMovesAcknowledgeItems,
  type ProductCategoryMark,
} from "../../../../shared/dropship/listing-setting-values";
import type {
  CategoryMovesAcknowledgeInput,
  CategoryMovesAcknowledgeResult,
} from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import {
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
  assertListingSettingRequestMatches,
  findListingSettingRequestWithClient,
  insertListingSettingRequestWithClient,
  type ListingSettingWriteScope,
} from "./dropship-listing-setting-shared.repository";

/**
 * Category marks behind "Card Shellz updated products" (W13, plan PR 8a
 * section 3.8; migration 0737). A mark holds the Card Shellz category a chosen
 * product was in when the vendor last confirmed it (null = no category); a
 * chosen product whose category now differs is listed as moved.
 *
 * Marks are history: never deleted, identity never changes, and seen_at never
 * moves back (the 0737 guard). They have no foreign key to the catalog (plan
 * D13), so both writers select from catalog.products and cannot mark a
 * product that does not exist.
 *
 * Every function takes the caller's transaction client and assumes the caller
 * holds the store lock and the owner rows (plan 3.9). The only lock taken here
 * is FOR UPDATE on the acknowledged products' own marks. Repositories do not
 * log; PR 9's services do.
 */

type QueryClient = Pick<PoolClient, "query">;

/** The system job's scope: no request key, because first marks are idempotent by construction. */
export type ListingSettingSystemScope = Pick<ListingSettingWriteScope, "vendorId" | "storeConnectionId" | "actor">;

const ACKNOWLEDGE_OPERATION = "category_moves_acknowledge";
/** int4 keys (product, category, store, vendor). */
const MAX_INT4 = 2_147_483_647;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** An audit row names at most this many products and carries the full count, so 10,000 ids never land in one payload. */
const MAX_AUDITED_PRODUCTS = 100;
/** Issue paths and codes only. */
const MAX_REPORTED_ISSUES = 10;

interface MarkRow {
  product_id: unknown;
  category_id: unknown;
  seen_at: unknown;
}

/** Marks by product id; a product with no mark is absent. Empty ids read nothing. `forUpdate` locks the marks found. */
export async function readProductCategoryMarks(
  client: QueryClient,
  input: { vendorId: number; storeConnectionId: number; productIds: readonly number[]; forUpdate?: boolean },
): Promise<Map<number, ProductCategoryMark>> {
  const productIds = distinctIds(input.productIds, "productIds");
  const marks = new Map<number, ProductCategoryMark>();
  if (productIds.length === 0) return marks;
  const result = await client.query<MarkRow>(
    `SELECT product_id, category_id, seen_at
     FROM dropship.dropship_product_category_seen
     WHERE vendor_id = $1 AND store_connection_id = $2 AND product_id = ANY($3::int[])
     ORDER BY product_id${input.forUpdate === true ? " FOR UPDATE" : ""}`,
    [input.vendorId, input.storeConnectionId, productIds],
  );
  for (const row of result.rows) {
    const mark = markFromRow(input.storeConnectionId, row);
    marks.set(mark.productId, mark);
  }
  return marks;
}

/**
 * First marks (the W13 job, PR 9): a mark for every given product that has
 * none, with its current category. An existing mark is never changed, so this
 * can never hide a move, and running it again inserts nothing. One audit row,
 * only when something was inserted.
 */
export async function insertFirstCategoryMarksWithClient(
  client: QueryClient,
  scope: ListingSettingSystemScope,
  input: { productIds: readonly number[]; jobKey: string; now: Date },
): Promise<{ insertedProductIds: number[] }> {
  const invalid = [
    ...scopeProblems(scope),
    typeof input.jobKey === "string" && input.jobKey.trim() !== "" && input.jobKey.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH
      ? null : "jobKey",
    validDate(input.now) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A first category mark run breaks the writer contract.", { invalid });
  const productIds = distinctIds(input.productIds, "productIds");
  if (productIds.length === 0) return { insertedProductIds: [] };

  const inserted = await client.query<{ product_id: unknown }>(
    `INSERT INTO dropship.dropship_product_category_seen (vendor_id, store_connection_id, product_id, category_id, seen_at)
     SELECT $1, $2, p.id, p.category_id, $3
     FROM catalog.products p
     WHERE p.id = ANY($4::int[])
     ORDER BY p.id
     ON CONFLICT (store_connection_id, product_id) DO NOTHING
     RETURNING product_id`,
    [scope.vendorId, scope.storeConnectionId, input.now, productIds],
  );
  const insertedProductIds = returnedProductIds(inserted.rows, new Set(productIds));
  if (insertedProductIds.length > 0) {
    await client.query(
      `INSERT INTO dropship.dropship_audit_events
         (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
       VALUES ($1, $2, 'dropship_store_connection', $3, 'category_marks_seeded', $4, $5, 'info', $6::jsonb, $7)`,
      [scope.vendorId, scope.storeConnectionId, String(scope.storeConnectionId), scope.actor.actorType, scope.actor.actorId,
        JSON.stringify({
          jobKey: input.jobKey, insertedCount: insertedProductIds.length,
          productIds: insertedProductIds.slice(0, MAX_AUDITED_PRODUCTS),
        }), input.now],
    );
  }
  return { insertedProductIds };
}

/**
 * "Got it" for products Card Shellz moved (W13), compare-and-set on each
 * product's current category: a mark moves to the category the vendor was
 * shown only while the product is still in it. A product that moved again
 * keeps its mark and stays listed. A product no longer in the catalog is
 * neither acknowledged nor moved again; only the audit row names it. The
 * request is recorded in the ledger, so a retry with the same key writes
 * nothing.
 */
export async function acknowledgeCategoryMovesWithClient(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  input: CategoryMovesAcknowledgeInput,
): Promise<CategoryMovesAcknowledgeResult> {
  // 0. Before any SQL. A product twice would make the upsert touch one row twice (21000).
  const items = parseAcknowledgeItems(input.items);
  assertAcknowledgeContract(scope, input);

  // 1. Replay from the ledger: the page re-reads after any save (PR 7 D9), so the lists stay empty.
  const request = await findListingSettingRequestWithClient(client, { vendorId: scope.vendorId, idempotencyKey: scope.requestKey });
  if (request) {
    assertListingSettingRequestMatches(request, {
      storeConnectionId: scope.storeConnectionId, operation: ACKNOWLEDGE_OPERATION, requestHash: input.requestHash,
    });
    return { outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] };
  }

  // 2. The marks as they were, locked, for the audit trail's before-state (`hadMark`, `from`).
  const productIds = items.map((item) => item.productId);
  const before = await readProductCategoryMarks(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, productIds, forUpdate: true,
  });

  // 3. Only products still in the shown category join. Under READ COMMITTED
  // the statement sees committed categories; a move committing during it
  // leaves the old mark, so the product stays listed (the safe side).
  const upserted = await client.query<{ product_id: unknown; category_id: unknown }>(
    `INSERT INTO dropship.dropship_product_category_seen AS m (vendor_id, store_connection_id, product_id, category_id, seen_at)
     SELECT $1, $2, p.id, p.category_id, $3
     FROM jsonb_to_recordset($4::jsonb) AS x(product_id integer, shown_category_id integer)
     JOIN catalog.products p ON p.id = x.product_id AND p.category_id IS NOT DISTINCT FROM x.shown_category_id
     ORDER BY p.id
     ON CONFLICT (store_connection_id, product_id)
       DO UPDATE SET category_id = EXCLUDED.category_id, seen_at = GREATEST(m.seen_at, EXCLUDED.seen_at)
     RETURNING product_id, category_id`,
    [scope.vendorId, scope.storeConnectionId, input.now,
      JSON.stringify(items.map((item) => ({ product_id: item.productId, shown_category_id: item.shownCategoryId })))],
  );
  const acknowledged = acknowledgedMarks(upserted.rows, items);
  const acknowledgedIds = new Set(acknowledged.map((mark) => mark.productId));

  // 4. Not joined: moved again (still in the catalog) or gone from it. Read
  // after the upsert, so a product deleted meanwhile counts as gone, never as
  // moved (ids are not reused, plan D13); readers join the catalog, so a gone
  // product is never listed.
  const notAcknowledged = productIds.filter((productId) => !acknowledgedIds.has(productId));
  const movedAgainProductIds = await productIdsInCatalog(client, notAcknowledged);
  const movedAgainIds = new Set(movedAgainProductIds);
  const notInCatalogProductIds = notAcknowledged.filter((productId) => !movedAgainIds.has(productId));

  // 5. The ledger row (rows written, plan D12), then one audit row for the
  // call. `hadMark` tells "no mark yet" from a mark with no category, both
  // `from: null`; the lists are capped, the counts are not.
  const requestId = await insertListingSettingRequestWithClient(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, operation: ACKNOWLEDGE_OPERATION,
    idempotencyKey: scope.requestKey, requestHash: input.requestHash, productCount: acknowledged.length,
    actor: scope.actor, now: input.now,
  });
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'category_moves_acknowledged', $4, $5, 'info', $6::jsonb, $7)`,
    [scope.vendorId, scope.storeConnectionId, String(scope.storeConnectionId), scope.actor.actorType, scope.actor.actorId,
      JSON.stringify({
        requestKey: scope.requestKey, requestId,
        acknowledged: acknowledged.slice(0, MAX_AUDITED_PRODUCTS).map((mark) => ({
          productId: mark.productId, hadMark: before.has(mark.productId),
          from: before.get(mark.productId)?.categoryId ?? null, to: mark.categoryId,
        })),
        acknowledgedCount: acknowledged.length,
        movedAgain: movedAgainProductIds.slice(0, MAX_AUDITED_PRODUCTS),
        movedAgainCount: movedAgainProductIds.length,
        notInCatalog: notInCatalogProductIds.slice(0, MAX_AUDITED_PRODUCTS),
        notInCatalogCount: notInCatalogProductIds.length,
      }), input.now],
  );
  return {
    outcome: "acknowledged",
    acknowledgedProductIds: acknowledged.map((mark) => mark.productId),
    movedAgainProductIds,
  };
}

/** A "Got it" request the vendor can fix: permanent, never retried. */
export function listingSettingsBulkInvalid(message: string, context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError("DROPSHIP_LISTING_SETTINGS_BULK_INVALID", message, {
    ...context, retryable: false, classification: "permanent",
  });
}

/** Items sorted by product id, so the upsert takes row locks in one order. */
function parseAcknowledgeItems(items: CategoryMovesAcknowledgeInput["items"]): CategoryMovesAcknowledgeItems {
  const parsed = categoryMovesAcknowledgeItemsSchema.safeParse(items);
  if (!parsed.success) {
    throw listingSettingsBulkInvalid("Choose 1 to 10,000 different products to acknowledge.", { issues: issuesOf(parsed.error) });
  }
  return [...parsed.data].sort((left, right) => left.productId - right.productId);
}

/** PR 9's service builds these; a breach is a programming fault (fatal). */
function assertAcknowledgeContract(scope: ListingSettingWriteScope, input: CategoryMovesAcknowledgeInput): void {
  const invalid = [
    ...scopeProblems(scope),
    typeof scope.requestKey === "string" && LISTING_SETTING_KEY_PATTERN.test(scope.requestKey) ? null : "requestKey",
    typeof input.requestHash === "string" && REQUEST_HASH_PATTERN.test(input.requestHash) ? null : "requestHash",
    validDate(input.now) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A category moves acknowledge breaks the writer contract.", { invalid });
}

/** Each returned mark must be one of the items, once, in the category the vendor was shown (the join guarantees it). */
function acknowledgedMarks(
  rows: ReadonlyArray<{ product_id: unknown; category_id: unknown }>,
  items: CategoryMovesAcknowledgeItems,
): Array<{ productId: number; categoryId: number | null }> {
  const shown = new Map(items.map((item) => [item.productId, item.shownCategoryId]));
  const productIds = returnedProductIds(rows, new Set(shown.keys()));
  const categoryByProduct = new Map(rows.map((row) => [row.product_id, row.category_id]));
  return productIds.map((productId) => {
    const categoryId = categoryByProduct.get(productId);
    if (categoryId !== shown.get(productId)) {
      throw listingSettingsInvariantFailed("An acknowledged category mark does not hold the category shown.", { productId });
    }
    return { productId, categoryId: categoryId as number | null };
  });
}

/** The given products still in the catalog, ascending. Empty ids read nothing. */
async function productIdsInCatalog(client: QueryClient, productIds: readonly number[]): Promise<number[]> {
  if (productIds.length === 0) return [];
  const result = await client.query<{ product_id: unknown }>(
    `SELECT id AS product_id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id`,
    [productIds],
  );
  return returnedProductIds(result.rows, new Set(productIds));
}

/** Returned ids, ascending; an id that was not asked for, or twice, means the statement broke its contract. */
function returnedProductIds(rows: ReadonlyArray<{ product_id: unknown }>, asked: ReadonlySet<number>): number[] {
  const ids = rows.map((row) => row.product_id);
  if (!ids.every((id): id is number => typeof id === "number" && asked.has(id)) || new Set(ids).size !== ids.length) {
    throw listingSettingsInvariantFailed("A category mark statement returned a product it was not given.");
  }
  return [...ids].sort((left, right) => left - right);
}

/** A stored mark that breaks its contract is refused with its ids, never a guess. */
function markFromRow(storeConnectionId: number, row: MarkRow): ProductCategoryMark {
  const parsed = productCategoryMarkSchema.safeParse({
    storeConnectionId,
    productId: row.product_id,
    categoryId: row.category_id,
    seenAt: row.seen_at instanceof Date && validDate(row.seen_at) ? row.seen_at.toISOString() : row.seen_at,
  });
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("A stored category mark failed its contract.", {
    storeConnectionId, productId: String(row.product_id), issues: issuesOf(parsed.error),
  });
}

function scopeProblems(scope: ListingSettingSystemScope): Array<string | null> {
  return [
    isId(scope.vendorId) ? null : "vendorId",
    isId(scope.storeConnectionId) ? null : "storeConnectionId",
    (LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(scope.actor.actorType) ? null : "actorType",
    typeof scope.actor.actorId === "string" && scope.actor.actorId.trim() !== ""
      && scope.actor.actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH ? null : "actorId",
  ];
}

/** Distinct positive int4 ids, ascending; anything else is a programming fault. */
function distinctIds(ids: readonly number[], field: string): number[] {
  if (!ids.every(isId)) throw listingSettingsInvariantFailed("Listing setting ids must be positive whole numbers.", { field });
  return [...new Set(ids)].sort((left, right) => left - right);
}

function isId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function issuesOf(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
