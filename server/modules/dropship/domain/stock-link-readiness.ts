import { DropshipError } from "./errors";
import { isDatabaseUnavailableError } from "./database-unavailable-error";
import {
  dropshipStockLinkServerMessage,
  type DropshipStockLinkRefusalCode,
} from "../../../../shared/dropship/stock-link-refusals";

/**
 * Pure classification of the automatic stock link a Dropship eBay push makes
 * (plan F2 sections 2.8 and 6.1). Inventory-planning owns the link writer and
 * returns business refusals as blockers or throws concurrency/infrastructure
 * conditions; this file decides the Dropship code, its class, whether it is
 * retried and who must act. No I/O.
 */

/** A push whose stock Card Shellz manages on a live listing: the only kind that is linked. */
export function isManagedLiveIntent(intent: { listingMode: string; inventoryMode: string }): boolean {
  return intent.listingMode === "live" && intent.inventoryMode === "managed_quantity_sync";
}

/**
 * In-process attempts at the link before the item fails as DROPSHIP_STOCK_LINK_BUSY,
 * and the waits between them. Together (7.5 s) they cover one in-flight eBay
 * request on the same SKU (the admission's provider scope lock), one outbox drain
 * of that SKU, or a short wait for the inventory cutover fence (lock_timeout 5 s).
 * Longer conditions go to the push sweep's automatic re-queue instead.
 */
export const STOCK_LINK_MAX_ATTEMPTS = 4;
export const STOCK_LINK_RETRY_BACKOFF_MS: readonly number[] = Object.freeze([500, 2_000, 5_000]);

/**
 * Retries of an admitted eBay quantity write refused PUBLICATION_SCOPE_BUSY (the
 * exact SKU's provider scope try-lock is held, usually by the outbox draining a row
 * the link just queued). The refusal is raised before planning or provider I/O, so
 * repeating the same request is safe.
 */
export const PUBLICATION_SCOPE_BUSY_BACKOFF_MS: readonly number[] = Object.freeze([500, 1_500, 3_000]);
export const PUBLICATION_SCOPE_BUSY_CODE = "PUBLICATION_SCOPE_BUSY";

export type StockLinkClassification = "transient" | "permanent" | "fatal";
export type StockLinkLogLevel = "debug" | "info" | "warn" | "error";

export interface StockLinkRefusalPolicy {
  readonly classification: StockLinkClassification;
  readonly retryable: boolean;
  /** Card Shellz (not the vendor) has to act; logged at ERROR and kept for an admin retry. */
  readonly needsOperator: boolean;
  readonly logLevel: StockLinkLogLevel;
}

const permanent = (needsOperator: boolean, logLevel: StockLinkLogLevel): StockLinkRefusalPolicy =>
  Object.freeze({ classification: "permanent", retryable: false, needsOperator, logLevel });

/** Plan 6.1, one row per Dropship code. */
export const STOCK_LINK_REFUSAL_POLICY: Readonly<Record<DropshipStockLinkRefusalCode, StockLinkRefusalPolicy>> = Object.freeze({
  DROPSHIP_STOCK_DESTINATION_NOT_READY: permanent(true, "error"),
  DROPSHIP_STOCK_DESTINATION_DUPLICATED: permanent(true, "error"),
  DROPSHIP_STOCK_ITEM_NOT_READY: permanent(true, "error"),
  DROPSHIP_STOCK_STORE_ON_HOLD: permanent(false, "info"),
  DROPSHIP_STOCK_ITEM_ON_HOLD: permanent(false, "info"),
  DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED: permanent(false, "warn"),
  DROPSHIP_STOCK_SKU_LINK_CONFLICT: permanent(true, "error"),
  DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU: permanent(true, "error"),
  DROPSHIP_STOCK_SKU_CHANGED: permanent(false, "info"),
  DROPSHIP_STOCK_LINK_CHANGED: permanent(false, "warn"),
  DROPSHIP_STOCK_NOT_OFFERED: permanent(false, "info"),
  DROPSHIP_STOCK_MODE_NOT_MANAGED: permanent(false, "info"),
  DROPSHIP_STOCK_UPDATES_PAUSED: Object.freeze({ classification: "transient", retryable: true, needsOperator: false, logLevel: "warn" }),
  DROPSHIP_STOCK_LINK_BUSY: Object.freeze({ classification: "transient", retryable: true, needsOperator: false, logLevel: "warn" }),
  DROPSHIP_STOCK_LINK_FAILED: Object.freeze({ classification: "fatal", retryable: false, needsOperator: true, logLevel: "error" }),
  DROPSHIP_STOCK_READINESS_REQUIRED: Object.freeze({ classification: "fatal", retryable: false, needsOperator: true, logLevel: "error" }),
  // The vendor decides whether Card Shellz may take over the listing found on eBay (WARN: an anomaly, no operator).
  DROPSHIP_STOCK_RESEND_LISTING_FOUND: permanent(false, "warn"),
});

/** Inventory blocker codes, as the 2a-1 link writer returns them (item-level when productVariantId is set). */
const DESTINATION_CODES = new Set(["PUBLICATION_DESTINATION_NOT_LIVE", "PUBLICATION_SOURCE_NOT_READY", "STOCK_LISTING_TARGET_UNAVAILABLE"]);
/** This SKU is mapped to another item (the SKU's owner differs). */
const SKU_LINK_CONFLICT_CODES = new Set(["STOCK_LISTING_MAPPING_CONFLICT", "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT"]);
/**
 * This item's own active mapping or saved draft names a different SKU
 * (reviewEbayPublicationMember, inventory-planning domain/ebay-publication-readiness.ts):
 * the reverse of a SKU link conflict, so it has its own words (review TW-4).
 */
const ITEM_LINKED_TO_OTHER_SKU_CODE = "STOCK_LISTING_MAPPING_REVIEW_REQUIRED";
const SKU_CHANGED_CODES = new Set(["STOCK_LISTING_SOURCE_CHANGED", "STOCK_MAPPING_COMMAND_CONFLICT"]);
const NOT_OFFERED_CODES = new Set(["STOCK_LISTING_NOT_SELECTED", "INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID"]);
/** Dropship's own stock-selection blockers (domain/stock-publication-selection.ts), reported item-level by the planner. */
const DROPSHIP_SELECTION_BLOCKER_PREFIX = "DROPSHIP_STOCK_";

/**
 * Concurrency and infrastructure conditions that clear by themselves. Inventory
 * throws most of them; a few can also come back as a destination-level blocker of
 * the in-fence review (STOCK_MAPPING_TARGET_CHANGED, CANONICAL_AUTHORITY_REQUIRED,
 * STOCK_MAPPING_NOT_READY), so both shapes are classified the same way.
 */
export const TRANSIENT_STOCK_LINK_CODES: ReadonlySet<string> = new Set([
  "STOCK_MAPPING_PROVIDER_BUSY", "STOCK_MAPPING_CONCURRENT_CHANGE", "STOCK_MAPPING_REVIEW_STALE",
  "STOCK_MAPPING_TARGET_CHANGED", "STOCK_MAPPING_NOT_READY", "STOCK_MAPPING_CLEANUP_UNCERTAIN",
  "STOCK_MAPPING_AUTHORITY_CHANGED", "CANONICAL_AUTHORITY_REQUIRED", "INVENTORY_PUBLICATION_TARGET_BUSY",
  "CUTOVER_REVIEWED_HEAD_CHANGED",
]);
/** PostgreSQL SQLSTATEs that a retry clears: serialization, deadlock, lock or statement timeout. */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);
/**
 * The inventory code recorded for a lost or unavailable database connection that
 * carries no code of its own (node-postgres's pool timeout and dropped-socket
 * errors). Retrying is safe: the link writer is idempotent (its fast path and the
 * command's preparation receipt make a repeated link a no-op).
 */
export const DATABASE_UNAVAILABLE_INVENTORY_CODE = "DATABASE_UNAVAILABLE";
/** The cutover fence raises these as SQLSTATE 55000 when admission moved under it (migration 236). */
export const TRANSIENT_FENCE_MESSAGES: ReadonlySet<string> = new Set(["CUTOVER_CONFIGURATION_FREEZE_CHANGED", "CUTOVER_AUTHORITY_CHANGED"]);

export interface StockLinkBlocker {
  readonly code: string;
  readonly productVariantId: number | null;
}

/** Most decisive first: a store-level problem before an item-level one, any
 * permanent refusal before a transient one (never retry what cannot clear). */
const REFUSAL_PRECEDENCE: readonly DropshipStockLinkRefusalCode[] = [
  "DROPSHIP_STOCK_DESTINATION_DUPLICATED",
  "DROPSHIP_STOCK_DESTINATION_NOT_READY",
  "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED",
  "DROPSHIP_STOCK_STORE_ON_HOLD",
  "DROPSHIP_STOCK_SKU_LINK_CONFLICT",
  "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU",
  "DROPSHIP_STOCK_SKU_CHANGED",
  "DROPSHIP_STOCK_LINK_CHANGED",
  "DROPSHIP_STOCK_ITEM_ON_HOLD",
  "DROPSHIP_STOCK_NOT_OFFERED",
  "DROPSHIP_STOCK_ITEM_NOT_READY",
  "DROPSHIP_STOCK_UPDATES_PAUSED",
  "DROPSHIP_STOCK_LINK_BUSY",
];

/** The Dropship code for one inventory blocker (plan 6.1). */
export function dropshipCodeForStockBlocker(blocker: StockLinkBlocker, targetCount: number): DropshipStockLinkRefusalCode {
  const itemLevel = blocker.productVariantId !== null;
  if (blocker.code === "STOCK_LISTING_TARGET_MISMATCH")
    return targetCount >= 2 ? "DROPSHIP_STOCK_DESTINATION_DUPLICATED" : "DROPSHIP_STOCK_DESTINATION_NOT_READY";
  if (DESTINATION_CODES.has(blocker.code)) return "DROPSHIP_STOCK_DESTINATION_NOT_READY";
  if (blocker.code === "STOCK_LISTING_HELD") return itemLevel ? "DROPSHIP_STOCK_ITEM_ON_HOLD" : "DROPSHIP_STOCK_STORE_ON_HOLD";
  if (blocker.code === "STOCK_LISTING_ACCOUNT_CHANGED") return "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED";
  if (SKU_LINK_CONFLICT_CODES.has(blocker.code)) return "DROPSHIP_STOCK_SKU_LINK_CONFLICT";
  if (blocker.code === ITEM_LINKED_TO_OTHER_SKU_CODE) return "DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU";
  if (SKU_CHANGED_CODES.has(blocker.code)) return "DROPSHIP_STOCK_SKU_CHANGED";
  if (blocker.code === "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY") return "DROPSHIP_STOCK_LINK_CHANGED";
  if (NOT_OFFERED_CODES.has(blocker.code) || blocker.code.startsWith(DROPSHIP_SELECTION_BLOCKER_PREFIX)) return "DROPSHIP_STOCK_NOT_OFFERED";
  if (blocker.code === "STOCK_LISTING_GLOBAL_STOP") return "DROPSHIP_STOCK_UPDATES_PAUSED";
  if (TRANSIENT_STOCK_LINK_CODES.has(blocker.code)) return "DROPSHIP_STOCK_LINK_BUSY";
  // STOCK_LISTING_QUANTITY_UNAVAILABLE and any other planner blocker: the planner
  // refused this item (item-level) or this destination (destination-level).
  return itemLevel ? "DROPSHIP_STOCK_ITEM_NOT_READY" : "DROPSHIP_STOCK_DESTINATION_NOT_READY";
}

export interface StockLinkRefusal extends StockLinkRefusalPolicy {
  readonly code: DropshipStockLinkRefusalCode;
  readonly message: string;
  /** The inventory blocker that decided the code, and every code the writer returned. */
  readonly inventoryCode: string;
  readonly inventoryCodes: readonly string[];
  readonly productVariantId: number | null;
  readonly targetCount: number;
}

/** Classify a `blocked` result: the most decisive blocker names the refusal. */
export function classifyStockLinkBlockers(input: { targetCount: number; blockers: readonly StockLinkBlocker[] }): StockLinkRefusal {
  if (input.blockers.length === 0) throw new Error("A blocked stock link result must carry at least one blocker.");
  const mapped = input.blockers.map(blocker => ({ blocker, code: dropshipCodeForStockBlocker(blocker, input.targetCount) }));
  const decisive = [...mapped].sort((a, b) => REFUSAL_PRECEDENCE.indexOf(a.code) - REFUSAL_PRECEDENCE.indexOf(b.code))[0]!;
  return refusal(decisive.code, {
    inventoryCode: decisive.blocker.code,
    inventoryCodes: input.blockers.map(row => row.code),
    productVariantId: decisive.blocker.productVariantId,
    targetCount: input.targetCount,
  });
}

/** A refusal decided by Dropship itself (no inventory blocker behind it). */
export function stockLinkRefusal(code: DropshipStockLinkRefusalCode, detail: {
  inventoryCode?: string; productVariantId?: number | null; targetCount?: number;
} = {}): StockLinkRefusal {
  return refusal(code, {
    inventoryCode: detail.inventoryCode ?? code,
    inventoryCodes: detail.inventoryCode ? [detail.inventoryCode] : [],
    productVariantId: detail.productVariantId ?? null,
    targetCount: detail.targetCount ?? 0,
  });
}

function refusal(code: DropshipStockLinkRefusalCode, detail: Pick<StockLinkRefusal,
  "inventoryCode" | "inventoryCodes" | "productVariantId" | "targetCount">): StockLinkRefusal {
  return Object.freeze({ code, message: dropshipStockLinkServerMessage(code), ...STOCK_LINK_REFUSAL_POLICY[code], ...detail });
}

/** A thrown link failure: transient clears by itself (retry), fatal is an invariant failure (stop, a human looks). */
export function classifyStockLinkFailure(error: unknown): { kind: "transient" | "fatal"; inventoryCode: string } {
  const code = errorCode(error);
  if (code && TRANSIENT_STOCK_LINK_CODES.has(code)) return { kind: "transient", inventoryCode: code };
  if (code && TRANSIENT_SQLSTATES.has(code)) return { kind: "transient", inventoryCode: code };
  // A lost or unavailable connection (pool timeout, dropped socket, failover,
  // class 08, too many connections), with or without a code (review CF-1).
  if (isDatabaseUnavailableError(error)) return { kind: "transient", inventoryCode: code ?? DATABASE_UNAVAILABLE_INVENTORY_CODE };
  const message = error instanceof Error ? error.message.trim() : "";
  if (code === "55000" && TRANSIENT_FENCE_MESSAGES.has(message)) return { kind: "transient", inventoryCode: message };
  // PUBLICATION_AUTHORITY_MISSING, idempotency and receipt invariants, ZodError,
  // AggregateError (failed rollback), and anything this table does not know.
  const name = error instanceof Error ? error.name : null;
  return { kind: "fatal", inventoryCode: code ?? (name && name !== "Error" ? name : "UNKNOWN") };
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Where a refusal came from, on the error's context; the worker reads it (classifyListingPushError). */
export const STOCK_LINK_ERROR_SOURCE = "dropship_stock_link";

/** The DropshipError the push fails with. The message is the vendor's reason; operator detail stays in context. */
export function stockLinkError(refusalValue: StockLinkRefusal, context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError(refusalValue.code, refusalValue.message, {
    ...context,
    source: STOCK_LINK_ERROR_SOURCE,
    retryable: refusalValue.retryable,
    classification: refusalValue.classification,
    needsOperator: refusalValue.needsOperator,
    inventoryCode: refusalValue.inventoryCode,
    inventoryCodes: [...refusalValue.inventoryCodes],
    targetCount: refusalValue.targetCount,
    blockerProductVariantId: refusalValue.productVariantId,
  });
}
