import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  LISTING_SETTING_KEY_PATTERN,
  LISTING_SETTING_REQUEST_OPERATIONS,
  type ListingSettingRequestOperation,
  type ProductListingSettingField,
} from "../../../../shared/dropship/listing-setting-values";
import type { ListingPriceTransaction } from "../application/dropship-listing-price-service";
import { olderGroupRuleCounts, type OlderGroupRuleCounts } from "../application/dropship-listing-settings-facts";
import type {
  CategorySettingFacts,
  ListingSettingActor,
  ListingSettingFacts,
  ListingSettingFactsInput,
  ListingSettingPreflightTransaction,
  ListingSettingReviewTransaction,
  ListingSettingSystemTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
  ListingTextBytes,
  ListingTextBytesInput,
  ProductSettingFacts,
  StoredPriceChangeReview,
} from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { REQUEST_KEY_CHILD_SOURCES, type RequestKeyChildSource, type RequestKeyUse } from "../domain/listing-setting-request-key-use";
import {
  LISTING_SETTING_LEFTOVER_FIELDS,
  isListingSettingChildKey,
  listingSettingChildKey,
  listingSettingChildKeyPrefix,
  listingSettingsInvariantFailed,
  type ListingSettingLeftoverField,
} from "../domain/listing-setting-values";
import { readCategoryListingSettings, saveCategoryListingSettingWithClient } from "./dropship-category-listing-settings.repository";
import { saveEbayCategoryRulesProfileWithClient } from "./dropship-ebay-category-rules.repository";
import { readEbayCategoryRules } from "./dropship-ebay-category-rules.reader";
import { readContentProfile } from "./dropship-listing-content.reader";
import { saveListingContentWithClient } from "./dropship-listing-content.repository";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { readCatalogCategoryNames } from "./dropship-listing-setting-layers.reader";
import { listingPriceTransactionForClient } from "./dropship-listing-price.repository";
import {
  POLICY_FEATURE_LOCK_SQL,
  SHELF_FEATURE_LOCK_SQL,
  clearSizeLeftoversWithClient,
} from "./dropship-listing-setting-leftovers.repository";
import {
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
  listingSettingPriceFromColumns,
  listingSettingsIdempotencyConflict,
  type ListingSettingWriteScope,
} from "./dropship-listing-setting-shared.repository";
import {
  findPriceChangeApplyByReviewWithClient,
  insertPriceChangeReviewWithClient,
  loadPriceChangeReviewWithClient,
  readPriceChangeReviewForMember as readMemberPriceChangeReview,
} from "./dropship-price-change.repository";
import {
  acknowledgeCategoryMovesWithClient,
  insertFirstCategoryMarksWithClient,
  readProductCategoryMarks,
} from "./dropship-product-category-marks.repository";
import {
  readProductListingSettings,
  saveProductListingSettingWithClient,
  saveProductListingSettingsBulkWithClient,
} from "./dropship-product-listing-settings.repository";
import { readPricingProfile } from "./dropship-pricing-profile.reader";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

/**
 * The one transaction PR 9's listing-settings services write through (plan PR
 * 8a, section 3.9). READ COMMITTED (plan D11): every statement after a lock
 * sees what the lock holder committed, as W9 does today. Under REPEATABLE READ
 * or SERIALIZABLE the snapshot would be taken at the first lock call, before
 * the lock is granted.
 *
 * Lock order, the same for every writer so two requests never wait on each
 * other in a cycle:
 * 1. the request key (`dropship_listing_settings_request`, member and key);
 * 2. the store (`dropship_listing_push_job`), shared with queue creation and
 *    every listing writer, so a queue cannot slip between a save's checks and
 *    its writes;
 * 3. the owner rows, vendor and store together, FOR SHARE, before any audit
 *    insert (the audit foreign keys would otherwise take them later, which
 *    deadlocks with order acceptance);
 * 4. lockCatalog, when the operation calls it: the selection tables in SHARE
 *    MODE, then categories, products and sizes FOR SHARE in ascending ids
 *    (categories before products, the order a Card Shellz rename writes them).
 *    The replay probe (findRequestKeyUse) takes no lock and may run before it;
 * 5. the target rows FOR UPDATE, inside the writers;
 * 6. the writes: ledger, revisions, current rows, audit;
 * 7. the per-size leftover clean-ups (clearSizeLeftovers, plan PR 9, P17),
 *    after the parent writer and the size prices: the old per-size writers'
 *    feature locks, policy then shelf, then their rows FOR UPDATE. Those
 *    writers never take the store lock, so this adds no cycle. A writer that
 *    derives a clear set from the leftovers (W12) takes the same two feature
 *    locks earlier, right after lockCatalog, in loadLeftoverFields (plan 3.9,
 *    v3r C-money-6): the order PLAN-v2 §3.9 gives feature locks, cycle-free
 *    for the same reason, and clearSizeLeftovers' second request for a lock
 *    the session holds is granted at once.
 *
 * The read-only preflight (plan PR 9, 6.2 #4) takes none of these locks: it
 * reads one snapshot before any eBay call and writes nothing. W7's price
 * check (executeReview, plan PR 9, 3.9) takes steps 2 and 3 only: no request
 * key, no lockCatalog, no writer; its one write is the review row.
 *
 * The transaction object enforces what it can of that order and of the plan's
 * key rules; a breach is DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED, a
 * programming fault never retried. Database errors are mapped once, after the
 * rollback (see mapListingSettingWriteError). Repositories do not log; PR 9's
 * services log one structured line per write.
 */

type QueryClient = Pick<PoolClient, "query">;

/** int4 keys (store connection, product, category, size). */
const MAX_INT4_ID = 2_147_483_647;

/** The request key's advisory lock namespace (new in PR 8); the store lock below is the one every listing writer shares. */
const REQUEST_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_settings_request'), hashtext($1))";
const STORE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)";
const VENDOR_OWNER_SQL = `SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
       JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
       WHERE v.member_id::text = $1 AND sc.id = $2 FOR SHARE OF v, sc`;
/** The preflight's owner read: PostgreSQL refuses a row lock in a read-only transaction, and the preflight holds none. */
const PREFLIGHT_OWNER_SQL = `SELECT v.id AS vendor_id FROM dropship.dropship_vendors v
       JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id
       WHERE v.member_id::text = $1 AND sc.id = $2`;
/** A snapshot with no lock, as the listing-settings read load opens (dropship-listing-settings.repository.ts). */
const PREFLIGHT_BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const SYSTEM_OWNER_SQL = `SELECT sc.vendor_id FROM dropship.dropship_store_connections sc
       JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
       WHERE sc.id = $1 FOR SHARE OF v, sc`;
/**
 * The same SHARE locks W9 and the content writer take: admin rule replacement
 * and selection phantoms wait, catalog reads do not. Exported for W1's apply
 * (plan PR 9, P37), which takes them after the store lock and the owner rows.
 */
export const LISTING_SELECTION_LOCK_SQL = `LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules,
       dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE`;
const CATEGORY_LOCK_SQL = "SELECT id FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";
const PRODUCT_LOCK_SQL = "SELECT id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";
const VARIANT_LOCK_SQL = "SELECT id FROM catalog.product_variants WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";
/**
 * The sizes of the products a vendor could choose: the selected-catalog
 * scan's sellable filter (dropship-selected-catalog.reader.ts), as the read
 * side counts a product's sizes (countOfferedSizes).
 */
const PRODUCT_SIZES_SQL = `SELECT id FROM catalog.product_variants WHERE product_id = ANY($1::int[]) AND requires_shipping = true
       AND COALESCE(track_inventory, true) = true AND sales_eligibility = 'sellable' ORDER BY id`;
/**
 * The store's saved product text in UTF-8 bytes (plan 6.2 #6): every product
 * row, the same without the replaced fields of $3, and $3's own. One
 * statement, no text selected, no lock (every product-text writer holds the
 * store lock). octet_length(text) is the UTF-8 byte count only on a UTF8
 * server, so the statement returns that check with the sums.
 */
const LISTING_TEXT_BYTES_SQL = `SELECT current_setting('server_encoding') = 'UTF8' AS utf8,
       COALESCE(sum(COALESCE(octet_length(r.text_above), 0) + COALESCE(octet_length(r.text_below), 0)
         + COALESCE(octet_length(r.body_text), 0)), 0)::text AS store_bytes,
       COALESCE(sum(CASE WHEN s.product_id = ANY($3::int[]) THEN
           (CASE WHEN $4::boolean THEN 0 ELSE COALESCE(octet_length(r.text_above), 0) END)
         + (CASE WHEN $5::boolean THEN 0 ELSE COALESCE(octet_length(r.text_below), 0) END)
         + (CASE WHEN $6::boolean THEN 0 ELSE COALESCE(octet_length(r.body_text), 0) END)
         ELSE COALESCE(octet_length(r.text_above), 0) + COALESCE(octet_length(r.text_below), 0)
           + COALESCE(octet_length(r.body_text), 0) END), 0)::text AS kept_store_bytes,
       COALESCE(sum(CASE WHEN s.product_id = ANY($3::int[]) THEN COALESCE(octet_length(r.text_above), 0)
         + COALESCE(octet_length(r.text_below), 0) + COALESCE(octet_length(r.body_text), 0) END), 0)::text AS target_bytes
     FROM dropship.dropship_product_listing_settings s
     JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2`;

/** Every Card Shellz product in a category, chosen or not (index 0108 on category_id). */
const CATEGORY_PRODUCTS_SQL = "SELECT id FROM catalog.products WHERE category_id = $1 ORDER BY id";
/**
 * Which per-size leftovers each size holds (plan PR 9, 8.2): the policy ids
 * its override sets, and a shelf row (a row always holds one or two shelves,
 * migration 215's CHECK). Ids and flags only; the vendor's and the store's
 * rows only.
 */
const LEFTOVER_FIELDS_SQL = `SELECT o.product_variant_id, o.fulfillment_policy_id IS NOT NULL AS shipping_policy,
       o.return_policy_id IS NOT NULL AS return_policy, o.payment_policy_id IS NOT NULL AS payment_policy, false AS store_shelf
     FROM dropship.dropship_ebay_listing_policy_overrides o
     WHERE o.vendor_id = $1 AND o.store_connection_id = $2 AND o.product_variant_id = ANY($3::int[])
   UNION ALL SELECT a.product_variant_id, false, false, false, true
     FROM dropship.dropship_ebay_store_category_assignments a
     WHERE a.vendor_id = $1 AND a.store_connection_id = $2 AND a.product_variant_id = ANY($3::int[])`;
/** loadLeftoverFields' flag columns, by leftover field; a size's own main text is not read there (a category has none). */
const LEFTOVER_FLAG_COLUMNS = {
  shippingPolicy: "shipping_policy", returnPolicy: "return_policy", paymentPolicy: "payment_policy", storeShelf: "store_shelf",
} as const satisfies Record<Exclude<ListingSettingLeftoverField, "mainText">, string>;

/**
 * The revision column that decides whether each product setting is set, under
 * 8a's column mapping (dropship-listing-setting-shared.repository.ts): a
 * group's id or mode column, and for the main text its catalog hash. Each
 * group is all or none by a CHECK of migration 0738 (the price's is
 * dropship_product_listing_setting_revision_price_chk), so one column of the
 * group decides it. Exported for the parity test against
 * readProductListingSettings.
 */
export const PRODUCT_SETTING_FLAG_COLUMNS = {
  price: "price_basis",
  ebayCategory: "ebay_category_id",
  storeShelf: "shelf_mode",
  shippingPolicy: "fulfillment_policy_id",
  returnPolicy: "return_policy_id",
  paymentPolicy: "payment_policy_id",
  textAbove: "text_above_mode",
  textBelow: "text_below_mode",
  mainText: "body_catalog_hash",
} as const satisfies Record<ProductListingSettingField, string>;
/** A revision's price group (0738's and 0739's price CHECKs: all four or none). */
const PRICE_COLUMNS = ["price_basis", "price_markup_bps", "price_flat_cents", "price_rounding"] as const;
const PRICE_COLUMN_LIST = PRICE_COLUMNS.map((column) => `r.${column}`).join(", ");
/**
 * Each product's current revision, own price and own-field flags (plan PR 9,
 * 8.2; v3r, C-feas-2): the revision id, the four price columns and one IS
 * NOT NULL flag per setting, never a text, name or path column, so no text
 * enters the heap. The vendor's and the store's rows only; no lock.
 */
const PRODUCT_SETTING_FACTS_SQL = `SELECT s.product_id, s.revision_id, ${PRICE_COLUMN_LIST},
       ${Object.values(PRODUCT_SETTING_FLAG_COLUMNS).map((column) => `r.${column} IS NOT NULL AS set_${column}`).join(", ")}
     FROM dropship.dropship_product_listing_settings s
     JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id AND r.vendor_id = s.vendor_id
       AND r.store_connection_id = s.store_connection_id AND r.product_id = s.product_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_id = ANY($3::int[])
     ORDER BY s.product_id`;
/** Each category's current revision and own price, the same way: no text, no name, no lock. */
const CATEGORY_SETTING_FACTS_SQL = `SELECT s.category_id, s.revision_id, ${PRICE_COLUMN_LIST}
     FROM dropship.dropship_category_listing_settings s
     JOIN dropship.dropship_category_listing_setting_revisions r ON r.id = s.revision_id AND r.vendor_id = s.vendor_id
       AND r.store_connection_id = s.store_connection_id AND r.category_id = s.category_id
     WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.category_id = ANY($3::int[])
     ORDER BY s.category_id`;

/**
 * The request-key unique constraints of 0738 and 0739, the size price child
 * key of 0657, the policy, shelf and content child keys of 217, 215 and
 * 0660 (plan PR 9, P32), and 0750's one-apply-per-review index (plan 9.1).
 * PR 9's routes never reach these: a vendor has one member, and the request
 * lock is member:key, so a second use of a key waits and the replay probe
 * answers it. A second apply of one review under another key is serialized
 * by the store lock, and its by-review read sees the first apply's row, so
 * the review index is a backstop only (plan 3.7). Only the policy and shelf
 * keys can be reached otherwise: an older per-size policy or shelf route given a
 * child-key-shaped key, while a PR 9 write under that key is between its
 * probe and its insert, because those writers take no store lock (plan 3.7).
 * That is a key reuse (409), not a fault. The older price and content routes
 * take the store lock, which a PR 9 write holds from before its probe to its
 * commit, so for the size and content keys the 409 is a backstop only. A
 * 23505 on any other constraint is not a key reuse and is rethrown. The
 * content key is unnamed in 0660; its name is PostgreSQL's (pinned by the
 * PostgreSQL suite).
 */
const REQUEST_KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  "dropship_product_listing_setting_requests_key_idx",
  "dropship_product_listing_setting_revision_key_uk",
  "dropship_category_listing_setting_revision_key_uk",
  "dropship_listing_price_revision_idempotency_uk",
  "dropship_ebay_listing_policy_override_revision_idem_uk",
  "dropship_ebay_store_category_revision_idem_uk",
  "dropship_listing_content_revision_vendor_id_idempotency_key_key",
  "dropship_product_listing_setting_requests_review_idx",
]);
const PRODUCT_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  "dropship_product_listing_setting_revision_product_fk",
  "dropship_product_listing_setting_product_fk",
]);
const CATEGORY_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  "dropship_category_listing_setting_revision_category_fk",
  "dropship_category_listing_setting_category_fk",
]);
/**
 * Every row a request key wrote (plan PR 9, section 4.6), in one statement
 * with no lock: the product and category revision and the ledger row under
 * the key, and every child under its size, policy, shelf and content
 * prefixes ($3-$6). Each branch is the vendor's rows only, on a (vendor_id,
 * idempotency_key) unique index. The prefixes are compared with left(), not
 * LIKE, so no character of a key is a pattern.
 */
const REQUEST_KEY_USE_SQL = `SELECT 'product' AS source, r.id::bigint AS id, r.store_connection_id, r.product_id AS target_id,
       r.request_hash::text AS request_hash, r.request_id, NULL::text AS operation
  FROM dropship.dropship_product_listing_setting_revisions r WHERE r.vendor_id = $1 AND r.idempotency_key = $2
UNION ALL SELECT 'category', r.id, r.store_connection_id, r.category_id, r.request_hash, NULL, NULL
  FROM dropship.dropship_category_listing_setting_revisions r WHERE r.vendor_id = $1 AND r.idempotency_key = $2
UNION ALL SELECT 'ledger', q.id, q.store_connection_id, NULL, q.request_hash, NULL, q.operation
  FROM dropship.dropship_product_listing_setting_requests q WHERE q.vendor_id = $1 AND q.idempotency_key = $2
UNION ALL SELECT 'size', r.id, r.store_connection_id, r.product_variant_id, r.request_hash, NULL, NULL
  FROM dropship.dropship_listing_price_revisions r WHERE r.vendor_id = $1 AND left(r.idempotency_key, length($3::text)) = $3::text
UNION ALL SELECT 'policy', r.id, r.store_connection_id, r.product_variant_id, r.request_hash, NULL, NULL
  FROM dropship.dropship_ebay_listing_policy_override_revisions r WHERE r.vendor_id = $1 AND left(r.idempotency_key, length($4::text)) = $4::text
UNION ALL SELECT 'shelf', r.id, r.store_connection_id, r.product_variant_id, r.request_hash, NULL, NULL
  FROM dropship.dropship_ebay_store_category_assignment_revisions r WHERE r.vendor_id = $1 AND left(r.idempotency_key, length($5::text)) = $5::text
UNION ALL SELECT 'content', r.id, r.store_connection_id, r.product_variant_id, r.request_hash, NULL, NULL
  FROM dropship.dropship_listing_content_revisions r WHERE r.vendor_id = $1 AND left(r.idempotency_key, length($6::text)) = $6::text`;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const DEADLOCK_DETECTED = "40P01";
/**
 * Not raised under READ COMMITTED, which every listing-settings writer runs
 * (plan PR 9, P3: no isolation option is added). Mapped anyway, so one could
 * only ever surface as a retryable BUSY, never as a 500.
 */
const SERIALIZATION_FAILURE = "40001";
/**
 * The database dropped or refused the connection: SQLSTATE class 08, too many
 * connections, an administrator or crash shutdown, or a server still starting
 * (the list of shipstation.service.ts and the inventory replenishment
 * classifier). Retryable: a failure before COMMIT wrote nothing, and if COMMIT
 * itself was cut off a retry with the same key is answered by the replay probe
 * (plan P16), so it can never write twice.
 */
const CONNECTION_FAILURE_PREFIX = "08";
const CONNECTION_FAILURE_STATES: ReadonlySet<string> = new Set(["53300", "57P01", "57P02", "57P03"]);
/** Node's socket errors on the database connection, retryable for the same reason. */
const CONNECTION_FAILURE_ERRNOS: ReadonlySet<string> = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
/**
 * pg-pool's own words when no connection is free within `connectionTimeoutMillis`
 * (node_modules/pg-pool/index.js); the error has no code. server/db.ts records
 * the pool saturating with exactly this error.
 */
const POOL_ACQUIRE_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

/** The four writers that use the transaction's own key: each at most once per transaction (plan D30). */
type ParentKeyWriter = "saveProduct" | "saveProductsBulk" | "saveCategory" | "acknowledgeCategoryMoves";
/**
 * The two that write the request's ledger row, unique on (vendor, key). A
 * second one would find the first's row as a replay of another operation and
 * answer DROPSHIP_IDEMPOTENCY_CONFLICT, so at most one of them runs (D30).
 */
const LEDGER_WRITERS: ReadonlySet<ParentKeyWriter> = new Set<ParentKeyWriter>(["saveProductsBulk", "acknowledgeCategoryMoves"]);

/**
 * A size that lockCatalog was given but did not find (deleted from the
 * catalog, or a bad id in a request) is the vendor's data, not a fault: it is
 * answered with the delegate's own permanent code, as W9's
 * authorizeListingPrice and the content service's authorizeListing do.
 */
const PRICE_NOT_AVAILABLE = { code: "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", message: "Listing price is not available for this item." };
const CONTENT_NOT_AVAILABLE = {
  code: "DROPSHIP_CONTENT_NOT_AVAILABLE", message: "Select an available catalog item before editing its description.",
};

/** W9's flow per size: its replay read, then its save (saveListingPriceInTransaction). */
type PriceStep = "replay_checked" | "saved";

export class PgDropshipListingSettingWritesRepository implements ListingSettingWriteRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  /** A vendor's request: request lock, store lock, owner rows, then the operation. The actor is the member. */
  async execute<T>(
    input: { memberId: string; storeConnectionId: number; idempotencyKey: string },
    operation: (tx: ListingSettingWriteTransaction) => Promise<T>,
  ): Promise<T> {
    assertVendorInput(input);
    return this.inTransaction(async (client, guarded, isOpen) => {
      await client.query(REQUEST_LOCK_SQL, [`${input.memberId}:${input.idempotencyKey}`]);
      await client.query(STORE_LOCK_SQL, [input.storeConnectionId]);
      const owner = await client.query<{ vendor_id: unknown }>(VENDOR_OWNER_SQL, [input.memberId, input.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], input.storeConnectionId);
      const state = new WriteTransactionState(guarded, isOpen, {
        vendorId,
        storeConnectionId: input.storeConnectionId,
        actor: { actorType: "vendor", actorId: input.memberId },
        requestKey: input.idempotencyKey,
      }, input.memberId);
      return operation(state.transaction());
    });
  }

  /**
   * W7's price check (plan PR 9, P22, 3.9): the store lock and the owner rows
   * FOR SHARE, READ COMMITTED, with no request lock (a review is unkeyed) and
   * no lockCatalog (a review takes no selection lock, P37). The actor is the
   * member; the one write is the review row.
   */
  async executeReview<T>(
    input: { memberId: string; storeConnectionId: number },
    operation: (tx: ListingSettingReviewTransaction) => Promise<T>,
  ): Promise<T> {
    assertReviewInput(input);
    return this.inTransaction(async (client, guarded, isOpen) => {
      await client.query(STORE_LOCK_SQL, [input.storeConnectionId]);
      const owner = await client.query<{ vendor_id: unknown }>(VENDOR_OWNER_SQL, [input.memberId, input.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], input.storeConnectionId);
      return operation(reviewTransaction(guarded, isOpen, {
        vendorId, storeConnectionId: input.storeConnectionId, memberId: input.memberId,
      }));
    });
  }

  /**
   * The member's stored W7 review, for its pages (plan 9.6): one statement
   * on the pool, no transaction, no lock, ownership by the member. A failure
   * is mapped as a write's would be (a lost connection is the retryable BUSY).
   */
  async readPriceChangeReviewForMember(
    input: { memberId: string; storeConnectionId: number; reviewId: string },
  ): Promise<StoredPriceChangeReview | null> {
    try {
      return await readMemberPriceChangeReview(this.dbPool, input);
    } catch (error) {
      throw mapListingSettingDatabaseError(error);
    }
  }

  /**
   * A system job (the first-mark job, PR 9): store lock and owner rows, no
   * request lock, because first marks are idempotent by ON CONFLICT DO
   * NOTHING. The actor is the job key. It has no price, rules or content
   * delegates: those audit as `vendor`.
   */
  async executeForSystem<T>(
    input: { storeConnectionId: number; jobKey: string },
    operation: (tx: ListingSettingSystemTransaction) => Promise<T>,
  ): Promise<T> {
    assertSystemInput(input);
    return this.inTransaction(async (client, guarded, isOpen) => {
      await client.query(STORE_LOCK_SQL, [input.storeConnectionId]);
      const owner = await client.query<{ vendor_id: unknown }>(SYSTEM_OWNER_SQL, [input.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], input.storeConnectionId);
      const state = new SystemTransactionState(guarded, isOpen, {
        vendorId,
        storeConnectionId: input.storeConnectionId,
        actor: { actorType: "system", actorId: input.jobKey },
      });
      return operation(state.transaction());
    });
  }

  /**
   * The read-only preflight (plan PR 9, 6.2 #4): one REPEATABLE READ READ
   * ONLY snapshot, the owner rows without a row lock, no advisory lock and no
   * writer. A write reads here, before any eBay call, which eBay ids are new
   * and whether its key was used, and asks eBay nothing inside a write
   * transaction. Nothing read here is trusted by the write: its transaction
   * reads again under the locks.
   */
  async preflight<T>(
    input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null },
    operation: (tx: ListingSettingPreflightTransaction) => Promise<T>,
  ): Promise<T> {
    assertPreflightInput(input);
    return this.inTransaction(async (client, guarded, isOpen) => {
      const owner = await client.query<{ vendor_id: unknown }>(PREFLIGHT_OWNER_SQL, [input.memberId, input.storeConnectionId]);
      const vendorId = ownerVendorId(owner.rows[0], input.storeConnectionId);
      return operation(preflightTransaction(guarded, isOpen, { vendorId, storeConnectionId: input.storeConnectionId,
        requestKey: input.idempotencyKey }));
    }, PREFLIGHT_BEGIN_SQL);
  }

  /**
   * BEGIN (READ COMMITTED unless `begin` says otherwise), the body, COMMIT;
   * on any failure ROLLBACK, then the mapped error. The body gets the raw
   * client for the wrapper's own locks and a guarded client for the
   * transaction object. The transaction is open only while the body runs:
   * once it returns or throws, the transaction object refuses every call, so
   * one kept past `execute` can never write on a connection the pool has
   * handed on.
   */
  private async inTransaction<T>(
    body: (client: QueryClient, guarded: QueryClient, isOpen: () => boolean) => Promise<T>,
    begin = "BEGIN",
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.dbPool.connect();
    } catch (error) {
      // No transaction was opened, so nothing to roll back; a pool timeout or a refused connection is retryable.
      throw mapListingSettingDatabaseError(error);
    }
    let open = true;
    const isOpen = () => open;
    try {
      await client.query(begin);
      const result = await body(client, guardedClient(client, isOpen), isOpen).finally(() => { open = false; });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw mapListingSettingWriteError(error);
    } finally {
      client.release();
    }
  }
}

/**
 * The vendor transaction's state: which writers and child targets ran,
 * whether the catalog was locked, which sizes it locked or did not find, and
 * whether a target row was locked or written (after which lockCatalog would
 * break the lock order).
 */
class WriteTransactionState {
  private catalogLocked = false;
  private targetsTouched = false;
  private readonly writersUsed = new Set<ParentKeyWriter>();
  private ledgerWriter: ParentKeyWriter | null = null;
  private readonly lockedVariantIds = new Set<number>();
  private readonly missingVariantIds = new Set<number>();
  /** The products lockCatalog found and locked: the only ones clearSizeLeftovers may clean (plan PR 9, 6.2 #3). */
  private readonly lockedProductIds = new Set<number>();
  private leftoversCleared = false;
  /** loadLeftoverFields ran (plan 8.2): at most once, and only after lockCatalog. */
  private leftoverFieldsLoaded = false;
  /**
   * A child key names one revision, so each child target is written at most once (the D30 rule for children).
   * The mainText clean-up writes the same `content` child keys saveListingContent takes, so a transaction
   * does one or the other, never both (review round, I1).
   */
  private ebayRulesSaved = false;
  private readonly contentSavedVariantIds = new Set<number>();
  private contentLeftoversCleared = false;
  private readonly priceSteps = new Map<number, PriceStep>();

  constructor(
    private readonly client: QueryClient,
    private readonly isOpen: () => boolean,
    private readonly scope: ListingSettingWriteScope,
    private readonly memberId: string,
  ) {}

  transaction(): ListingSettingWriteTransaction {
    const { client, scope } = this;
    const target = { vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId };
    const contentTarget = { ...target, actorId: this.memberId };
    return {
      vendorId: scope.vendorId,
      storeConnectionId: scope.storeConnectionId,
      actor: scope.actor,
      requestKey: scope.requestKey,
      ...selectedCatalogReaderForTransaction(client),
      loadProducts: async (productIds, options) => {
        this.assertOpen();
        if (options?.forUpdate === true) this.targetsTouched = true;
        return readProductListingSettings(client, { ...target, productIds, forUpdate: options?.forUpdate });
      },
      loadCategories: async (categoryIds, options) => {
        this.assertOpen();
        if (options?.forUpdate === true) this.targetsTouched = true;
        return readCategoryListingSettings(client, { ...target, categoryIds, forUpdate: options?.forUpdate });
      },
      loadCategoryMarks: async (productIds) => {
        this.assertOpen();
        return readProductCategoryMarks(client, { ...target, productIds });
      },
      findRequestKeyUse: async () => {
        this.assertOpen();
        return readRequestKeyUse(client, { vendorId: scope.vendorId, requestKey: scope.requestKey });
      },
      lockCatalog: (input) => this.lockCatalog(input),
      listProductSizes: async (productIds) => {
        this.assertOpen();
        return readProductSizes(client, productIds);
      },
      loadPricingProfile: async () => {
        this.assertOpen();
        return readPricingProfile(client, scope.storeConnectionId, scope.vendorId);
      },
      loadProductCosts: async (productVariantIds) => {
        this.assertOpen();
        // A SAVEPOINT on this client, never a BEGIN (forTransaction); a failed read gives "unavailable" costs, as W9's does.
        return PgShellzClubProductCostAdapter.forTransaction(client).loadProductCosts({ vendorId: scope.vendorId, productVariantIds });
      },
      readListingTextBytes: async (input) => {
        this.assertOpen();
        return readListingTextBytes(client, target, input);
      },
      loadOlderGroupRuleCounts: async () => {
        this.assertOpen();
        return readOlderGroupRuleCounts(client, target);
      },
      listCategoryProductIds: async (categoryId) => {
        this.assertOpen();
        return readCategoryProductIds(client, categoryId);
      },
      loadLeftoverFields: (productVariantIds) => this.loadLeftoverFields(productVariantIds),
      loadSettingFacts: async (input) => {
        this.assertOpen();
        return readSettingFacts(client, target, input);
      },
      // Lock-free reads (plan 9.7 steps 2-4): reviews never change, and under the store lock a second apply sees the first.
      loadPriceChangeReview: async (reviewId) => {
        this.assertOpen();
        return loadPriceChangeReviewWithClient(client, target, reviewId);
      },
      findPriceChangeApplyByReview: async (reviewId) => {
        this.assertOpen();
        return findPriceChangeApplyByReviewWithClient(client, target, reviewId);
      },
      clearSizeLeftovers: async (input) => {
        this.assertOpen();
        if (this.leftoversCleared) {
          throw listingSettingsInvariantFailed("Per-size leftovers are cleared at most once per listing settings transaction.");
        }
        if (input.fields.length === 0) throw listingSettingsInvariantFailed("A per-size leftover clean-up needs at least one field.");
        if (input.productIds.length === 0 || !input.productIds.every((productId) => this.lockedProductIds.has(productId))) {
          throw listingSettingsInvariantFailed("Per-size leftovers are cleared only for products lockCatalog locked.");
        }
        const clearsContent = input.fields.includes("mainText");
        if (clearsContent && this.contentSavedVariantIds.size > 0) {
          throw listingSettingsInvariantFailed("A main-text clean-up and a size's description save share content child keys: one per transaction.");
        }
        this.leftoversCleared = true;
        this.contentLeftoversCleared = clearsContent;
        this.targetsTouched = true;
        return clearSizeLeftoversWithClient(client, scope, input);
      },
      saveProduct: async (input) => {
        this.beginParentKeyWrite("saveProduct");
        return saveProductListingSettingWithClient(client, scope, input);
      },
      saveProductsBulk: async (input) => {
        this.beginParentKeyWrite("saveProductsBulk");
        return saveProductListingSettingsBulkWithClient(client, scope, input);
      },
      saveCategory: async (input) => {
        this.beginParentKeyWrite("saveCategory");
        return saveCategoryListingSettingWithClient(client, scope, input);
      },
      acknowledgeCategoryMoves: async (input) => {
        this.beginParentKeyWrite("acknowledgeCategoryMoves");
        return acknowledgeCategoryMovesWithClient(client, scope, input);
      },
      sizePrice: (productVariantId) => this.sizePrice(productVariantId),
      saveEbayCategoryRulesProfile: async (save) => {
        this.assertOpen();
        if (!isListingSettingChildKey(scope.requestKey, save.idempotencyKey, "ebay_rules", scope.storeConnectionId)) {
          throw listingSettingsInvariantFailed("eBay category rules in a listing settings request need the request's ebay_rules child key.");
        }
        if (this.ebayRulesSaved) {
          throw listingSettingsInvariantFailed("The store's eBay category rules are saved at most once per listing settings transaction.");
        }
        this.ebayRulesSaved = true;
        this.targetsTouched = true;
        return saveEbayCategoryRulesProfileWithClient(client, contentTarget, save);
      },
      saveListingContent: async (productVariantId, save, hash, now) => {
        this.assertOpen();
        this.assertVariantLocked(productVariantId, CONTENT_NOT_AVAILABLE);
        if (!isListingSettingChildKey(scope.requestKey, save.idempotencyKey, "content", productVariantId)) {
          throw listingSettingsInvariantFailed("A size's description in a listing settings request needs the request's content child key.", {
            productVariantId: String(productVariantId),
          });
        }
        if (this.contentSavedVariantIds.has(productVariantId)) {
          throw listingSettingsInvariantFailed("A size's description is saved at most once per listing settings transaction.", {
            productVariantId: String(productVariantId),
          });
        }
        if (this.contentLeftoversCleared) {
          throw listingSettingsInvariantFailed("A main-text clean-up and a size's description save share content child keys: one per transaction.", {
            productVariantId: String(productVariantId),
          });
        }
        this.contentSavedVariantIds.add(productVariantId);
        this.targetsTouched = true;
        return saveListingContentWithClient(client, contentTarget, productVariantId, save, hash, now);
      },
    };
  }

  /**
   * One call per transaction, with every id, so the order holds across kinds;
   * only before any target lock or write. Returns the products it found and
   * locked, ascending: a product Card Shellz deleted is not among them.
   */
  private async lockCatalog(input: {
    categoryIds?: readonly number[]; productIds?: readonly number[]; productVariantIds?: readonly number[];
  }): Promise<{ lockedProductIds: number[] }> {
    this.assertOpen();
    if (this.catalogLocked) {
      throw listingSettingsInvariantFailed("lockCatalog runs once per listing settings transaction, with every id it needs.");
    }
    if (this.targetsTouched) {
      throw listingSettingsInvariantFailed("lockCatalog must run before any listing setting is locked or written.");
    }
    const categoryIds = lockIds(input.categoryIds, "categoryIds");
    const productIds = lockIds(input.productIds, "productIds");
    const productVariantIds = lockIds(input.productVariantIds, "productVariantIds");
    this.catalogLocked = true;
    await this.client.query(LISTING_SELECTION_LOCK_SQL);
    if (categoryIds.length > 0) await this.client.query(CATEGORY_LOCK_SQL, [categoryIds]);
    if (productIds.length > 0) {
      const locked = await this.client.query<{ id: unknown }>(PRODUCT_LOCK_SQL, [productIds]);
      for (const row of locked.rows) {
        if (typeof row.id === "number") this.lockedProductIds.add(row.id);
      }
    }
    if (productVariantIds.length > 0) {
      // Only sizes that exist are locked, so only they are write targets; a size
      // missing from the catalog is remembered and answered as not available.
      const locked = await this.client.query<{ id: unknown }>(VARIANT_LOCK_SQL, [productVariantIds]);
      for (const row of locked.rows) {
        if (typeof row.id === "number") this.lockedVariantIds.add(row.id);
      }
      for (const productVariantId of productVariantIds) {
        if (!this.lockedVariantIds.has(productVariantId)) this.missingVariantIds.add(productVariantId);
      }
    }
    return { lockedProductIds: [...this.lockedProductIds].sort((left, right) => left - right) };
  }

  /**
   * The per-size leftovers of these sizes (plan 8.2), under the old per-size
   * writers' feature locks, policy then shelf, taken first (v3r, C-money-6):
   * a clear set derived from this read holds until commit. Only after
   * lockCatalog (the locks follow it in the lock order) and once.
   */
  private async loadLeftoverFields(productVariantIds: readonly number[]): Promise<Map<number, ListingSettingLeftoverField[]>> {
    this.assertOpen();
    if (!this.catalogLocked) throw listingSettingsInvariantFailed("Per-size leftovers are read only after lockCatalog.");
    if (this.leftoverFieldsLoaded) {
      throw listingSettingsInvariantFailed("Per-size leftovers are read at most once per listing settings transaction.");
    }
    const ids = readIds(productVariantIds, "productVariantIds");
    this.leftoverFieldsLoaded = true;
    await this.client.query(POLICY_FEATURE_LOCK_SQL, [this.scope.storeConnectionId]);
    await this.client.query(SHELF_FEATURE_LOCK_SQL, [this.scope.storeConnectionId]);
    return readLeftoverFields(this.client, this.scope, ids);
  }

  /**
   * W9's own transaction object for one size (plan D29), on this client,
   * under this transaction's locks. Its key guards accept only the size's
   * child key, so W9's replay and save checks run unchanged; writing through
   * it ends lockCatalog's window like any other write.
   */
  private sizePrice(productVariantId: number): ListingPriceTransaction {
    this.assertOpen();
    this.assertVariantLocked(productVariantId, PRICE_NOT_AVAILABLE);
    const price = listingPriceTransactionForClient(this.client, {
      vendorId: this.scope.vendorId,
      storeConnectionId: this.scope.storeConnectionId,
      productVariantId,
      memberId: this.memberId,
      idempotencyKey: listingSettingChildKey(this.scope.requestKey, "size", productVariantId),
    });
    return {
      ...price,
      loadSaved: () => {
        this.assertOpen();
        // W9's loadSaved locks the size's price row FOR UPDATE: a target lock.
        this.targetsTouched = true;
        return price.loadSaved();
      },
      loadReplay: (input) => {
        this.assertOpen();
        this.beginPriceStep(productVariantId, "replay_checked");
        return price.loadReplay(input);
      },
      save: (input) => {
        this.assertOpen();
        this.beginPriceStep(productVariantId, "saved");
        this.targetsTouched = true;
        return price.save(input);
      },
    };
  }

  /**
   * The size's child key names one price revision, so W9's flow runs at most
   * once per size. Its replay read comes before its save, and a second flow
   * would find the first one's revision under the same key: answered as a
   * replay (the second price never written) or as a key conflict. So each step
   * runs once per size, and nothing follows a save.
   */
  private beginPriceStep(productVariantId: number, step: PriceStep): void {
    const done = this.priceSteps.get(productVariantId);
    if (done === "saved" || (done === "replay_checked" && step === "replay_checked")) {
      throw listingSettingsInvariantFailed("A size's price is saved at most once per listing settings transaction.", {
        productVariantId: String(productVariantId),
      });
    }
    this.priceSteps.set(productVariantId, step);
  }

  private beginParentKeyWrite(writer: ParentKeyWriter): void {
    this.assertOpen();
    if (this.writersUsed.has(writer)) {
      throw listingSettingsInvariantFailed("Each listing settings writer runs at most once per transaction.", { writer });
    }
    if (LEDGER_WRITERS.has(writer)) {
      if (this.ledgerWriter !== null) {
        throw listingSettingsInvariantFailed("One listing settings request writes one ledger row.", {
          writer, ledgerWriter: this.ledgerWriter,
        });
      }
      this.ledgerWriter = writer;
    }
    this.writersUsed.add(writer);
    this.targetsTouched = true;
  }

  /**
   * A size is written only when lockCatalog locked it (plan F4), so every size
   * written was held FOR SHARE before any target lock. One lockCatalog was
   * given but did not find gets the delegate's permanent not-available code;
   * one it was never given is a programming fault.
   */
  private assertVariantLocked(productVariantId: number, notAvailable: { code: string; message: string }): void {
    if (this.lockedVariantIds.has(productVariantId)) return;
    if (this.missingVariantIds.has(productVariantId)) {
      throw new DropshipError(notAvailable.code, notAvailable.message, {
        productVariantId, retryable: false, classification: "permanent",
      });
    }
    throw listingSettingsInvariantFailed("A size is written in a listing settings request only after lockCatalog locked it.", {
      productVariantId: String(productVariantId),
    });
  }

  private assertOpen(): void {
    if (!this.isOpen()) throw transactionEnded();
  }
}

/**
 * The preflight's transaction object: the gate's and the eBay values' reads
 * on the snapshot's client, no lock (no `forUpdate`), no writer, and a
 * replay probe only when the request has a key.
 */
function preflightTransaction(client: QueryClient, isOpen: () => boolean,
  scope: { vendorId: number; storeConnectionId: number; requestKey: string | null }): ListingSettingPreflightTransaction {
  const target = { vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId };
  const assertOpen = () => {
    if (!isOpen()) throw transactionEnded();
  };
  return {
    vendorId: scope.vendorId,
    storeConnectionId: scope.storeConnectionId,
    catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
    findRequestKeyUse: async () => {
      assertOpen();
      if (scope.requestKey === null) throw listingSettingsInvariantFailed("A preflight without a request key has no replay probe.");
      return readRequestKeyUse(client, { vendorId: scope.vendorId, requestKey: scope.requestKey });
    },
    loadProducts: async (productIds) => {
      assertOpen();
      return readProductListingSettings(client, { ...target, productIds });
    },
    loadCategories: async (categoryIds) => {
      assertOpen();
      return readCategoryListingSettings(client, { ...target, categoryIds });
    },
  };
}

/**
 * W7's price check transaction (plan 9.1): the reads its rows are built from
 * on this client, and one review insert. Nothing else writes, and nothing
 * here takes a lock: loadLeftoverFields reads without the feature locks the
 * write transaction takes (plan 8.2), because the apply derives its clear
 * set again under them.
 */
function reviewTransaction(client: QueryClient, isOpen: () => boolean,
  scope: { vendorId: number; storeConnectionId: number; memberId: string }): ListingSettingReviewTransaction {
  const target = { vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId };
  let reviewStored = false;
  const assertOpen = () => {
    if (!isOpen()) throw transactionEnded();
  };
  return {
    vendorId: scope.vendorId,
    storeConnectionId: scope.storeConnectionId,
    catalog: PgDropshipListingPreviewRepository.readerForTransaction(client),
    loadOlderGroupRuleCounts: async () => {
      assertOpen();
      return readOlderGroupRuleCounts(client, target);
    },
    loadCategories: async (categoryIds) => {
      assertOpen();
      return readCategoryListingSettings(client, { ...target, categoryIds });
    },
    loadCatalogCategoryNames: async (categoryIds) => {
      assertOpen();
      return readCatalogCategoryNames(client, categoryIds);
    },
    listCategoryProductIds: async (categoryId) => {
      assertOpen();
      return readCategoryProductIds(client, categoryId);
    },
    listProductSizes: async (productIds) => {
      assertOpen();
      return readProductSizes(client, productIds);
    },
    loadSettingFacts: async (input) => {
      assertOpen();
      return readSettingFacts(client, target, input);
    },
    loadLeftoverFields: async (productVariantIds) => {
      assertOpen();
      return readLeftoverFields(client, target, readIds(productVariantIds, "productVariantIds"));
    },
    readListingTextBytes: async (input) => {
      assertOpen();
      return readListingTextBytes(client, target, input);
    },
    loadPricingProfile: async () => {
      assertOpen();
      return readPricingProfile(client, scope.storeConnectionId, scope.vendorId);
    },
    loadProductCosts: async (productVariantIds) => {
      assertOpen();
      // A SAVEPOINT on this client, never a BEGIN (forTransaction), as in the write transaction.
      return PgShellzClubProductCostAdapter.forTransaction(client).loadProductCosts({ vendorId: scope.vendorId, productVariantIds });
    },
    storePriceChangeReview: async (review) => {
      assertOpen();
      if (reviewStored) throw listingSettingsInvariantFailed("A price check stores one review per transaction.");
      reviewStored = true;
      return insertPriceChangeReviewWithClient(client, { ...target, actorId: scope.memberId }, review);
    },
  };
}

/** The products' sellable sizes, ascending (PRODUCT_SIZES_SQL); no ids, no query. */
async function readProductSizes(client: QueryClient, productIds: readonly number[]): Promise<number[]> {
  const ids = lockIds(productIds, "productIds");
  if (ids.length === 0) return [];
  const result = await client.query<{ id: unknown }>(PRODUCT_SIZES_SQL, [ids]);
  return result.rows.map((row) => storedInt4Id(row.id, "product_variants.id"));
}

/** D16's counts (plan P21) over the store's three profiles, each read in its own argument order. */
async function readOlderGroupRuleCounts(client: QueryClient,
  target: { vendorId: number; storeConnectionId: number }): Promise<OlderGroupRuleCounts> {
  // The three readers' own argument orders differ (store, vendor for pricing).
  const pricing = await readPricingProfile(client, target.storeConnectionId, target.vendorId);
  const content = await readContentProfile(client, target.vendorId, target.storeConnectionId);
  const ebayCategoryRules = await readEbayCategoryRules(client, target.vendorId, target.storeConnectionId);
  return olderGroupRuleCounts({ pricing, content, ebayCategoryRules });
}

/** Every Card Shellz product in the category, ascending (CATEGORY_PRODUCTS_SQL). */
async function readCategoryProductIds(client: QueryClient, categoryId: number): Promise<number[]> {
  if (!isInt4Id(categoryId)) throw listingSettingsInvariantFailed("A category's products are read for a whole-number category id only.");
  const result = await client.query<{ id: unknown }>(CATEGORY_PRODUCTS_SQL, [categoryId]);
  return result.rows.map((row) => storedInt4Id(row.id, "products.id"));
}

/**
 * Which per-size leftovers each size holds (LEFTOVER_FIELDS_SQL), ids and
 * flags only, in LISTING_SETTING_LEFTOVER_FIELDS order; a size with none is
 * absent. `ids` are already checked, distinct and ascending. The caller takes
 * whatever lock it needs first.
 */
async function readLeftoverFields(client: QueryClient, target: { vendorId: number; storeConnectionId: number },
  ids: readonly number[]): Promise<Map<number, ListingSettingLeftoverField[]>> {
  const leftovers = new Map<number, ListingSettingLeftoverField[]>();
  if (ids.length === 0) return leftovers;
  const asked = new Set(ids);
  const result = await client.query<Record<string, unknown>>(LEFTOVER_FIELDS_SQL, [target.vendorId, target.storeConnectionId, ids]);
  const found = new Map<number, Set<ListingSettingLeftoverField>>();
  for (const row of result.rows) {
    const productVariantId = storedInt4Id(row.product_variant_id, "product_variant_id");
    if (!asked.has(productVariantId)) {
      throw listingSettingsInvariantFailed("A per-size leftover was read for a size that was not asked for.", { productVariantId });
    }
    const fields = found.get(productVariantId) ?? new Set<ListingSettingLeftoverField>();
    for (const [field, column] of Object.entries(LEFTOVER_FLAG_COLUMNS) as Array<[keyof typeof LEFTOVER_FLAG_COLUMNS, string]>) {
      if (storedFlag(row[column], column)) fields.add(field);
    }
    found.set(productVariantId, fields);
  }
  for (const [productVariantId, fields] of [...found].sort(([left], [right]) => left - right)) {
    const ordered = LISTING_SETTING_LEFTOVER_FIELDS.filter((field) => fields.has(field));
    if (ordered.length > 0) leftovers.set(productVariantId, ordered);
  }
  return leftovers;
}

/**
 * The store's saved product text in UTF-8 bytes (LISTING_TEXT_BYTES_SQL). A
 * server that is not UTF8 would miscount, and a sum that is not a safe
 * whole number is a broken row: both are fatal, never a guess.
 */
async function readListingTextBytes(client: QueryClient, target: { vendorId: number; storeConnectionId: number },
  input: ListingTextBytesInput): Promise<ListingTextBytes> {
  const productIds = lockIds(input.productIds, "productIds");
  const flags = input.replacedFields;
  const result = await client.query<{ utf8: unknown; store_bytes: unknown; kept_store_bytes: unknown; target_bytes: unknown }>(
    LISTING_TEXT_BYTES_SQL, [target.vendorId, target.storeConnectionId, productIds,
      flags.textAbove === true, flags.textBelow === true, flags.mainText === true]);
  const row = result.rows[0];
  if (row?.utf8 !== true) {
    throw listingSettingsInvariantFailed("Listing text bytes are counted only on a UTF8 database.", { utf8: row?.utf8 === false ? false : null });
  }
  return {
    storeBytes: textByteSum(row.store_bytes, "store_bytes"),
    keptStoreBytes: textByteSum(row.kept_store_bytes, "kept_store_bytes"),
    targetBytes: textByteSum(row.target_bytes, "target_bytes"),
  };
}

/** A numeric sum sent as text; anything but a safe non-negative whole number is refused, never coerced. */
function textByteSum(value: unknown, column: string): number {
  const bytes = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw listingSettingsInvariantFailed("A listing text byte count failed its contract.", { column });
  }
  return bytes;
}

/**
 * Products' and categories' settings facts (plan 8.2), one statement per
 * list, each skipped when its list is empty. A row that breaks its contract
 * (a flag that is not a boolean, a duplicate or unasked id, a partial price
 * group, a recipe out of its contract, a price flag that disagrees with the
 * price) is fatal, never a guess.
 */
async function readSettingFacts(client: QueryClient, target: { vendorId: number; storeConnectionId: number },
  input: ListingSettingFactsInput): Promise<ListingSettingFacts> {
  const productIds = readIds(input.productIds, "productIds");
  const categoryIds = readIds(input.categoryIds ?? [], "categoryIds");
  const products = new Map<number, ProductSettingFacts>();
  const categories = new Map<number, CategorySettingFacts>();
  if (productIds.length > 0) {
    const asked = new Set(productIds);
    const result = await client.query<Record<string, unknown>>(PRODUCT_SETTING_FACTS_SQL, [target.vendorId, target.storeConnectionId, productIds]);
    for (const row of result.rows) {
      const productId = storedInt4Id(row.product_id, "product_id");
      if (!asked.has(productId) || products.has(productId)) {
        throw listingSettingsInvariantFailed("A product's settings facts were read twice or unasked.", { productId });
      }
      const ownFields = new Set<ProductListingSettingField>();
      for (const [field, column] of Object.entries(PRODUCT_SETTING_FLAG_COLUMNS) as Array<[ProductListingSettingField, string]>) {
        if (storedFlag(row[`set_${column}`], `set_${column}`)) ownFields.add(field);
      }
      const price = storedFactPrice(row, { productId });
      if ((price !== null) !== ownFields.has("price")) {
        throw listingSettingsInvariantFailed("A product's price flag disagrees with its price.", { productId });
      }
      products.set(productId, { revisionId: storedInt4Id(row.revision_id, "revision_id"), price, ownFields });
    }
  }
  if (categoryIds.length > 0) {
    const asked = new Set(categoryIds);
    const result = await client.query<Record<string, unknown>>(CATEGORY_SETTING_FACTS_SQL,
      [target.vendorId, target.storeConnectionId, categoryIds]);
    for (const row of result.rows) {
      const categoryId = storedInt4Id(row.category_id, "category_id");
      if (!asked.has(categoryId) || categories.has(categoryId)) {
        throw listingSettingsInvariantFailed("A category's settings facts were read twice or unasked.", { categoryId });
      }
      categories.set(categoryId, { revisionId: storedInt4Id(row.revision_id, "revision_id"), price: storedFactPrice(row, { categoryId }) });
    }
  }
  return { products, categories };
}

/** A facts row's price group, read as the full row read reads it; a fault names the row's id, never a value. */
function storedFactPrice(row: Record<string, unknown>, ids: Record<string, number>): ProductSettingFacts["price"] {
  try {
    return listingSettingPriceFromColumns(row as Record<(typeof PRICE_COLUMNS)[number], unknown>);
  } catch (error) {
    if (error instanceof DropshipError) throw new DropshipError(error.code, error.message, { ...error.context, ...ids });
    throw error;
  }
}

/** A flag PostgreSQL computed (IS NOT NULL); anything but a boolean is a broken row. */
function storedFlag(value: unknown, column: string): boolean {
  if (typeof value !== "boolean") throw listingSettingsInvariantFailed("A listing settings flag read in a write failed its contract.", { column });
  return value;
}

/** Positive int4 ids for a read, distinct and ascending; anything else is a programming fault. */
function readIds(ids: readonly number[], field: string): number[] {
  if (!ids.every(isInt4Id)) throw listingSettingsInvariantFailed("Listing settings reads take positive whole-number ids.", { field });
  return [...new Set(ids)].sort((left, right) => left - right);
}

/** An int4 id PostgreSQL returned; anything else is a broken row. */
function storedInt4Id(value: unknown, column: string): number {
  if (!isInt4Id(value)) throw listingSettingsInvariantFailed("A catalog id read in a listing settings write failed its contract.", { column });
  return value;
}

/** The system job's transaction: reads and first marks, nothing a vendor writes. */
class SystemTransactionState {
  constructor(
    private readonly client: QueryClient,
    private readonly isOpen: () => boolean,
    private readonly scope: Pick<ListingSettingWriteScope, "vendorId" | "storeConnectionId"> & { actor: ListingSettingActor },
  ) {}

  transaction(): ListingSettingSystemTransaction {
    const { client, scope } = this;
    const target = { vendorId: scope.vendorId, storeConnectionId: scope.storeConnectionId };
    return {
      vendorId: scope.vendorId,
      storeConnectionId: scope.storeConnectionId,
      loadProducts: async (productIds, options) => {
        this.assertOpen();
        return readProductListingSettings(client, { ...target, productIds, forUpdate: options?.forUpdate });
      },
      loadCategories: async (categoryIds, options) => {
        this.assertOpen();
        return readCategoryListingSettings(client, { ...target, categoryIds, forUpdate: options?.forUpdate });
      },
      loadCategoryMarks: async (productIds) => {
        this.assertOpen();
        return readProductCategoryMarks(client, { ...target, productIds });
      },
      insertFirstCategoryMarks: async (input) => {
        this.assertOpen();
        // The audit row's actor and its payload name the same job.
        if (input.jobKey !== scope.actor.actorId) {
          throw listingSettingsInvariantFailed("First category marks are written only for the transaction's own job key.");
        }
        return insertFirstCategoryMarksWithClient(client, scope, input);
      },
    };
  }

  private assertOpen(): void {
    if (!this.isOpen()) throw transactionEnded();
  }
}

interface RequestKeyUseRow {
  source: unknown; id: unknown; store_connection_id: unknown; target_id: unknown;
  request_hash: unknown; request_id: unknown; operation: unknown;
}

/**
 * The replay probe's rows, parsed strictly (plan 4.6): every id a positive
 * int (bigint ids arrive as strings), every hash 64 hex characters, a ledger
 * operation the ledger's CHECK allows, and at most one product revision,
 * category revision and ledger row (each is unique on the vendor and key).
 * Children come back by kind, then size, then revision id.
 */
async function readRequestKeyUse(client: QueryClient, input: { vendorId: number; requestKey: string }): Promise<RequestKeyUse> {
  // The domain's child kinds, in the probe's parameter order ($3-$6): one list for the SQL, this parser and the classifier.
  const prefixes = REQUEST_KEY_CHILD_SOURCES.map((kind) => listingSettingChildKeyPrefix(input.requestKey, kind));
  const result = await client.query<RequestKeyUseRow>(REQUEST_KEY_USE_SQL, [input.vendorId, input.requestKey, ...prefixes]);
  const use: { -readonly [K in keyof RequestKeyUse]: RequestKeyUse[K] } = {
    productRevision: null, categoryRevision: null, ledger: null, children: [],
  };
  const children: Array<RequestKeyUse["children"][number]> = [];
  for (const row of result.rows) {
    const source = row.source;
    const id = probeId(row.id, source, "id");
    const storeConnectionId = probeId(row.store_connection_id, source, "store_connection_id");
    const requestHash = probeHash(row.request_hash, source);
    if (source === "product") {
      if (use.productRevision) throw probeRowInvalid(source, "id");
      use.productRevision = { revisionId: id, productId: probeId(row.target_id, source, "target_id"), storeConnectionId, requestHash,
        requestId: row.request_id === null ? null : probeId(row.request_id, source, "request_id") };
    } else if (source === "category") {
      if (use.categoryRevision) throw probeRowInvalid(source, "id");
      use.categoryRevision = { revisionId: id, categoryId: probeId(row.target_id, source, "target_id"), storeConnectionId, requestHash };
    } else if (source === "ledger") {
      if (use.ledger) throw probeRowInvalid(source, "id");
      if (!(LISTING_SETTING_REQUEST_OPERATIONS as readonly unknown[]).includes(row.operation)) throw probeRowInvalid(source, "operation");
      use.ledger = { requestId: id, operation: row.operation as ListingSettingRequestOperation, storeConnectionId, requestHash };
    } else if ((REQUEST_KEY_CHILD_SOURCES as readonly unknown[]).includes(source)) {
      children.push({ kind: source as RequestKeyChildSource, revisionId: id,
        productVariantId: probeId(row.target_id, source, "target_id"), storeConnectionId, requestHash });
    } else {
      throw probeRowInvalid(source, "source");
    }
  }
  const kindOrder = (kind: RequestKeyChildSource) => REQUEST_KEY_CHILD_SOURCES.indexOf(kind);
  use.children = children.sort((left, right) => kindOrder(left.kind) - kindOrder(right.kind)
    || left.productVariantId - right.productVariantId || left.revisionId - right.revisionId);
  return use;
}

/** int4 and bigint ids alike; a bigint arrives as a string and is refused unless it is a whole number. */
function probeId(value: unknown, source: unknown, column: string): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw probeRowInvalid(source, column);
  return id;
}

function probeHash(value: unknown, source: unknown): string {
  if (typeof value !== "string" || !REQUEST_HASH_PATTERN.test(value)) throw probeRowInvalid(source, "request_hash");
  return value;
}

function probeRowInvalid(source: unknown, column: string): DropshipError {
  return listingSettingsInvariantFailed("A stored row of a listing settings request key failed its contract.", {
    source: typeof source === "string" ? source : null, column,
  });
}

/**
 * Database errors as the listing-settings codes (plan 3.9). A DropshipError
 * passes unchanged. Anything unmapped is rethrown as it is: an unexpected
 * failure is fatal and keeps its own detail. No vendor text is copied: a
 * CHECK or trigger message names only the constraint or the guard.
 */
export function mapListingSettingWriteError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  const pgError = databaseError(error);
  if (!pgError) return error;
  const { code, constraint } = pgError;
  if (code === UNIQUE_VIOLATION && constraint !== undefined && REQUEST_KEY_CONSTRAINTS.has(constraint)) {
    // PR 9's routes never reach this (one member per vendor, the request lock is member:key); an older
    // per-size policy or shelf route given a child-key-shaped key can, between a PR 9 write's probe and
    // its insert (those take no store lock). For the other keys it is a backstop (REQUEST_KEY_CONSTRAINTS).
    return listingSettingsIdempotencyConflict({ constraint });
  }
  if (code === FOREIGN_KEY_VIOLATION && constraint !== undefined && PRODUCT_FOREIGN_KEYS.has(constraint)) {
    return new DropshipError("DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "This Card Shellz product was not found.", {
      ...missingKey(pgError.detail, "product_id", "productId"), constraint, retryable: false, classification: "permanent",
    });
  }
  if (code === FOREIGN_KEY_VIOLATION && constraint !== undefined && CATEGORY_FOREIGN_KEYS.has(constraint)) {
    return new DropshipError("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "This Card Shellz category was not found.", {
      ...missingKey(pgError.detail, "category_id", "categoryId"), constraint, retryable: false, classification: "permanent",
    });
  }
  if (code === CHECK_VIOLATION) {
    // A CHECK or a guard trigger fired under the locks: a writer bypassed its contract.
    return listingSettingsInvariantFailed("A listing setting write was refused by the database's integrity rules.", {
      sqlState: code,
      ...(constraint === undefined ? {} : { constraint }),
      ...(pgError.table === undefined ? {} : { table: pgError.table }),
      databaseMessage: pgError.message,
    });
  }
  if (code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE) {
    return new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY",
      "Listing settings are being changed by another request. Try again.", {
        sqlState: code, retryable: true, classification: "transient",
      });
  }
  if (code.startsWith(CONNECTION_FAILURE_PREFIX) || CONNECTION_FAILURE_STATES.has(code) || CONNECTION_FAILURE_ERRNOS.has(code)) {
    return databaseUnavailable(code);
  }
  return error;
}

/**
 * A failure outside a write transaction's body (taking a connection, or a
 * read on the pool), mapped as a write's would be; a pool with no free
 * connection in time is the retryable BUSY too. Used by the reads here and by
 * the first-mark job's reads (dropship-category-marks-job.source.ts).
 */
export function mapListingSettingDatabaseError(error: unknown): unknown {
  return isPoolAcquireTimeout(error) ? databaseUnavailable("pool_acquire_timeout") : mapListingSettingWriteError(error);
}

/** The connection failures above as the retryable BUSY answer (503 with Retry-After). */
function databaseUnavailable(failure: string): DropshipError {
  return new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings couldn't be reached right now. Try again in a few seconds.", {
    failure, retryable: true, classification: "transient",
  });
}

function isPoolAcquireTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === POOL_ACQUIRE_TIMEOUT_MESSAGE;
}

interface DatabaseErrorFields {
  code: string;
  constraint?: string;
  table?: string;
  detail?: string;
  message: string;
}

/** The fields node-postgres puts on a server error; anything without a SQLSTATE is not one. */
function databaseError(error: unknown): DatabaseErrorFields | null {
  if (!error || typeof error !== "object") return null;
  const fields = error as { code?: unknown; constraint?: unknown; table?: unknown; detail?: unknown; message?: unknown };
  if (typeof fields.code !== "string") return null;
  return {
    code: fields.code,
    ...(typeof fields.constraint === "string" ? { constraint: fields.constraint } : {}),
    ...(typeof fields.table === "string" ? { table: fields.table } : {}),
    ...(typeof fields.detail === "string" ? { detail: fields.detail } : {}),
    message: typeof fields.message === "string" ? fields.message : "",
  };
}

/** The missing id from PostgreSQL's `Key (<column>)=(<id>) is not present ...` detail, when it has that form. */
function missingKey(detail: string | undefined, column: string, field: string): Record<string, number> {
  const match = detail === undefined ? null : new RegExp(`^Key \\(${column}\\)=\\((\\d{1,10})\\)`).exec(detail);
  return match ? { [field]: Number(match[1]) } : {};
}

/**
 * The client the transaction object uses: every statement first checks that
 * the transaction is still open, so a delegate called after commit or
 * rollback fails instead of running on a connection back in the pool.
 */
function guardedClient(client: QueryClient, isOpen: () => boolean): QueryClient {
  const query = (...args: unknown[]): unknown => {
    if (!isOpen()) throw transactionEnded();
    return (client.query as (...queryArgs: unknown[]) => unknown).apply(client, args);
  };
  return { query: query as PoolClient["query"] };
}

function transactionEnded(): DropshipError {
  return listingSettingsInvariantFailed("A listing settings transaction was used after it ended.");
}

function ownerVendorId(row: { vendor_id: unknown } | undefined, storeConnectionId: number): number {
  const vendorId = row?.vendor_id;
  if (typeof vendorId === "number" && isInt4Id(vendorId)) return vendorId;
  throw new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", {
    storeConnectionId, retryable: false, classification: "permanent",
  });
}

/** PR 9's services build these; a breach is a programming fault (fatal), before any connection is taken. */
function assertVendorInput(input: { memberId: string; storeConnectionId: number; idempotencyKey: string }): void {
  const invalid = [
    isActorId(input.memberId) ? null : "memberId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
    typeof input.idempotencyKey === "string" && LISTING_SETTING_KEY_PATTERN.test(input.idempotencyKey) ? null : "idempotencyKey",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A listing settings transaction was opened outside its contract.", { invalid });
}

function assertReviewInput(input: { memberId: string; storeConnectionId: number }): void {
  const invalid = [
    isActorId(input.memberId) ? null : "memberId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A listing settings price check was opened outside its contract.", { invalid });
}

function assertPreflightInput(input: { memberId: string; storeConnectionId: number; idempotencyKey: string | null }): void {
  const invalid = [
    isActorId(input.memberId) ? null : "memberId",
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
    input.idempotencyKey === null
      || (typeof input.idempotencyKey === "string" && LISTING_SETTING_KEY_PATTERN.test(input.idempotencyKey)) ? null : "idempotencyKey",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A listing settings preflight was opened outside its contract.", { invalid });
}

function assertSystemInput(input: { storeConnectionId: number; jobKey: string }): void {
  const invalid = [
    isInt4Id(input.storeConnectionId) ? null : "storeConnectionId",
    isActorId(input.jobKey) ? null : "jobKey",
  ].filter((field): field is string => field !== null);
  if (invalid.length > 0) throw listingSettingsInvariantFailed("A listing settings system transaction was opened outside its contract.", { invalid });
}

/** Positive int4 ids, distinct and ascending, so rows are locked in one order. */
function lockIds(ids: readonly number[] | undefined, field: string): number[] {
  if (ids === undefined) return [];
  if (!ids.every(isInt4Id)) throw listingSettingsInvariantFailed("lockCatalog ids must be positive whole numbers.", { field });
  return [...new Set(ids)].sort((left, right) => left - right);
}

/** The actor id is stored in varchar(255) actor_id columns and must not be blank. */
function isActorId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_LISTING_SETTING_ACTOR_ID_LENGTH;
}

function isInt4Id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_INT4_ID;
}
