import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { LISTING_SETTING_KEY_PATTERN } from "../../../../shared/dropship/listing-setting-values";
import type { ListingPriceTransaction } from "../application/dropship-listing-price-service";
import type {
  ListingSettingActor,
  ListingSettingSystemTransaction,
  ListingSettingWriteRepository,
  ListingSettingWriteTransaction,
} from "../application/dropship-listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { isListingSettingChildKey, listingSettingChildKey, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { readCategoryListingSettings, saveCategoryListingSettingWithClient } from "./dropship-category-listing-settings.repository";
import { saveEbayCategoryRulesProfileWithClient } from "./dropship-ebay-category-rules.repository";
import { saveListingContentWithClient } from "./dropship-listing-content.repository";
import { listingPriceTransactionForClient } from "./dropship-listing-price.repository";
import { MAX_LISTING_SETTING_ACTOR_ID_LENGTH, listingSettingsIdempotencyConflict, type ListingSettingWriteScope } from "./dropship-listing-setting-shared.repository";
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
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";

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
 *    (categories before products, the order a Card Shellz rename writes them);
 * 5. the target rows FOR UPDATE, inside the writers;
 * 6. the writes: ledger, revisions, current rows, audit.
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
const SYSTEM_OWNER_SQL = `SELECT sc.vendor_id FROM dropship.dropship_store_connections sc
       JOIN dropship.dropship_vendors v ON v.id = sc.vendor_id
       WHERE sc.id = $1 FOR SHARE OF v, sc`;
/** The same SHARE locks W9 and the content writer take: admin rule replacement and selection phantoms wait, catalog reads do not. */
const SELECTION_LOCK_SQL = `LOCK TABLE dropship.dropship_catalog_rules, dropship.dropship_vendor_selection_rules,
       dropship.dropship_vendor_variant_overrides, catalog.product_line_products IN SHARE MODE`;
const CATEGORY_LOCK_SQL = "SELECT id FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";
const PRODUCT_LOCK_SQL = "SELECT id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";
const VARIANT_LOCK_SQL = "SELECT id FROM catalog.product_variants WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE";

/** The request-key unique constraints of 0736 and 0737; a 23505 on any other constraint is not a key reuse and is rethrown. */
const REQUEST_KEY_CONSTRAINTS: ReadonlySet<string> = new Set([
  "dropship_product_listing_setting_requests_key_idx",
  "dropship_product_listing_setting_revision_key_uk",
  "dropship_category_listing_setting_revision_key_uk",
]);
const PRODUCT_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  "dropship_product_listing_setting_revision_product_fk",
  "dropship_product_listing_setting_product_fk",
]);
const CATEGORY_FOREIGN_KEYS: ReadonlySet<string> = new Set([
  "dropship_category_listing_setting_revision_category_fk",
  "dropship_category_listing_setting_category_fk",
]);
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const CHECK_VIOLATION = "23514";
const DEADLOCK_DETECTED = "40P01";
/** Not raised under READ COMMITTED today; mapped so PR 9's SERIALIZABLE option (W7) inherits the right class. */
const SERIALIZATION_FAILURE = "40001";

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
   * BEGIN (READ COMMITTED), the body, COMMIT; on any failure ROLLBACK, then
   * the mapped error. The body gets the raw client for the wrapper's own locks
   * and a guarded client for the transaction object. The transaction is open
   * only while the body runs: once it returns or throws, the transaction
   * object refuses every call, so one kept past `execute` can never write on
   * a connection the pool has handed on.
   */
  private async inTransaction<T>(
    body: (client: QueryClient, guarded: QueryClient, isOpen: () => boolean) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    let open = true;
    const isOpen = () => open;
    try {
      await client.query("BEGIN");
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
  /** A child key names one revision, so each child target is written at most once (the D30 rule for children). */
  private ebayRulesSaved = false;
  private readonly contentSavedVariantIds = new Set<number>();
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
      lockCatalog: (input) => this.lockCatalog(input),
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
        this.contentSavedVariantIds.add(productVariantId);
        this.targetsTouched = true;
        return saveListingContentWithClient(client, contentTarget, productVariantId, save, hash, now);
      },
    };
  }

  /** One call per transaction, with every id, so the order holds across kinds; only before any target lock or write. */
  private async lockCatalog(input: {
    categoryIds?: readonly number[]; productIds?: readonly number[]; productVariantIds?: readonly number[];
  }): Promise<void> {
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
    await this.client.query(SELECTION_LOCK_SQL);
    if (categoryIds.length > 0) await this.client.query(CATEGORY_LOCK_SQL, [categoryIds]);
    if (productIds.length > 0) await this.client.query(PRODUCT_LOCK_SQL, [productIds]);
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
    // Two first uses of one key that both missed the replay read (another member of the vendor, the same key).
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
  return error;
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
