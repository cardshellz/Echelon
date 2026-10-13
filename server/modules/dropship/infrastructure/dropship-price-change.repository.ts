import type { PoolClient } from "pg";
import type { z } from "zod";
import { LISTING_SETTING_KEY_PATTERN } from "../../../../shared/dropship/listing-setting-values";
import {
  PRICE_CHANGE_REVIEW_KINDS,
  priceChangeReviewIdSchema,
  priceChangeRowsSchema,
  storedInputSchemaFor,
  type PriceChangeReviewKind,
} from "../../../../shared/dropship/listing-setting-writes";
import type {
  ListingSettingActor,
  LoadedPriceChangeReview,
  PriceChangeApplyRequest,
  StoredPriceChangeReview,
} from "../application/dropship-listing-setting-writes";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { listingSettingLedgerRowFaults } from "./dropship-listing-setting-shared.repository";

/**
 * W7's own SQL (plan PR 9, 9.1, P22, P23): the price check's stored reviews
 * (dropship_pricing_reviews, 0659, with 0740's kind) and the ledger row that
 * applies one (0750's review id). A file of its own, so 8a's ledger SQL and
 * W1's review SQL, each pinned by its own tests, stay as they are. Every
 * function takes the caller's client (or the pool, for the page's one
 * statement), assumes the caller holds what locks it needs and takes none.
 * Repositories do not log; PR 9's services do.
 */

type QueryClient = Pick<PoolClient, "query">;

/** int4 keys (vendor, store connection). */
const MAX_INT4_ID = 2_147_483_647;
const REVIEW_HASH_PATTERN = /^[a-f0-9]{64}$/;
/** Issues an error reports: enough to find the fault, small enough to log. */
const MAX_REPORTED_ISSUES = 10;

/** The two W7 kinds as SQL literals, from the shared list (constants, never input). */
const PRICE_CHANGE_KINDS_SQL = PRICE_CHANGE_REVIEW_KINDS.map((kind) => `'${kind}'`).join(", ");

/**
 * The review insert names its kind (W1's names none, so its reviews take
 * 0740's store_default). It returns the rows' size as PostgreSQL stores them,
 * `octet_length(rows::text)`, the same measure the apply's load reads, so the
 * review and its apply count the rows toward the heavy-write budget alike
 * (plan 9.7's memory stop rule).
 */
const PRICE_CHANGE_REVIEW_INSERT_SQL = `INSERT INTO dropship.dropship_pricing_reviews
       (id, vendor_id, store_connection_id, kind, input, rows, review_hash, actor_id, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)
     RETURNING octet_length(rows::text) AS rows_bytes`;
/**
 * A review of this vendor and store, of a W7 kind: W1's store default
 * reviews read as not found. With its rows' stored size (plan 9.7's memory
 * stop rule), in the same statement.
 */
const PRICE_CHANGE_REVIEW_SQL = `SELECT r.id, r.kind, r.input, r.rows, r.review_hash, r.created_at, octet_length(r.rows::text) AS rows_bytes
     FROM dropship.dropship_pricing_reviews r
     WHERE r.id = $1 AND r.vendor_id = $2 AND r.store_connection_id = $3 AND r.kind IN (${PRICE_CHANGE_KINDS_SQL})`;
/** The same review, found by the member who owns its store (the page's read, plan 9.6): one statement, no lock. */
const MEMBER_PRICE_CHANGE_REVIEW_SQL = `SELECT r.id, r.kind, r.input, r.rows, r.review_hash, r.created_at
     FROM dropship.dropship_pricing_reviews r
     JOIN dropship.dropship_store_connections sc ON sc.id = r.store_connection_id AND sc.vendor_id = r.vendor_id
     JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
     WHERE r.id = $1 AND r.store_connection_id = $2 AND v.member_id::text = $3 AND r.kind IN (${PRICE_CHANGE_KINDS_SQL})`;
/**
 * 0738's ledger insert with the review id (0750). The operation is a literal:
 * this insert writes only W7's apply, and 0738's insert never writes it.
 */
const PRICE_CHANGE_APPLY_INSERT_SQL = `INSERT INTO dropship.dropship_product_listing_setting_requests
       (vendor_id, store_connection_id, operation, review_id, idempotency_key, request_hash, product_count,
        actor_type, actor_id, created_at)
     VALUES ($1, $2, 'price_change_apply', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`;
/** The row that applied a review, of this vendor and store (v3r, C-money-4), on 0750's partial unique index. */
const PRICE_CHANGE_APPLY_BY_REVIEW_SQL = `SELECT id, operation, idempotency_key
     FROM dropship.dropship_product_listing_setting_requests
     WHERE vendor_id = $1 AND store_connection_id = $2 AND review_id = $3`;

interface StoredReviewRow {
  id: unknown;
  kind: unknown;
  input: unknown;
  rows: unknown;
  review_hash: unknown;
  created_at: unknown;
  rows_bytes?: unknown;
}

/**
 * Stores one W7 price check under this vendor and store, its kind named,
 * with the member as its actor. The review is checked first: its id (as the
 * server issues it), its stored input against its kind's schema, its rows
 * and its hash. A breach is a programming fault, refused before any SQL. The
 * parsed input and rows are what is stored, so a load parses them back to
 * the same values the hash was computed over. Returns the rows' stored size
 * in bytes (`octet_length(rows::text)`; UTF-8 bytes on a UTF8 server).
 */
export async function insertPriceChangeReviewWithClient(
  client: QueryClient,
  target: { vendorId: number; storeConnectionId: number; actorId: string },
  review: StoredPriceChangeReview,
): Promise<{ rowsBytes: number }> {
  assertTarget(target);
  if (typeof target.actorId !== "string" || target.actorId.trim() === "") {
    throw listingSettingsInvariantFailed("A price change review is stored only with its actor.");
  }
  const checked = checkedReview(review, "A price change review to store failed its contract.");
  const result = await client.query<{ rows_bytes: unknown }>(PRICE_CHANGE_REVIEW_INSERT_SQL, [
    checked.id, target.vendorId, target.storeConnectionId, checked.kind,
    JSON.stringify(checked.input), JSON.stringify(checked.rows), checked.reviewHash, target.actorId, checked.createdAt,
  ]);
  return { rowsBytes: storedRowsBytes(result.rows[0]?.rows_bytes, checked.id) };
}

/**
 * A W7 review of this vendor and store by id, parsed, with its rows' stored
 * size in bytes, or null (a store default review included). No lock.
 */
export async function loadPriceChangeReviewWithClient(
  client: QueryClient,
  target: { vendorId: number; storeConnectionId: number },
  reviewId: string,
): Promise<LoadedPriceChangeReview | null> {
  assertTarget(target);
  assertReviewId(reviewId);
  const result = await client.query<StoredReviewRow>(PRICE_CHANGE_REVIEW_SQL, [reviewId, target.vendorId, target.storeConnectionId]);
  const review = storedReview(result.rows, reviewId);
  return review === null ? null : { ...review, rowsBytes: storedRowsBytes(result.rows[0].rows_bytes, reviewId) };
}

/**
 * The member's W7 review on this store by id, parsed, or null: another
 * member's, another store's, a store default review and a missing one alike.
 * One statement on the given pool (plan 9.6): no transaction, no lock.
 */
export async function readPriceChangeReviewForMember(
  queryable: QueryClient,
  input: { memberId: string; storeConnectionId: number; reviewId: string },
): Promise<StoredPriceChangeReview | null> {
  if (typeof input.memberId !== "string" || input.memberId.trim() === "" || !isInt4Id(input.storeConnectionId)) {
    throw listingSettingsInvariantFailed("A price change review page was read outside its contract.");
  }
  assertReviewId(input.reviewId);
  const result = await queryable.query<StoredReviewRow>(MEMBER_PRICE_CHANGE_REVIEW_SQL,
    [input.reviewId, input.storeConnectionId, input.memberId]);
  return storedReview(result.rows, input.reviewId);
}

/**
 * Claims the request key for W7's apply of one review and returns the ledger
 * id (plan P23, 9.7): 0738's ledger contract, the operation
 * `price_change_apply` and the review id, in one row. A key already used is
 * 23505 on the key index, and a review already applied 23505 on 0750's
 * review index; the wrapper maps both to DROPSHIP_IDEMPOTENCY_CONFLICT. The
 * review must be this vendor's and this store's, else 23503 on 0750's
 * foreign key (left unmapped: the apply loads the review by vendor and store
 * first, so it is a fault).
 */
export async function insertPriceChangeApplyRequestWithClient(
  client: QueryClient,
  input: {
    vendorId: number;
    storeConnectionId: number;
    reviewId: string;
    idempotencyKey: string;
    requestHash: string;
    productCount: number;
    actor: ListingSettingActor;
    now: Date;
  },
): Promise<number> {
  const invalid = [
    isInt4Id(input.vendorId) ? null : "vendorId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
    priceChangeReviewIdSchema.safeParse(input.reviewId).success ? null : "reviewId",
    ...listingSettingLedgerRowFaults(input),
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A price change apply request breaks the ledger contract.", { invalid });
  const result = await client.query<{ id: unknown }>(PRICE_CHANGE_APPLY_INSERT_SQL, [
    input.vendorId, input.storeConnectionId, input.reviewId, input.idempotencyKey, input.requestHash,
    input.productCount, input.actor.actorType, input.actor.actorId, input.now,
  ]);
  const row = result.rows[0];
  if (!row) throw listingSettingsInvariantFailed("The price change apply request insert returned no identity.");
  return storedLedgerId(row.id);
}

/**
 * The ledger row that applied this review, of this vendor and store, or
 * null (plan 9.7 step 3; v3r, C-money-4). Scoped by vendor and store because
 * reviews are keyed by id alone: unscoped, another vendor's applied review
 * would answer as applied instead of not found. At most one row (0750's
 * index); a row that breaks its contract is a fault.
 */
export async function findPriceChangeApplyByReviewWithClient(
  client: QueryClient,
  target: { vendorId: number; storeConnectionId: number },
  reviewId: string,
): Promise<PriceChangeApplyRequest | null> {
  assertTarget(target);
  assertReviewId(reviewId);
  const result = await client.query<{ id: unknown; operation: unknown; idempotency_key: unknown }>(
    PRICE_CHANGE_APPLY_BY_REVIEW_SQL, [target.vendorId, target.storeConnectionId, reviewId]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (result.rows.length > 1 || row.operation !== "price_change_apply"
    || typeof row.idempotency_key !== "string" || !LISTING_SETTING_KEY_PATTERN.test(row.idempotency_key)) {
    throw listingSettingsInvariantFailed("A stored price change apply request failed its contract.", { reviewId });
  }
  return { requestId: storedLedgerId(row.id), idempotencyKey: row.idempotency_key };
}

/** At most one row (the review id is the table's key); parsed by its kind, or null. */
function storedReview(rows: readonly StoredReviewRow[], reviewId: string): StoredPriceChangeReview | null {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (rows.length > 1 || row.id !== reviewId) {
    throw listingSettingsInvariantFailed("A stored price change review failed its contract.", { reviewId, column: "id" });
  }
  if (!(row.created_at instanceof Date) || Number.isNaN(row.created_at.getTime())) {
    throw listingSettingsInvariantFailed("A stored price change review failed its contract.", { reviewId, column: "created_at" });
  }
  return checkedReview({
    id: row.id, kind: row.kind, input: row.input, rows: row.rows, reviewHash: row.review_hash, createdAt: row.created_at,
  } as StoredPriceChangeReview, "A stored price change review failed its contract.");
}

/**
 * The review with its input and rows as their schemas parse them. Issue
 * paths and codes only in the error: a stored input can carry eBay names,
 * never copied into an error.
 */
function checkedReview(review: StoredPriceChangeReview, message: string): StoredPriceChangeReview {
  const reviewId = typeof review.id === "string" ? review.id : null;
  if (!priceChangeReviewIdSchema.safeParse(review.id).success) throw listingSettingsInvariantFailed(message, { column: "id" });
  if (!(PRICE_CHANGE_REVIEW_KINDS as readonly unknown[]).includes(review.kind)) {
    throw listingSettingsInvariantFailed(message, { reviewId, column: "kind" });
  }
  if (typeof review.reviewHash !== "string" || !REVIEW_HASH_PATTERN.test(review.reviewHash)) {
    throw listingSettingsInvariantFailed(message, { reviewId, column: "review_hash" });
  }
  if (!(review.createdAt instanceof Date) || Number.isNaN(review.createdAt.getTime())) {
    throw listingSettingsInvariantFailed(message, { reviewId, column: "created_at" });
  }
  const kind = review.kind as PriceChangeReviewKind;
  const input = storedInputSchemaFor(kind).safeParse(review.input);
  if (!input.success) throw listingSettingsInvariantFailed(message, { reviewId, column: "input", issues: issueCodes(input.error) });
  const rows = priceChangeRowsSchema.safeParse(review.rows);
  if (!rows.success) throw listingSettingsInvariantFailed(message, { reviewId, column: "rows", issues: issueCodes(rows.error) });
  return { id: review.id, kind, input: input.data, rows: rows.data, reviewHash: review.reviewHash, createdAt: review.createdAt } as
    StoredPriceChangeReview;
}

/** The caller's scope (the wrapper builds it); outside the contract is a programming fault. */
function assertTarget(target: { vendorId: number; storeConnectionId: number }): void {
  if (!isInt4Id(target.vendorId) || !isInt4Id(target.storeConnectionId)) {
    throw listingSettingsInvariantFailed("A price change read or write was called outside its contract.");
  }
}

/** A review id is parsed by the service before it reaches SQL (a non-uuid would be PostgreSQL's 22P02). */
function assertReviewId(reviewId: unknown): void {
  if (!priceChangeReviewIdSchema.safeParse(reviewId).success) {
    throw listingSettingsInvariantFailed("A price change review is read only by the id the server issued.");
  }
}

/** octet_length of a stored jsonb array's text (int4): at least `[]`'s 2 bytes; anything else is a broken answer. */
function storedRowsBytes(value: unknown, reviewId: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 2) {
    throw listingSettingsInvariantFailed("A stored price change review's size is out of its contract.", { reviewId, column: "rows_bytes" });
  }
  return value;
}

/** The ledger's bigint identity (a string from node-postgres); anything but a safe positive whole number is refused. */
function storedLedgerId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw listingSettingsInvariantFailed("A stored price change apply request failed its contract.", { column: "id" });
  }
  return id;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}

function issueCodes(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
}
