import { z } from "zod";

/**
 * Contracts of inventory planning's stock-link engine (channels PR2, PLAN-CH2 v4.1 §4.1): the destination a link
 * belongs to, one store item as the store reports it, the two provider reads (SKU lookup, saved-item observation),
 * the check-row status and failure record, and the Channel Inventory control DTOs (§7.3). Side-effect free: the
 * client imports the control schemas. The engine's pure rules live in
 * server/modules/inventory-planning/domain/stock-link.ts; every provider read is validated here before the engine
 * trusts it (CLAUDE.md §5).
 */

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const id = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const count = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
/** A bigint revision as text; "0" means "no row yet" (the heads' convention, inventory-channel-exposure-admin.repository.ts). */
const revision = z.string().regex(/^(0|[1-9]\d*)$/).max(20);
const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
/** inventory.stock_link_checks.reason_code / stock_link_destinations.paused_code: varchar(120), trimmed (M1). */
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(120);

/** Card Shellz SKUs and every stored store SKU are at most 100 characters (catalog.schema.ts product_variants.sku,
 * channel_variant_overrides.sku_override, mapping external_sku, check-row observed_sku). */
export const STOCK_LINK_SKU_MAX_LENGTH = 100;
/** A store SKU as read is bounded only so a malformed answer cannot grow without limit; anything over
 * STOCK_LINK_SKU_MAX_LENGTH is "another SKU" and is never stored (TST-12). Shopify's own limit is HYPOTHESIS. */
export const STOCK_LINK_STORE_SKU_READ_MAX_LENGTH = 1_000;
/** A Shopify REST id: what the outbox writes to (shopifyRestId, CH/adapters/shopify.adapter.ts). Never a gid. */
export const STOCK_LINK_DECIMAL_ID_PATTERN = /^[1-9]\d{0,19}$/;
/** SKUs per findItemsBySku call and item ids per observeItems call (§6.1). */
export const STOCK_LINK_LOOKUP_SKUS_MAX = 50;
export const STOCK_LINK_OBSERVE_ITEMS_MAX = 100;
/** productVariants(first: 100), at most 4 pages, else STOCK_LINK_LOOKUP_INCOMPLETE (§6.1). */
export const STOCK_LINK_LOOKUP_ITEMS_MAX = 400;

const decimalId = z.string().regex(STOCK_LINK_DECIMAL_ID_PATTERN);

export const STOCK_LINK_CHECK_STATUSES = ["waiting", "linked", "flagged", "error"] as const;
export const stockLinkCheckStatusSchema = z.enum(STOCK_LINK_CHECK_STATUSES);
export type StockLinkCheckStatus = z.infer<typeof stockLinkCheckStatusSchema>;

/** CLAUDE.md §6's three classes (M1 error_class). Busy is a transient kind that counts no attempt (C13). */
export const STOCK_LINK_ERROR_CLASSES = ["transient", "permanent", "fatal"] as const;
export const stockLinkErrorClassSchema = z.enum(STOCK_LINK_ERROR_CLASSES);
export type StockLinkErrorClass = z.infer<typeof stockLinkErrorClassSchema>;

/**
 * One inventory publication target the engine links for (for Shopify: one connection plus its location,
 * IP/domain/inventory-channel-exposure.ts). Exactly one connection id is set, by kind (as the target table).
 */
export const stockLinkDestinationSchema = z.object({
  publicationTargetId: id,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  /** The transport provider, lower case (shopify, ebay, walmart): the registry key with the kind. */
  providerKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
  channelId: id,
  channelConnectionId: id.nullable(),
  dropshipStoreConnectionId: id.nullable(),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: z.string().trim().min(1).max(240),
  targetRevision: z.string().regex(/^[1-9]\d*$/).max(20),
}).strict().superRefine((value, context) => {
  const channel = value.destinationKind === "channel_connection";
  if (channel ? value.channelConnectionId === null || value.dropshipStoreConnectionId !== null
    : value.dropshipStoreConnectionId === null || value.channelConnectionId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["destinationKind"],
      message: "A stock-link destination names exactly the connection of its kind." });
  }
});
export type StockLinkDestination = z.infer<typeof stockLinkDestinationSchema>;

/**
 * One store item as the store reports it now. `sku` is raw (the engine trims and compares); `productStatus` is the
 * product's status as the store names it (Shopify ACTIVE, ARCHIVED, DRAFT, ...): only the engine decides what is
 * "on sale" (§4.2, C10), so a new status is never on sale by accident.
 */
export const stockLinkStoreItemSchema = z.object({
  itemId: decimalId,
  sku: z.string().max(STOCK_LINK_STORE_SKU_READ_MAX_LENGTH).nullable(),
  productId: decimalId,
  productStatus: z.string().regex(/^[A-Z][A-Z_]*$/).max(40),
}).strict();
export type StockLinkStoreItem = z.infer<typeof stockLinkStoreItemSchema>;

/** What a read is evidence of: when, and the destination's credential fingerprint it was made with (§6.1). */
const readEvidence = { observedAt: instant, readFingerprint: sha256Hex };

/**
 * findItemsBySku: every store item whose SKU exactly equals one of `skus` (the adapter filters client-side), complete
 * or not at all (a short read is STOCK_LINK_LOOKUP_INCOMPLETE, never a partial result).
 */
export const stockLinkSkuLookupSchema = z.object({
  ...readEvidence,
  skus: z.array(z.string().trim().min(1).max(STOCK_LINK_SKU_MAX_LENGTH)).min(1).max(STOCK_LINK_LOOKUP_SKUS_MAX),
  items: z.array(stockLinkStoreItemSchema).max(STOCK_LINK_LOOKUP_ITEMS_MAX),
}).strict().superRefine((value, context) => {
  if (new Set(value.skus).size !== value.skus.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["skus"], message: "Each looked-up SKU appears once." });
  if (new Set(value.items.map(item => item.itemId)).size !== value.items.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["items"], message: "Each store item appears once." });
});
export type StockLinkSkuLookup = z.infer<typeof stockLinkSkuLookupSchema>;

/** observeItems: each asked item by its saved id, never through a search index; `item: null` = it does not exist. */
export const stockLinkItemObservationSchema = z.object({
  ...readEvidence,
  observations: z.array(z.object({
    itemId: decimalId,
    item: stockLinkStoreItemSchema.nullable(),
  }).strict()).min(1).max(STOCK_LINK_OBSERVE_ITEMS_MAX),
}).strict().superRefine((value, context) => {
  if (new Set(value.observations.map(row => row.itemId)).size !== value.observations.length)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["observations"], message: "Each observed item appears once." });
  if (value.observations.some(row => row.item !== null && row.item.itemId !== row.itemId))
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["observations"], message: "An observation names the item it observed." });
});
export type StockLinkItemObservation = z.infer<typeof stockLinkItemObservationSchema>;

/** A failure as a check row records it (M1 reason_code, error_class, message). */
export const stockLinkRecordedFailureSchema = z.object({
  code: reasonCode,
  errorClass: stockLinkErrorClassSchema,
  message: z.string().trim().min(1).max(1_000),
}).strict();
export type StockLinkRecordedFailure = z.infer<typeof stockLinkRecordedFailureSchema>;

// ---------------------------------------------------------------------------
// Channel Inventory controls (§7.3)
// ---------------------------------------------------------------------------

/** Optional audit note: blank normalises to null, never a fabricated reason (same rule as the exposure DTOs). */
const optionalReason = z.string().trim().max(1_000).nullable().optional()
  .transform(value => (value ? value : null));

/** The status route's query: a canonical decimal id only (no exponent, sign or padding). */
export const stockLinkStatusRequestSchema = z.object({
  publicationTargetId: z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(id),
}).strict();

const supportedStatusSchema = z.object({
  supported: z.literal(true),
  publicationTargetId: id,
  autoLinkEnabled: z.boolean(),
  /** The destination row's revision for the next control's `expectedRevision` ("0": no row yet, switch on). */
  revision,
  counts: z.object({ linked: count, waiting: count, flagged: count, error: count }).strict(),
  paused: z.object({ code: reasonCode, since: instant, until: instant }).strict().nullable(),
  halted: z.object({ code: reasonCode, at: instant }).strict().nullable(),
  /** The sizes whose retire the hold keeps right now (Continue releases them); null when none is held. */
  retiresHeld: z.object({ count, limit: count, windowHours: count }).strict().nullable(),
  /**
   * The server's kill switch stops automatic linking for every store (STOCK_LINK_AUTO_DISABLED or DISABLE_SCHEDULERS,
   * §21; review CMP-1). Optional so a server from before it still parses; absent reads as false.
   */
  runnerOff: z.boolean().optional(),
}).strict();

/** `supported: false` for every destination the engine has no policy for; the client hides the controls then. */
export const stockLinkStatusSchema = z.discriminatedUnion("supported", [
  z.object({ supported: z.literal(false), publicationTargetId: id }).strict(),
  supportedStatusSchema,
]);
export type StockLinkStatus = z.infer<typeof stockLinkStatusSchema>;
export type StockLinkSupportedStatus = z.infer<typeof supportedStatusSchema>;

export const stockLinkSwitchRequestSchema = z.object({
  publicationTargetId: id,
  enabled: z.boolean(),
  expectedRevision: revision,
  reason: optionalReason,
}).strict();
export type StockLinkSwitchRequest = z.infer<typeof stockLinkSwitchRequestSchema>;

export const stockLinkContinueRequestSchema = z.object({
  publicationTargetId: id,
  expectedRevision: revision,
}).strict();
export type StockLinkContinueRequest = z.infer<typeof stockLinkContinueRequestSchema>;

export const stockLinkCheckAgainRequestSchema = z.object({
  publicationTargetId: id,
  expectedRevision: revision,
}).strict();
export type StockLinkCheckAgainRequest = z.infer<typeof stockLinkCheckAgainRequestSchema>;

/** Every control answers with the destination's status after its change. */
export const stockLinkControlResultSchema = supportedStatusSchema;
export type StockLinkControlResult = z.infer<typeof stockLinkControlResultSchema>;
