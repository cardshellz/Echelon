import {
  saveSizePricesInputSchema,
  type SaveSizePricesInput,
  type SaveSizePricesResponse,
} from "../../../../shared/dropship/listing-setting-writes";
import { DropshipError } from "../domain/errors";
import { classifyRequestKeyUse, type RequestKeyUse } from "../domain/listing-setting-request-key-use";
import { listingSettingChildKey, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { saveListingPriceInTransaction } from "./dropship-listing-price-service";
import {
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingStoreIdSchema,
  listingSettingWriteHash,
  parseListingSettingInput,
  requestKeyUsePath,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type { ListingSettingWriteRepository, ListingSettingWriteTransaction } from "./dropship-listing-setting-writes";
import type { DropshipClock } from "./dropship-ports";

/**
 * W8, "Give these sizes a price" (Listing settings design 8.5; plan PR 9,
 * section 4.3): typed prices for up to MAX_SIZE_PRICES_PER_REQUEST sizes in one
 * transaction, each through W9's own checks (plan D29), all or none. Version
 * conflicts and prices outside a Card Shellz limit are gathered so the vendor
 * sees every size to fix at once; any other refusal stops at once.
 */

export interface DropshipListingSizePricesServiceDependencies {
  repository: ListingSettingWriteRepository;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The writer's versioned operation in the request hash (plan 3.7). */
const SIZE_PRICES_OPERATION = "size_prices_v1";
/** A refusal or log line names at most this many sizes, with the full count beside it. */
const MAX_LISTED_SIZES = 100;
const VERSION_CONFLICT = "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT";
const OUTSIDE_LIMIT = "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT";
/**
 * W9's refusals of one size that stop the request at once (plan P19). Some
 * carry no size (dropship-listing-price-service.ts throws NOT_AVAILABLE with
 * no context), so W8 adds the size it stopped on: in a request of up to 200
 * sizes the vendor is told which one.
 */
const SIZE_REFUSALS: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
]);

type SizeRow = SaveSizePricesInput["rows"][number];
interface SavedSize { productVariantId: number; beforeRevisionId: number | null; afterRevisionId: number }
interface VersionConflict { productVariantId: number; expectedRevisionId: number | null; actualRevisionId: number | null }
interface LimitRefusal { productVariantId: number; priceCents: number; blockers: string[] }

export class DropshipListingSizePricesService {
  constructor(private readonly deps: DropshipListingSizePricesServiceDependencies) {}

  async saveForMember(memberId: string, storeId: unknown, body: unknown): Promise<SaveSizePricesResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(saveSizePricesInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Ascending ids: the hash does not depend on the order sent, and sizes are written in lock order.
    const rows = [...parsed.rows].sort((left, right) => left.productVariantId - right.productVariantId);
    const sizeIds = rows.map((row) => row.productVariantId);
    const requestHash = listingSettingWriteHash(SIZE_PRICES_OPERATION, { storeConnectionId, rows });

    const { response, saved, vendorId } = await this.deps.repository.execute({
      memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey,
    }, async (tx) => {
      await authorizeListingSettingWrite(tx);
      // Replay before re-reading anything (plan P16): a retry of a committed save
      // is answered from what it wrote, even if prices or limits moved since.
      const use = await tx.findRequestKeyUse();
      const decision = classifyRequestKeyUse(use, { writer: "size_prices", storeConnectionId, requestHash, sizeIds });
      if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") {
        return { response: replayAnswer(use), saved: [] as SavedSize[], vendorId: tx.vendorId };
      }
      const written = await this.saveSizes(tx, { storeConnectionId, requestKey: parsed.idempotencyKey, requestHash, now, rows });
      return { response: changedAnswer(written), saved: written, vendorId: tx.vendorId };
    });

    this.deps.log.info("dropship.listing_settings.size_prices_saved", {
      outcome: response.outcome,
      vendor_id: vendorId,
      store_connection_id: storeConnectionId,
      actor_id: memberId,
      request_key: parsed.idempotencyKey,
      before: saved.slice(0, MAX_LISTED_SIZES).map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.beforeRevisionId })),
      after: response.sizes.slice(0, MAX_LISTED_SIZES).map((size) => ({ product_variant_id: size.productVariantId, revision_id: size.revisionId })),
      changed_count: saved.length,
      size_count: response.sizes.length,
      elapsed_ms: Math.max(0, Math.round(this.deps.timer() - started)),
    });
    return response;
  }

  /**
   * lockCatalog with every size and its product (W9's own path locks the
   * product too), then W9's flow per size in ascending order. A size missing
   * from the catalog is refused at once by the wrapper. Throwing rolls back
   * every size already written.
   */
  private async saveSizes(tx: ListingSettingWriteTransaction, input: {
    storeConnectionId: number; requestKey: string; requestHash: string; now: Date; rows: readonly SizeRow[];
  }): Promise<SavedSize[]> {
    const sizeIds = input.rows.map((row) => row.productVariantId);
    // Unlocked, only to learn the products; lockCatalog then holds them.
    const candidates = await tx.catalog.listCatalogCandidates(sizeIds);
    const productIds = [...new Set(candidates.map((candidate) => candidate.productId))];
    await tx.lockCatalog({ productIds, productVariantIds: sizeIds });
    const saved: SavedSize[] = [];
    const conflicts: VersionConflict[] = [];
    const limits: LimitRefusal[] = [];
    for (const row of input.rows) {
      try {
        // W9 throws each refusal before that size's first write and with no SQL
        // error, so the transaction stays usable for the next size (plan P19).
        const result = await saveListingPriceInTransaction(tx.sizePrice(row.productVariantId),
          { storeConnectionId: input.storeConnectionId, productVariantId: row.productVariantId },
          { priceCents: row.priceCents, pricingMode: "fixed", expectedRevisionId: row.expectedRevisionId,
            idempotencyKey: listingSettingChildKey(input.requestKey, "size", row.productVariantId) },
          input.requestHash, input.now);
        // The probe found no child of this key and the store lock is held, so
        // nothing can replay here; a replay would be answered as `changed`.
        if (result.idempotentReplay || result.price.revisionId === null) {
          throw listingSettingsInvariantFailed("A size price in a new listing settings request replayed or saved no revision.", {
            productVariantId: String(row.productVariantId),
          });
        }
        saved.push({ productVariantId: row.productVariantId, beforeRevisionId: row.expectedRevisionId,
          afterRevisionId: result.price.revisionId });
      } catch (error) {
        if (isRefusal(error, VERSION_CONFLICT)) {
          conflicts.push({ productVariantId: row.productVariantId, expectedRevisionId: row.expectedRevisionId,
            actualRevisionId: revisionIdOf(error.context?.actualRevisionId) });
          continue;
        }
        if (isRefusal(error, OUTSIDE_LIMIT)) {
          limits.push({ productVariantId: row.productVariantId, priceCents: row.priceCents, blockers: blockersOf(error.context?.blockers) });
          continue;
        }
        throw namingSize(error, input.storeConnectionId, row.productVariantId);
      }
    }
    if (conflicts.length > 0) throw versionConflicts(input.storeConnectionId, conflicts);
    if (limits.length > 0) throw outsideLimits(input.storeConnectionId, limits);
    return saved;
  }
}

/** A replay calls no writer: the sizes and revisions the key already wrote (plan P16). */
function replayAnswer(use: RequestKeyUse): SaveSizePricesResponse {
  return {
    outcome: "replayed",
    sizes: use.children.filter((child) => child.kind === "size")
      .map((child) => ({ productVariantId: child.productVariantId, revisionId: child.revisionId, idempotentReplay: true }))
      .sort((left, right) => left.productVariantId - right.productVariantId),
  };
}

function changedAnswer(saved: readonly SavedSize[]): SaveSizePricesResponse {
  return {
    outcome: "changed",
    sizes: saved.map((size) => ({ productVariantId: size.productVariantId, revisionId: size.afterRevisionId, idempotentReplay: false })),
  };
}

function isRefusal(error: unknown, code: string): error is DropshipError {
  return error instanceof DropshipError && error.code === code;
}

/**
 * A size refusal that names no size, rethrown with the same code and words
 * and the size it stopped on. Anything else passes unchanged: a database
 * error must reach the wrapper as it is, which maps it after the rollback.
 */
function namingSize(error: unknown, storeConnectionId: number, productVariantId: number): unknown {
  if (!(error instanceof DropshipError) || !SIZE_REFUSALS.has(error.code)) return error;
  if (typeof error.context?.productVariantId === "number") return error;
  return new DropshipError(error.code, error.message, {
    ...error.context, storeConnectionId, productVariantId, retryable: false, classification: "permanent",
  });
}

function revisionIdOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** W9's blocker codes (`pricing:below_floor:policy_<id>`); never vendor text. */
function blockersOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((blocker): blocker is string => typeof blocker === "string") : [];
}

function versionConflicts(storeConnectionId: number, conflicts: readonly VersionConflict[]): DropshipError {
  return new DropshipError(VERSION_CONFLICT,
    `${sizeCount(conflicts.length)} changed after you opened ${conflicts.length === 1 ? "it" : "them"}. Reload before saving again.`, {
      storeConnectionId, conflicts: conflicts.slice(0, MAX_LISTED_SIZES), conflictCount: conflicts.length,
      retryable: false, classification: "permanent",
    });
}

function outsideLimits(storeConnectionId: number, limits: readonly LimitRefusal[]): DropshipError {
  return new DropshipError(OUTSIDE_LIMIT,
    `${sizeCount(limits.length)} would be outside what Card Shellz allows. Enter prices Card Shellz allows.`, {
      storeConnectionId, sizes: limits.slice(0, MAX_LISTED_SIZES), sizeCount: limits.length,
      retryable: false, classification: "permanent",
    });
}

function sizeCount(count: number): string {
  return count === 1 ? "1 size's price" : `${count} sizes' prices`;
}
