import type { PoolClient } from "pg";
import type { z } from "zod";
import {
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  LISTING_SETTING_REQUEST_OPERATIONS,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  categoryListingSettingRowSchema,
  categoryListingSettingValuesSchema,
  productListingSettingRowSchema,
  productListingSettingValuesSchema,
  type CategoryListingSettingRow,
  type CategoryListingSettingValues,
  type ListingSettingActorType,
  type ListingSettingRequestOperation,
  type ProductListingSettingRow,
  type ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import type { ListingSettingActor } from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";

/**
 * What the product and category listing-settings writers share (plan PR 8a,
 * section 3.8): one mapping each way between stored values and the revision
 * columns of migrations 0736 and 0737, and the request ledger. Every function
 * takes the caller's transaction client, assumes the caller holds the locks
 * (plan 3.9) and takes none itself. Repositories do not log; PR 9's services do.
 */

type QueryClient = Pick<PoolClient, "query">;

/** Who and which request a writer runs for, inside the caller's transaction. */
export interface ListingSettingWriteScope {
  vendorId: number;
  storeConnectionId: number;
  actor: ListingSettingActor;
  requestKey: string;
}

/** The value columns both revision tables have, in table order (0736, 0737). */
export const CATEGORY_LISTING_SETTING_VALUE_COLUMNS = [
  "price_basis", "price_markup_bps", "price_flat_cents", "price_rounding",
  "ebay_category_id", "ebay_category_name", "ebay_category_path",
  "shelf_mode", "shelf_ids", "shelf_names",
  "fulfillment_policy_id", "fulfillment_policy_name",
  "return_policy_id", "return_policy_name",
  "payment_policy_id", "payment_policy_name",
  "text_above_mode", "text_above",
  "text_below_mode", "text_below",
] as const;
/** Product revisions add the main text (0736 only). */
export const PRODUCT_LISTING_SETTING_VALUE_COLUMNS = [
  ...CATEGORY_LISTING_SETTING_VALUE_COLUMNS, "body_text", "body_catalog_hash",
] as const;
export type CategoryListingSettingValueColumn = (typeof CATEGORY_LISTING_SETTING_VALUE_COLUMNS)[number];
export type ProductListingSettingValueColumn = (typeof PRODUCT_LISTING_SETTING_VALUE_COLUMNS)[number];

/**
 * The PostgreSQL type each value column is read as in a set-based write
 * (`jsonb_to_recordset(...) AS x(<column> <type>, ...)`). text is assigned to
 * the varchar columns; their widths are the values schema's bounds.
 */
export const LISTING_SETTING_VALUE_COLUMN_TYPES: Readonly<Record<ProductListingSettingValueColumn, "text" | "integer" | "jsonb">> = Object.freeze({
  price_basis: "text", price_markup_bps: "integer", price_flat_cents: "integer", price_rounding: "text",
  ebay_category_id: "text", ebay_category_name: "text", ebay_category_path: "jsonb",
  shelf_mode: "text", shelf_ids: "jsonb", shelf_names: "jsonb",
  fulfillment_policy_id: "text", fulfillment_policy_name: "text",
  return_policy_id: "text", return_policy_name: "text",
  payment_policy_id: "text", payment_policy_name: "text",
  text_above_mode: "text", text_above: "text",
  text_below_mode: "text", text_below: "text",
  body_text: "text", body_catalog_hash: "text",
});

/**
 * Stored values as columns. jsonb columns hold JS arrays: a single-row insert
 * passes JSON.stringify(value) with a `::jsonb` cast (node-postgres would send
 * an array as a PostgreSQL array), a set-based insert puts the array in its
 * recordset JSON.
 */
export interface CategoryListingSettingValueColumns {
  price_basis: string | null;
  price_markup_bps: number | null;
  price_flat_cents: number | null;
  price_rounding: string | null;
  ebay_category_id: string | null;
  ebay_category_name: string | null;
  ebay_category_path: string[] | null;
  shelf_mode: string | null;
  shelf_ids: string[] | null;
  shelf_names: string[] | null;
  fulfillment_policy_id: string | null;
  fulfillment_policy_name: string | null;
  return_policy_id: string | null;
  return_policy_name: string | null;
  payment_policy_id: string | null;
  payment_policy_name: string | null;
  text_above_mode: string | null;
  text_above: string | null;
  text_below_mode: string | null;
  text_below: string | null;
}
export interface ProductListingSettingValueColumns extends CategoryListingSettingValueColumns {
  body_text: string | null;
  body_catalog_hash: string | null;
}
/** A row as PostgreSQL returned it: nothing is trusted until it is parsed. */
export type StoredCategoryListingSettingColumns = Readonly<Record<CategoryListingSettingValueColumn, unknown>>;
export type StoredProductListingSettingColumns = Readonly<Record<ProductListingSettingValueColumn, unknown>>;
/** The identity columns a current-row read or a revision read selects with the values. */
export interface StoredListingSettingRevisionColumns {
  revision_id: unknown;
  created_at: unknown;
}

/** Values the caller has already parsed with the values schema; columns written once for both tables. */
export function categoryValuesToColumns(values: CategoryListingSettingValues): CategoryListingSettingValueColumns {
  const shelf = values.storeShelf;
  return {
    price_basis: values.price?.basis ?? null,
    price_markup_bps: values.price?.markupBps ?? null,
    price_flat_cents: values.price?.flatCents ?? null,
    price_rounding: values.price?.rounding ?? null,
    ebay_category_id: values.ebayCategory?.categoryId ?? null,
    ebay_category_name: values.ebayCategory?.categoryName ?? null,
    ebay_category_path: values.ebayCategory ? [...values.ebayCategory.path] : null,
    shelf_mode: shelf?.mode ?? null,
    shelf_ids: shelf?.mode === "own" ? shelf.shelves.map((entry) => entry.id) : null,
    shelf_names: shelf?.mode === "own" ? shelf.shelves.map((entry) => entry.name) : null,
    fulfillment_policy_id: values.shippingPolicy?.id ?? null,
    fulfillment_policy_name: values.shippingPolicy?.name ?? null,
    return_policy_id: values.returnPolicy?.id ?? null,
    return_policy_name: values.returnPolicy?.name ?? null,
    payment_policy_id: values.paymentPolicy?.id ?? null,
    payment_policy_name: values.paymentPolicy?.name ?? null,
    text_above_mode: values.textAbove?.mode ?? null,
    text_above: values.textAbove?.mode === "own" ? values.textAbove.text : null,
    text_below_mode: values.textBelow?.mode ?? null,
    text_below: values.textBelow?.mode === "own" ? values.textBelow.text : null,
  };
}

export function productValuesToColumns(values: ProductListingSettingValues): ProductListingSettingValueColumns {
  return {
    ...categoryValuesToColumns(values),
    body_text: values.mainText?.text ?? null,
    body_catalog_hash: values.mainText?.catalogHash ?? null,
  };
}

/** Stored columns as values, parsed with the values schema; a partial group or a bound breach is DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED. */
export function categoryColumnsToValues(row: StoredCategoryListingSettingColumns): CategoryListingSettingValues {
  return parseStored(categoryListingSettingValuesSchema, rawCategoryValues(row), "category listing setting values");
}

export function productColumnsToValues(row: StoredProductListingSettingColumns): ProductListingSettingValues {
  return parseStored(productListingSettingValuesSchema, rawProductValues(row), "product listing setting values");
}

/**
 * A current row (or a stored revision, for a replay) parsed with its row
 * schema. `updatedAt` is the revision's created_at. A row that breaks its
 * contract is refused with its ids, so the person paged can find it.
 */
export function productListingSettingRowFromColumns(
  storeConnectionId: number,
  row: StoredProductListingSettingColumns & StoredListingSettingRevisionColumns & { product_id: unknown },
): ProductListingSettingRow {
  return withStoredRowIds({
    storeConnectionId, productId: String(row.product_id), revisionId: String(row.revision_id),
  }, () => parseStored(productListingSettingRowSchema, {
    storeConnectionId, productId: row.product_id, revisionId: row.revision_id,
    updatedAt: storedTimestamp(row.created_at, "created_at"), values: rawProductValues(row),
  }, "product listing setting row"));
}

export function categoryListingSettingRowFromColumns(
  storeConnectionId: number,
  row: StoredCategoryListingSettingColumns & StoredListingSettingRevisionColumns & { category_id: unknown },
): CategoryListingSettingRow {
  return withStoredRowIds({
    storeConnectionId, categoryId: String(row.category_id), revisionId: String(row.revision_id),
  }, () => parseStored(categoryListingSettingRowSchema, {
    storeConnectionId, categoryId: row.category_id, revisionId: row.revision_id,
    updatedAt: storedTimestamp(row.created_at, "created_at"), values: rawCategoryValues(row),
  }, "category listing setting row"));
}

/*
 * Each group is read as all-or-none, as its CHECK writes it. A partial group
 * means a writer bypassed the CHECKs: it is refused, never completed with a
 * guess. The values schema then checks every bound.
 */

function rawCategoryValues(row: StoredCategoryListingSettingColumns): Record<string, unknown> {
  requireColumns(row, CATEGORY_LISTING_SETTING_VALUE_COLUMNS);
  return {
    price: allOrNone("price", [row.price_basis, row.price_markup_bps, row.price_flat_cents, row.price_rounding], () => ({
      basis: row.price_basis, markupBps: row.price_markup_bps, flatCents: row.price_flat_cents, rounding: row.price_rounding,
    })),
    ebayCategory: allOrNone("ebayCategory", [row.ebay_category_id, row.ebay_category_name, row.ebay_category_path], () => ({
      categoryId: row.ebay_category_id, categoryName: row.ebay_category_name, path: row.ebay_category_path,
    })),
    storeShelf: storeShelfFromColumns(row),
    shippingPolicy: policyFromColumns("shippingPolicy", row.fulfillment_policy_id, row.fulfillment_policy_name),
    returnPolicy: policyFromColumns("returnPolicy", row.return_policy_id, row.return_policy_name),
    paymentPolicy: policyFromColumns("paymentPolicy", row.payment_policy_id, row.payment_policy_name),
    textAbove: templateTextFromColumns("textAbove", row.text_above_mode, row.text_above),
    textBelow: templateTextFromColumns("textBelow", row.text_below_mode, row.text_below),
  };
}

function rawProductValues(row: StoredProductListingSettingColumns): Record<string, unknown> {
  requireColumns(row, PRODUCT_LISTING_SETTING_VALUE_COLUMNS);
  return {
    ...rawCategoryValues(row),
    mainText: allOrNone("mainText", [row.body_text, row.body_catalog_hash], () => ({
      text: row.body_text, catalogHash: row.body_catalog_hash,
    })),
  };
}

function allOrNone(group: string, columns: readonly unknown[], build: () => Record<string, unknown>): Record<string, unknown> | null {
  const set = columns.filter((value) => value !== null).length;
  if (set === 0) return null;
  if (set !== columns.length) throw brokenGroup(group);
  return build();
}

/** Follow (all null), none (mode only), or own with as many names as ids, kept in order: first shelf, then second. */
function storeShelfFromColumns(row: StoredCategoryListingSettingColumns): Record<string, unknown> | null {
  const { shelf_mode: mode, shelf_ids: ids, shelf_names: names } = row;
  if (ids === null && names === null) {
    if (mode === null) return null;
    if (mode === "none") return { mode: "none" };
  }
  if (mode === "own" && Array.isArray(ids) && Array.isArray(names) && ids.length === names.length) {
    return { mode: "own", shelves: ids.map((id: unknown, index) => ({ id, name: names[index] })) };
  }
  throw brokenGroup("storeShelf");
}

/** A name only with its id (plan D7); an id without a name is a policy whose name is not known. */
function policyFromColumns(group: string, policyId: unknown, policyName: unknown): Record<string, unknown> | null {
  if (policyId === null) {
    if (policyName === null) return null;
    throw brokenGroup(group);
  }
  return { id: policyId, name: policyName };
}

/** Follow (both null), none (mode only), or own with its text. */
function templateTextFromColumns(group: string, mode: unknown, text: unknown): Record<string, unknown> | null {
  if (text === null) {
    if (mode === null) return null;
    if (mode === "none") return { mode: "none" };
  } else if (mode === "own") {
    return { mode: "own", text };
  }
  throw brokenGroup(group);
}

function requireColumns(row: Readonly<Record<string, unknown>>, columns: readonly string[]): void {
  const missing = columns.filter((column) => row[column] === undefined);
  if (missing.length > 0) {
    throw listingSettingsInvariantFailed("A listing setting row was read without all of its value columns.", { missing });
  }
}

function brokenGroup(group: string): DropshipError {
  return listingSettingsInvariantFailed("A stored listing setting has a partial value.", { group });
}

function storedTimestamp(value: unknown, column: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  throw listingSettingsInvariantFailed("A stored listing setting timestamp is not a valid time.", { column });
}

/** Adds the row's ids to a DropshipError the read raised: ids only, never a stored text. Any other error passes unchanged. */
function withStoredRowIds<T>(ids: Record<string, unknown>, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof DropshipError)) throw error;
    throw new DropshipError(error.code, error.message, { ...error.context, ...ids });
  }
}

/** Issue paths and codes only: a stored text never goes into an error. */
function parseStored<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed(`A stored ${what} failed its contract.`, {
    issues: parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

// ---------------------------------------------------------------------------
// Request ledger (dropship_product_listing_setting_requests, append-only)
// ---------------------------------------------------------------------------

/** One ledger row: a bulk change, a category's "Also clear theirs", or a "Got it" for moved products. */
export interface ListingSettingRequestRecord {
  id: number;
  vendorId: number;
  storeConnectionId: number;
  operation: ListingSettingRequestOperation;
  idempotencyKey: string;
  requestHash: string;
  /** Rows the request wrote (plan D12): changed products for a bulk change, acknowledged marks for a "Got it". */
  productCount: number;
  actorType: ListingSettingActorType;
  actorId: string;
  createdAt: string;
}

interface ListingSettingRequestRow {
  id: unknown;
  vendor_id: unknown;
  store_connection_id: unknown;
  operation: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  product_count: unknown;
  actor_type: unknown;
  actor_id: unknown;
  created_at: unknown;
}

const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** = the varchar(255) actor_id columns (0736, 0737). Checked in UTF-16 code units, which never count fewer than PostgreSQL's characters. */
export const MAX_LISTING_SETTING_ACTOR_ID_LENGTH = 255;

/** The request an earlier call with this key wrote, or null. No lock: rows never change, and the caller holds the request-key lock. */
export async function findListingSettingRequestWithClient(
  client: QueryClient,
  input: { vendorId: number; idempotencyKey: string },
): Promise<ListingSettingRequestRecord | null> {
  const result = await client.query<ListingSettingRequestRow>(
    `SELECT id, vendor_id, store_connection_id, operation, idempotency_key, request_hash, product_count,
            actor_type, actor_id, created_at
     FROM dropship.dropship_product_listing_setting_requests
     WHERE vendor_id = $1 AND idempotency_key = $2`,
    [input.vendorId, input.idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapListingSettingRequestRow(row) : null;
}

/** Claims the key for this request and returns the ledger id. A key already used is 23505 on the key index, which the wrapper maps. */
export async function insertListingSettingRequestWithClient(
  client: QueryClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    operation: ListingSettingRequestOperation;
    idempotencyKey: string;
    requestHash: string;
    productCount: number;
    actor: ListingSettingActor;
    now: Date;
  },
): Promise<number> {
  assertLedgerInput(input);
  const result = await client.query<{ id: unknown }>(
    `INSERT INTO dropship.dropship_product_listing_setting_requests
       (vendor_id, store_connection_id, operation, idempotency_key, request_hash, product_count,
        actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [input.vendorId, input.storeConnectionId, input.operation, input.idempotencyKey, input.requestHash,
      input.productCount, input.actor.actorType, input.actor.actorId, input.now],
  );
  const row = result.rows[0];
  if (!row) throw listingSettingsInvariantFailed("The listing setting request insert returned no identity.");
  return storedId(row.id, "id");
}

/**
 * A key may be replayed only for the same store, operation and request; any
 * other use is the vendor reusing a key for a different change.
 */
export function assertListingSettingRequestMatches(
  row: ListingSettingRequestRecord,
  expected: { storeConnectionId: number; operation: ListingSettingRequestOperation; requestHash: string },
): void {
  const mismatched = [
    row.storeConnectionId !== expected.storeConnectionId ? "storeConnectionId" : null,
    row.operation !== expected.operation ? "operation" : null,
    row.requestHash !== expected.requestHash ? "requestHash" : null,
  ].filter((field): field is string => field !== null);
  if (mismatched.length > 0) throw listingSettingsIdempotencyConflict({ mismatched });
}

/** The vendor reused a request key for another change: permanent, never retried. */
export function listingSettingsIdempotencyConflict(context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT",
    "This request key was already used for a different listing settings change.",
    { ...context, retryable: false, classification: "permanent" });
}

function assertLedgerInput(input: {
  operation: string; idempotencyKey: string; requestHash: string; productCount: number; actor: ListingSettingActor; now: Date;
}): void {
  const invalid = [
    (LISTING_SETTING_REQUEST_OPERATIONS as readonly string[]).includes(input.operation) ? null : "operation",
    LISTING_SETTING_KEY_PATTERN.test(input.idempotencyKey) ? null : "idempotencyKey",
    REQUEST_HASH_PATTERN.test(input.requestHash) ? null : "requestHash",
    Number.isSafeInteger(input.productCount) && input.productCount >= 0
      && input.productCount <= MAX_LISTING_SETTING_BULK_PRODUCTS ? null : "productCount",
    (LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(input.actor.actorType) ? null : "actorType",
    input.actor.actorId.trim() !== "" ? null : "actorId",
    input.actor.actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH ? null : "actorIdLength",
    input.now instanceof Date && Number.isFinite(input.now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A listing setting request breaks the ledger contract.", { invalid });
}

/** A stored request that breaks its contract is refused with its ledger id. */
function mapListingSettingRequestRow(row: ListingSettingRequestRow): ListingSettingRequestRecord {
  return withStoredRowIds({ id: String(row.id) }, () => mapListingSettingRequestColumns(row));
}

function mapListingSettingRequestColumns(row: ListingSettingRequestRow): ListingSettingRequestRecord {
  const operation = row.operation;
  const actorType = row.actor_type;
  if (typeof operation !== "string" || !(LISTING_SETTING_REQUEST_OPERATIONS as readonly string[]).includes(operation)
    || typeof actorType !== "string" || !(LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(actorType)
    || typeof row.idempotency_key !== "string" || typeof row.request_hash !== "string"
    || typeof row.actor_id !== "string") {
    throw listingSettingsInvariantFailed("A stored listing setting request failed its contract.");
  }
  const productCount = storedCount(row.product_count, "product_count");
  return {
    id: storedId(row.id, "id"),
    vendorId: storedId(row.vendor_id, "vendor_id"),
    storeConnectionId: storedId(row.store_connection_id, "store_connection_id"),
    operation: operation as ListingSettingRequestOperation,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    productCount,
    actorType: actorType as ListingSettingActorType,
    actorId: row.actor_id,
    createdAt: storedTimestamp(row.created_at, "created_at"),
  };
}

/** bigint columns arrive as strings; anything that is not a whole number is refused, never coerced. */
function storedCount(value: unknown, column: string): number {
  const count = typeof value === "number" ? value
    : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw listingSettingsInvariantFailed("A stored listing setting request value failed its contract.", { column });
  }
  return count;
}

function storedId(value: unknown, column: string): number {
  const id = storedCount(value, column);
  if (id <= 0) throw listingSettingsInvariantFailed("A stored listing setting request value failed its contract.", { column });
  return id;
}
