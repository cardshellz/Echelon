import type { PoolClient } from "pg";
import { z } from "zod";
import {
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  PRODUCT_LISTING_SETTING_FIELDS,
  productListingSettingBulkPatchSchema,
  productListingSettingPatchSchema,
  productListingSettingRowSchema,
  productListingSettingValuesSchema,
  type ProductListingSettingBulkPatch,
  type ProductListingSettingField,
  type ProductListingSettingPatch,
  type ProductListingSettingRow,
  type ProductListingSettingValues,
} from "../../../../shared/dropship/listing-setting-values";
import type {
  ProductListingSettingSaveInput,
  ProductListingSettingSaveResult,
  ProductListingSettingsBulkInput,
  ProductListingSettingsBulkResult,
} from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import {
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  applyListingSettingPatch,
  changedListingSettingFields,
  listingSettingBulkAuditValues,
  listingSettingChildKey,
  listingSettingsInvariantFailed,
} from "../domain/listing-setting-values";
import {
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
  PRODUCT_LISTING_SETTING_VALUE_COLUMNS,
  assertListingSettingRequestMatches,
  findListingSettingRequestWithClient,
  insertListingSettingRequestWithClient,
  listingSettingsIdempotencyConflict,
  productListingSettingRowFromColumns,
  productValuesToColumns,
  type ListingSettingRequestRecord,
  type ListingSettingWriteScope,
  type ProductListingSettingValueColumns,
  type StoredListingSettingRevisionColumns,
  type StoredProductListingSettingColumns,
} from "./dropship-listing-setting-shared.repository";

/**
 * A vendor's own listing settings for Card Shellz products (plan PR 8a,
 * section 3.8; migration 0736): the current-row read, the one-product
 * compare-and-set save (W5) and the set-based save for many products (W6, and
 * W12's "Also clear theirs"). Every function runs on the caller's transaction
 * client, assumes the caller holds the locks of plan 3.9 (request key, store,
 * owner rows, catalog) and takes no lock itself except FOR UPDATE on its own
 * target rows. Audit rows are written in the same transaction, so they commit
 * or roll back with the change. Repositories do not log; PR 9's services do.
 */

type QueryClient = Pick<PoolClient, "query">;

/** Product, revision, vendor and store ids are int4 keys. */
const MAX_INT4_ID = 2_147_483_647;
/** A version conflict names at most this many products so a 10,000-product 409 stays small; conflictCount gives the total. */
const MAX_REPORTED_CONFLICTS = 100;
/** Issues an error reports: enough to find the fault, small enough to log. */
const MAX_REPORTED_ISSUES = 10;
/**
 * UTF-8 bytes of record JSON one bulk revision insert carries. PostgreSQL
 * refuses a jsonb array whose elements total more than 268,435,455 bytes
 * (54000), and a product at the stored contract's largest values (20,000-
 * character main text, 4,000-character text above and below, 3-byte
 * characters) is a record of about 100 KB, so 10,000 of them are several
 * times past it. A quarter of the limit leaves room for jsonb's own per-value
 * overhead over the JSON text (escapes only shrink). 10,000 products stay one
 * statement while their records average under 6.7 KB (short stored texts).
 */
const MAX_BULK_REVISION_PAYLOAD_BYTES = 64 * 1024 * 1024;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** W7's price apply is PR 9 (plan D5, D28): until then a bulk save is one of these. */
const BULK_OPERATIONS = ["product_settings_bulk", "category_settings_clear"] as const satisfies readonly ProductListingSettingsBulkInput["operation"][];

const int4Id = z.number().int().positive().max(MAX_INT4_ID);

/**
 * A bulk request as the writer accepts it (plan D28, F3): one of the two
 * operations, 1 to 10,000 distinct products (ON CONFLICT cannot touch one row
 * twice in a statement, 21000), and a patch with no price and the main text
 * only as a reset. Unknown keys on a product entry are dropped.
 */
const bulkRequestSchema = z.object({
  operation: z.enum(BULK_OPERATIONS),
  products: z.array(z.object({ productId: int4Id, expectedRevisionId: int4Id.nullable() }))
    .min(1).max(MAX_LISTING_SETTING_BULK_PRODUCTS)
    .refine((products) => new Set(products.map((product) => product.productId)).size === products.length, "Each product once."),
  patch: productListingSettingBulkPatchSchema,
});

const VALUE_COLUMN_LIST = PRODUCT_LISTING_SETTING_VALUE_COLUMNS.join(", ");
const STORED_VALUE_COLUMN_LIST = PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `r.${column}`).join(", ");
/** The column list both revision inserts write, in table order; values come from productValuesToColumns. */
const REVISION_INSERT_COLUMNS = `vendor_id, store_connection_id, product_id, previous_revision_id, request_id, ${VALUE_COLUMN_LIST},
       idempotency_key, request_hash, actor_type, actor_id, created_at`;

const REVISION_BY_KEY_SQL = `SELECT r.id AS revision_id, r.store_connection_id, r.product_id, r.request_id, r.request_hash,
       ${STORED_VALUE_COLUMN_LIST}, r.created_at
     FROM dropship.dropship_product_listing_setting_revisions r
     WHERE r.vendor_id = $1 AND r.idempotency_key = $2`;

/** $1-$4 are the target, $5 onwards the value columns in table order, then the key, hash, actor and clock. */
const FIRST_VALUE_PARAM = 5;
const SINGLE_REVISION_INSERT_SQL = singleRevisionInsertSql();

const SINGLE_CURRENT_UPSERT_SQL = `INSERT INTO dropship.dropship_product_listing_settings
       (vendor_id, store_connection_id, product_id, revision_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (store_connection_id, product_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`;

const SINGLE_AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_product_listing_setting', $3, 'product_listing_settings_saved', $4, $5, 'info', $6::jsonb, $7)`;

/**
 * One statement for every changed product (plan 3.8 step 6), or one per
 * MAX_BULK_REVISION_PAYLOAD_BYTES of records. Each record carries its
 * product, predecessor, value columns and child key; the request, hash, actor
 * and clock are shared parameters.
 */
const BULK_REVISION_INSERT_SQL = `INSERT INTO dropship.dropship_product_listing_setting_revisions
       (${REVISION_INSERT_COLUMNS})
     SELECT $1, $2, x.product_id, x.previous_revision_id, $3,
            ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `x.${column}`).join(", ")},
            x.child_key, $4, $5, $6, $7
     FROM jsonb_to_recordset($8::jsonb) AS x(product_id integer, previous_revision_id integer,
       ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `${column} ${LISTING_SETTING_VALUE_COLUMN_TYPES[column]}`).join(", ")},
       child_key text)
     RETURNING id, product_id`;

const BULK_CURRENT_UPSERT_SQL = `INSERT INTO dropship.dropship_product_listing_settings
       (vendor_id, store_connection_id, product_id, revision_id)
     SELECT $1, $2, x.product_id, x.revision_id
     FROM jsonb_to_recordset($3::jsonb) AS x(product_id integer, revision_id integer)
     ON CONFLICT (store_connection_id, product_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`;

const BULK_AUDIT_SQL = `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     SELECT $1, $2, 'dropship_product_listing_setting', x.product_id::text, 'product_listing_settings_saved', $3, $4, 'info',
            x.payload, $5
     FROM jsonb_to_recordset($6::jsonb) AS x(product_id integer, payload jsonb)`;

const BULK_REPLAY_SQL = `SELECT product_id, id
     FROM dropship.dropship_product_listing_setting_revisions
     WHERE request_id = $1
     ORDER BY product_id`;

type StoredCurrentRow = StoredProductListingSettingColumns & StoredListingSettingRevisionColumns & { product_id: unknown };
type StoredRevisionByKeyRow = StoredCurrentRow & {
  store_connection_id: unknown;
  request_id: unknown;
  request_hash: unknown;
};
interface ProductVersionConflict {
  productId: number;
  expectedRevisionId: number | null;
  actualRevisionId: number | null;
}
/** A checked bulk request, products in ascending id order. */
interface BulkRequest {
  operation: (typeof BULK_OPERATIONS)[number];
  products: Array<{ productId: number; expectedRevisionId: number | null }>;
  patch: ProductListingSettingBulkPatch;
}
interface ProductChange {
  productId: number;
  before: ProductListingSettingRow | null;
  after: ProductListingSettingValues;
  changedFields: ProductListingSettingField[];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Current rows by product id, each parsed with the stored contract (plan D27):
 * a row that breaks it is DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED with its
 * ids, never a guess. A product with no row is absent. No ids, no query. The
 * lock text is in the statement only when `forUpdate` is set, so read-only
 * callers send none; it locks the current rows found, in product order.
 */
export async function readProductListingSettings(
  client: QueryClient,
  input: { vendorId: number; storeConnectionId: number; productIds: readonly number[]; forUpdate?: boolean },
): Promise<Map<number, ProductListingSettingRow>> {
  const invalid = input.productIds.filter((productId) => !isInt4Id(productId));
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("Product listing settings were read for an invalid product id.", {
      invalidCount: invalid.length,
    });
  }
  const productIds = [...new Set(input.productIds)].sort((left, right) => left - right);
  if (productIds.length === 0) return new Map();
  const result = await client.query<StoredCurrentRow>(
    `SELECT s.product_id, s.revision_id, ${STORED_VALUE_COLUMN_LIST}, r.created_at
     FROM dropship.dropship_product_listing_settings s
     JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id
       AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id AND r.product_id = s.product_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_id = ANY($3::int[])
     ORDER BY s.product_id${input.forUpdate ? " FOR UPDATE OF s" : ""}`,
    [input.vendorId, input.storeConnectionId, productIds],
  );
  const rows = new Map<number, ProductListingSettingRow>();
  for (const stored of result.rows) {
    const row = productListingSettingRowFromColumns(input.storeConnectionId, stored);
    rows.set(row.productId, row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// One product (W5)
// ---------------------------------------------------------------------------

/**
 * Compare-and-set for one product, keyed by the transaction's request key:
 * 1. a key that already wrote a revision answers `replayed` with that stored
 *    revision (it may no longer be current; a later edit is never
 *    overwritten), or DROPSHIP_IDEMPOTENCY_CONFLICT when it was for another
 *    store, product or request. `before` and `changedFields` are not rebuilt
 *    for a replay: the page re-reads after any save (PR 7 D9);
 * 2. the current row FOR UPDATE must be the revision the vendor saw;
 * 3. a patch that sets what is already stored writes nothing (`unchanged`,
 *    plan D12); a retry of it re-evaluates and also writes nothing;
 * 4. otherwise revision, current row and audit row, in that order.
 * Inputs are checked before any SQL. They come from PR 9's service, which
 * parses the route input, so a breach is a programming fault (fatal).
 */
export async function saveProductListingSettingWithClient(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  input: ProductListingSettingSaveInput,
): Promise<ProductListingSettingSaveResult> {
  assertWriteScope(scope);
  const patch = parseSingleSave(input);

  const replay = await client.query<StoredRevisionByKeyRow>(REVISION_BY_KEY_SQL, [scope.vendorId, scope.requestKey]);
  if (replay.rows[0]) {
    return { outcome: "replayed", row: replayedRevision(replay.rows[0], scope, input), before: null, changedFields: [] };
  }

  const current = await readProductListingSettings(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, productIds: [input.productId], forUpdate: true,
  });
  assertExpectedRevisions(scope.storeConnectionId, [input], current);
  const before = current.get(input.productId) ?? null;
  const after = mergedValues(input.productId, before, patch);
  const changedFields = changedListingSettingFields(before?.values ?? null, after, PRODUCT_LISTING_SETTING_FIELDS);
  if (changedFields.length === 0) return { outcome: "unchanged", row: before, before, changedFields: [] };

  const previousRevisionId = before?.revisionId ?? null;
  const inserted = await client.query<{ id: unknown }>(SINGLE_REVISION_INSERT_SQL, [
    scope.vendorId, scope.storeConnectionId, input.productId, previousRevisionId,
    ...singleRowValueParams(productValuesToColumns(after)),
    scope.requestKey, input.requestHash, scope.actor.actorType, scope.actor.actorId, input.now,
  ]);
  const revisionId = returnedId(inserted.rows[0]?.id);
  await client.query(SINGLE_CURRENT_UPSERT_SQL, [scope.vendorId, scope.storeConnectionId, input.productId, revisionId]);
  const row = savedRow({
    storeConnectionId: scope.storeConnectionId, productId: input.productId, revisionId,
    updatedAt: input.now.toISOString(), values: after,
  });
  await client.query(SINGLE_AUDIT_SQL, [
    scope.vendorId, scope.storeConnectionId, String(input.productId), scope.actor.actorType, scope.actor.actorId,
    JSON.stringify({
      requestKey: scope.requestKey, revisionId, previousRevisionId,
      before: before?.values ?? null, after, changedFields,
    }),
    input.now,
  ]);
  return { outcome: "changed", row, before, changedFields };
}

// ---------------------------------------------------------------------------
// Many products (W6, W12 "Also clear theirs")
// ---------------------------------------------------------------------------

/**
 * One patch for up to 10,000 products, all or nothing, set-based:
 * 1. the request is checked before any SQL (DROPSHIP_LISTING_SETTINGS_BULK_INVALID);
 * 2. a key already in the ledger is a replay (same store, operation and hash,
 *    else DROPSHIP_IDEMPOTENCY_CONFLICT), answered from the revisions it wrote;
 *    a count that differs from the ledger's is DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE;
 * 3. every product's current row FOR UPDATE must be the revision the vendor
 *    saw; one mismatch refuses the whole request, naming the products;
 * 4. merged in TypeScript, then four statements whatever the product count:
 *    the ledger row (always, even when nothing changed, so a replay is exact,
 *    plan D12), one revision insert, one current-row upsert and one audit
 *    insert. Only records over MAX_BULK_REVISION_PAYLOAD_BYTES in all (long
 *    stored texts across thousands of products) split the revision insert
 *    into more statements, in the same transaction.
 * Each revision carries its child key (plan D10) and the parent's hash. Audit
 * rows carry only the changed settings, texts by digest (plan D28); the full
 * texts are in the revisions the audit rows name.
 */
export async function saveProductListingSettingsBulkWithClient(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  input: ProductListingSettingsBulkInput,
): Promise<ProductListingSettingsBulkResult> {
  assertWriteScope(scope);
  assertRequestStamp(input.requestHash, input.now);
  const request = parseBulkRequest(input);

  const prior = await findListingSettingRequestWithClient(client, { vendorId: scope.vendorId, idempotencyKey: scope.requestKey });
  if (prior) return replayBulk(client, prior, scope, request, input.requestHash);

  const current = await readProductListingSettings(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId,
    productIds: request.products.map((product) => product.productId), forUpdate: true,
  });
  assertExpectedRevisions(scope.storeConnectionId, request.products, current);

  const changes: ProductChange[] = [];
  const unchangedProductIds: number[] = [];
  for (const { productId } of request.products) {
    const before = current.get(productId) ?? null;
    const merged = applyListingSettingPatch<ProductListingSettingValues>(
      before?.values ?? EMPTY_PRODUCT_LISTING_SETTING_VALUES, request.patch);
    const changedFields = changedListingSettingFields(before?.values ?? null, merged, PRODUCT_LISTING_SETTING_FIELDS);
    if (changedFields.length === 0) {
      unchangedProductIds.push(productId);
    } else {
      changes.push({ productId, before, after: parseMergedValues(productId, merged), changedFields });
    }
  }

  // Claims the key: a concurrent first use is 23505 on the ledger key index, which the wrapper maps.
  const requestId = await insertListingSettingRequestWithClient(client, {
    vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId, operation: request.operation,
    idempotencyKey: scope.requestKey, requestHash: input.requestHash, productCount: changes.length,
    actor: scope.actor, now: input.now,
  });
  if (changes.length === 0) return { outcome: "unchanged", requestId, changed: [], unchangedProductIds };

  const changed = await insertBulkRevisions(client, scope, requestId, input, changes);
  await client.query(BULK_CURRENT_UPSERT_SQL, [
    scope.vendorId, scope.storeConnectionId,
    JSON.stringify(changed.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId }))),
  ]);
  await client.query(BULK_AUDIT_SQL, [
    scope.vendorId, scope.storeConnectionId, scope.actor.actorType, scope.actor.actorId, input.now,
    JSON.stringify(changes.map((change, index) => ({
      product_id: change.productId,
      payload: {
        requestKey: scope.requestKey, requestId, operation: request.operation,
        revisionId: changed[index].revisionId, previousRevisionId: change.before?.revisionId ?? null,
        changedFields: change.changedFields,
        before: listingSettingBulkAuditValues(change.before?.values ?? null, change.changedFields),
        after: listingSettingBulkAuditValues(change.after, change.changedFields),
      },
    }))),
  ]);
  return { outcome: "changed", requestId, changed, unchangedProductIds };
}

/** The revisions an applied request wrote, by product; every other product of the same request was unchanged. */
async function replayBulk(
  client: QueryClient,
  prior: ListingSettingRequestRecord,
  scope: ListingSettingWriteScope,
  request: BulkRequest,
  requestHash: string,
): Promise<ProductListingSettingsBulkResult> {
  assertListingSettingRequestMatches(prior, { storeConnectionId: scope.storeConnectionId, operation: request.operation, requestHash });
  const written = await client.query<{ product_id: unknown; id: unknown }>(BULK_REPLAY_SQL, [prior.id]);
  if (written.rows.length !== prior.productCount) {
    throw new DropshipError("DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
      "The saved listing settings request is incomplete; nothing was changed.", {
        requestId: prior.id, expectedCount: prior.productCount, foundCount: written.rows.length,
        retryable: false, classification: "fatal",
      });
  }
  const changed = written.rows.map((row) => ({ productId: returnedId(row.product_id), revisionId: returnedId(row.id) }));
  const changedIds = new Set(changed.map((entry) => entry.productId));
  return {
    outcome: "replayed", requestId: prior.id, changed,
    unchangedProductIds: request.products.map((product) => product.productId).filter((productId) => !changedIds.has(productId)),
  };
}

/**
 * One statement per MAX_BULK_REVISION_PAYLOAD_BYTES of records (one unless
 * stored texts are long), in product order; the returned ids must cover
 * exactly the changed products. RETURNING order is not guaranteed, so the
 * result is rebuilt in `changes` order: entry i is the revision of changes[i].
 */
async function insertBulkRevisions(
  client: QueryClient,
  scope: ListingSettingWriteScope,
  requestId: number,
  input: ProductListingSettingsBulkInput,
  changes: readonly ProductChange[],
): Promise<Array<{ productId: number; revisionId: number }>> {
  const records = changes.map((change) => ({
    product_id: change.productId,
    previous_revision_id: change.before?.revisionId ?? null,
    ...productValuesToColumns(change.after),
    child_key: listingSettingChildKey(scope.requestKey, "product", change.productId),
  }));
  const revisionIds = new Map<number, number>();
  let returnedCount = 0;
  for (const recordsJson of jsonArrayChunks(records, MAX_BULK_REVISION_PAYLOAD_BYTES)) {
    const inserted = await client.query<{ id: unknown; product_id: unknown }>(BULK_REVISION_INSERT_SQL, [
      scope.vendorId, scope.storeConnectionId, requestId, input.requestHash, scope.actor.actorType, scope.actor.actorId,
      input.now, recordsJson,
    ]);
    returnedCount += inserted.rows.length;
    for (const row of inserted.rows) revisionIds.set(returnedId(row.product_id), returnedId(row.id));
  }
  const changed = changes.map((change) => ({ productId: change.productId, revisionId: revisionIds.get(change.productId) }));
  if (returnedCount !== changes.length || changed.some((entry) => entry.revisionId === undefined)) {
    throw listingSettingsInvariantFailed("The product listing setting revision insert did not return one row per product.", {
      expectedCount: changes.length, returnedCount,
    });
  }
  return changed.map((entry) => ({ productId: entry.productId, revisionId: entry.revisionId as number }));
}

/**
 * The records as JSON array texts of at most `maxBytes` UTF-8 bytes each, in
 * order, built one chunk at a time so only one chunk's text is held. A record
 * is never split; one larger than `maxBytes` (none is, under the stored
 * contract) goes alone.
 */
function* jsonArrayChunks(records: readonly unknown[], maxBytes: number): Generator<string> {
  const BRACKETS_BYTES = 2;
  let parts: string[] = [];
  let bytes = BRACKETS_BYTES;
  for (const record of records) {
    const part = JSON.stringify(record);
    // Each part after the first adds a comma; counting one for every part keeps the bound safe.
    const partBytes = Buffer.byteLength(part, "utf8") + 1;
    if (parts.length > 0 && bytes + partBytes > maxBytes) {
      yield `[${parts.join(",")}]`;
      parts = [];
      bytes = BRACKETS_BYTES;
    }
    parts.push(part);
    bytes += partBytes;
  }
  if (parts.length > 0) yield `[${parts.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Checks and mapping
// ---------------------------------------------------------------------------

/** The wrapper builds the scope; a scope outside the contract is a programming fault. */
function assertWriteScope(scope: ListingSettingWriteScope): void {
  const actorId = scope.actor.actorId;
  const invalid = [
    isInt4Id(scope.vendorId) ? null : "vendorId",
    isInt4Id(scope.storeConnectionId) ? null : "storeConnectionId",
    typeof scope.requestKey === "string" && LISTING_SETTING_KEY_PATTERN.test(scope.requestKey) ? null : "requestKey",
    (LISTING_SETTING_ACTOR_TYPES as readonly string[]).includes(scope.actor.actorType) ? null : "actorType",
    typeof actorId === "string" && actorId.trim() !== "" && actorId.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH ? null : "actorId",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A product listing settings write was called outside its contract.", { invalid });
  }
}

function assertRequestStamp(requestHash: unknown, now: unknown): void {
  const invalid = [
    typeof requestHash === "string" && REQUEST_HASH_PATTERN.test(requestHash) ? null : "requestHash",
    now instanceof Date && Number.isFinite(now.getTime()) ? null : "now",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A product listing settings write was called outside its contract.", { invalid });
  }
}

/** The one-product input; issue paths and codes only, so no vendor text reaches an error. */
function parseSingleSave(input: ProductListingSettingSaveInput): ProductListingSettingPatch {
  assertRequestStamp(input.requestHash, input.now);
  const invalid = [
    isInt4Id(input.productId) ? null : "productId",
    input.expectedRevisionId === null || isInt4Id(input.expectedRevisionId) ? null : "expectedRevisionId",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) {
    throw listingSettingsInvariantFailed("A product listing settings write was called outside its contract.", { invalid });
  }
  const patch = productListingSettingPatchSchema.safeParse(input.patch);
  if (!patch.success) {
    throw listingSettingsInvariantFailed("A product listing settings change failed its contract.", {
      productId: input.productId, issues: issueCodes(patch.error),
    });
  }
  return patch.data;
}

/**
 * The vendor's request for many products (400, permanent). Issues carry paths
 * and codes; only a custom issue keeps its message, because those are the
 * contracts' fixed sentences. Zod's own messages can quote what was sent (an
 * enum value received, an unrecognized key), so they never reach an error.
 */
function parseBulkRequest(input: ProductListingSettingsBulkInput): BulkRequest {
  const parsed = bulkRequestSchema.safeParse({ operation: input.operation, products: input.products, patch: input.patch });
  if (!parsed.success) {
    throw new DropshipError("DROPSHIP_LISTING_SETTINGS_BULK_INVALID", "This change for many products is not valid.", {
      issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.join("."), code: issue.code,
        ...(issue.code === z.ZodIssueCode.custom ? { message: issue.message } : {}),
      })),
      retryable: false, classification: "permanent",
    });
  }
  // Ascending ids: rows are locked, compared and written in one order.
  const products = [...parsed.data.products].sort((left, right) => left.productId - right.productId);
  return { operation: parsed.data.operation, products, patch: parsed.data.patch };
}

/** A key that already wrote a revision may be replayed only for the same store, product and request, and never a bulk child. */
function replayedRevision(
  stored: StoredRevisionByKeyRow,
  scope: ListingSettingWriteScope,
  input: ProductListingSettingSaveInput,
): ProductListingSettingRow {
  const mismatched = [
    Number(stored.store_connection_id) !== scope.storeConnectionId ? "storeConnectionId" : null,
    Number(stored.product_id) !== input.productId ? "productId" : null,
    stored.request_hash !== input.requestHash ? "requestHash" : null,
    stored.request_id !== null ? "requestId" : null,
  ].filter((field): field is string => field !== null);
  if (mismatched.length > 0) throw listingSettingsIdempotencyConflict({ mismatched });
  return productListingSettingRowFromColumns(scope.storeConnectionId, stored);
}

/** null on either side is "no row yet"; the store lock serializes first saves. */
function assertExpectedRevisions(
  storeConnectionId: number,
  products: ReadonlyArray<{ productId: number; expectedRevisionId: number | null }>,
  current: ReadonlyMap<number, ProductListingSettingRow>,
): void {
  const conflicts: ProductVersionConflict[] = [];
  for (const { productId, expectedRevisionId } of products) {
    const actualRevisionId = current.get(productId)?.revisionId ?? null;
    if (actualRevisionId !== expectedRevisionId) conflicts.push({ productId, expectedRevisionId, actualRevisionId });
  }
  if (conflicts.length === 0) return;
  throw new DropshipError("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
    "Listing settings changed after you opened them. Reload them before saving again.", {
      storeConnectionId, conflicts: conflicts.slice(0, MAX_REPORTED_CONFLICTS), conflictCount: conflicts.length,
      retryable: false, classification: "permanent",
    });
}

function mergedValues(productId: number, before: ProductListingSettingRow | null, patch: ProductListingSettingPatch): ProductListingSettingValues {
  return parseMergedValues(productId, applyListingSettingPatch<ProductListingSettingValues>(
    before?.values ?? EMPTY_PRODUCT_LISTING_SETTING_VALUES, patch));
}

/**
 * Parsed stored values with a parsed patch merged in. Every setting is checked
 * on its own, so this cannot fail unless a caller bypassed a contract; the
 * values are checked again because they are about to be stored.
 */
function parseMergedValues(productId: number, merged: ProductListingSettingValues): ProductListingSettingValues {
  const parsed = productListingSettingValuesSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("Merged product listing setting values failed their contract.", {
    productId, issues: issueCodes(parsed.error),
  });
}

function savedRow(row: ProductListingSettingRow): ProductListingSettingRow {
  const parsed = productListingSettingRowSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  throw listingSettingsInvariantFailed("A saved product listing setting row failed its contract.", {
    productId: row.productId, revisionId: row.revisionId, issues: issueCodes(parsed.error),
  });
}

/**
 * A single-row insert sends each jsonb column as JSON text cast with ::jsonb
 * (node-postgres would send a JS array as a PostgreSQL array). null stays SQL
 * NULL: JSON.stringify(null) would store the JSON value null, which the
 * all-or-none CHECKs count as set.
 */
function singleRowValueParams(columns: ProductListingSettingValueColumns): unknown[] {
  return PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => {
    const value = columns[column];
    if (LISTING_SETTING_VALUE_COLUMN_TYPES[column] !== "jsonb" || value === null) return value;
    return JSON.stringify(value);
  });
}

function singleRevisionInsertSql(): string {
  const values = PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column, index) => {
    const placeholder = `$${FIRST_VALUE_PARAM + index}`;
    return LISTING_SETTING_VALUE_COLUMN_TYPES[column] === "jsonb" ? `${placeholder}::jsonb` : placeholder;
  });
  const tail = FIRST_VALUE_PARAM + PRODUCT_LISTING_SETTING_VALUE_COLUMNS.length;
  return `INSERT INTO dropship.dropship_product_listing_setting_revisions
       (${REVISION_INSERT_COLUMNS})
     VALUES ($1, $2, $3, $4, NULL, ${values.join(", ")},
       $${tail}, $${tail + 1}, $${tail + 2}, $${tail + 3}, $${tail + 4})
     RETURNING id`;
}

/** An identity PostgreSQL returned (int4 as a number, bigint as a string); anything else is refused, never coerced. */
function returnedId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!isInt4Id(id)) throw listingSettingsInvariantFailed("A product listing setting statement returned an invalid identity.");
  return id;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}

function issueCodes(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
