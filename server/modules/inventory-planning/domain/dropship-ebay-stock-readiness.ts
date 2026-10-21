import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  dropshipEbayStockReadinessInputSchema,
  type DropshipEbayStockOrigin,
  type DropshipEbayStockReadinessInput,
} from "@shared/types/dropship-ebay-stock-readiness";

/** Prefix of every Dropship stock-link key: the command advisory lock, the mapping
 * preparation key (`<prefix>:<uuid>`, 56 chars, varchar(120)) and each draft key
 * (`<prefix>:<uuid>:<variantId>`, at most 67 chars). */
export const DROPSHIP_EBAY_STOCK_KEY_PREFIX = "dropship-ebay-stock";

/** Reason stored on every draft and promotion this writer makes. */
export const DROPSHIP_EBAY_STOCK_CHANGE_REASON = "Reviewed exact eBay SKU stock link for a Dropship store listing.";

/** Above this hold time canonical order claims, ATP planners and dispatch (which
 * take the runtime authority share lock the fence drains) visibly queue. Logged as
 * WARN for operations; it never changes an outcome. */
export const FENCE_HOLD_WARN_MS = 2_000;

/** Full canonical plans that run while the fence is held: the post-promotion
 * review, applyMappingPreparation's own review, and its publishProduct. */
export const PLANS_IN_FENCE = 3;

// UUIDv5 with a fixed application namespace (pattern of
// domain/ebay-automatic-publication-recovery.ts): a replay of the same push item or
// the same enrollment evidence reuses its command; any other origin gets its own.
const DROPSHIP_EBAY_STOCK_COMMAND_NAMESPACE = Buffer.from("5d1c2b7e9a4f4c03b8e61f2d7a9c0e44", "hex");

/** The stable origin identity. It excludes the SKU on purpose: a different SKU
 * under the same job item must be detected as a command conflict, not a new link. */
export function dropshipEbayStockOriginKey(storeConnectionId: number, origin: DropshipEbayStockOrigin): string {
  return origin.kind === "listing_push"
    ? `listing_push:${storeConnectionId}:${origin.jobItemId}`
    : `live_listing_enrollment:${storeConnectionId}:${origin.listingId}:${origin.evidenceHash}`;
}

export function dropshipEbayStockCommandKey(storeConnectionId: number, origin: DropshipEbayStockOrigin): string {
  const bytes = createHash("sha1").update(DROPSHIP_EBAY_STOCK_COMMAND_NAMESPACE)
    .update(dropshipEbayStockOriginKey(storeConnectionId, origin)).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Validates and returns a new input with variants in variant-id order. The
 * caller's object is never mutated. */
export function normalizeDropshipEbayStockInput(raw: unknown): DropshipEbayStockReadinessInput {
  const source = dropshipEbayStockReadinessInputSchema.parse(raw);
  return { ...source, variants: [...source.variants].sort((a, b) => a.productVariantId - b.productVariantId) };
}

/** Binds a command to its exact source and actor: replaying the same command
 * with anything else (SKU, account, purpose, product, actor) is a conflict. */
export function dropshipEbayStockRequestHash(source: DropshipEbayStockReadinessInput, actor: string): string {
  return createHash("sha256").update(canonicalJson({ source, actor })).digest("hex");
}

export const dropshipEbayStockPreparationKey = (commandKey: string): string => `${DROPSHIP_EBAY_STOCK_KEY_PREFIX}:${commandKey}`;
