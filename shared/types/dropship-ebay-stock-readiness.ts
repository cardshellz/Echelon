import { z } from "zod";
import { publicationMembershipBlockerSchema } from "./inventory-publication-membership";
import { publicationMappingPreparationReceiptSchema } from "./inventory-publication-mapping-preparation";

/** Contracts of inventory-planning's Dropship eBay stock link (exact SKU mapping on
 * a store's one live Card Shellz stock destination). Dropship calls it only
 * through server/modules/inventory-planning/quantity-publication.ts. */
const id = z.number().int().positive().max(2_147_483_647);
/** Same identity bound as the channel readiness contract (ebay-publication-readiness.ts). */
const identity = z.string().trim().min(1).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Who asked for the link. The origin (never the SKU) keys the command, so a
 * changed SKU under the same job item is a detectable conflict. */
export const dropshipEbayStockOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("listing_push"), jobId: id, jobItemId: id, listingId: id }).strict(),
  z.object({ kind: z.literal("live_listing_enrollment"), listingId: id, evidenceHash: hash }).strict(),
]);

export const dropshipEbayStockReadinessInputSchema = z.object({
  vendorId: id,
  storeConnectionId: id,
  /** Bounded like the destination's external_scope_id (inventory_publication_targets_scope_chk,
   * 1..240) and the quantity scope identifier, so a valid input is always a valid scope. */
  accountId: z.string().trim().min(1).max(240),
  environment: z.enum(["production", "sandbox"]),
  productId: id,
  /** publish = a listing push; sync = enrollment of a retained listing (may link at zero). */
  purpose: z.enum(["publish", "sync"]),
  variants: z.array(z.object({ productVariantId: id, sku: identity }).strict()).min(1).max(500)
    .refine(rows => new Set(rows.map(row => row.productVariantId)).size === rows.length
      && new Set(rows.map(row => row.sku)).size === rows.length, "Each variant and provider SKU must be unique"),
  origin: dropshipEbayStockOriginSchema,
}).strict();

/** The only actors allowed to make an automatic Dropship stock link. */
export const DROPSHIP_EBAY_STOCK_ACTORS = ["system:dropship-listing-push", "system:dropship-stock-enrollment"] as const;
export const dropshipEbayStockActorSchema = z.enum(DROPSHIP_EBAY_STOCK_ACTORS);

const mappingActionSchema = z.object({
  productVariantId: id,
  mappingAction: z.enum(["none", "promote_draft", "create"]),
}).strict();

/** Business outcomes. Concurrency and infrastructure conditions are thrown, never
 * returned. An item-level blocker carries `productVariantId`; a destination- or
 * command-level blocker has `productVariantId: null` (Dropship picks vendor text by it). */
export const dropshipEbayStockReadinessResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_applicable"), reason: z.literal("legacy_authority") }).strict(),
  z.object({
    status: z.literal("ready"),
    commandKey: z.string().uuid(),
    publicationTargetId: id,
    linkedProductVariantIds: z.array(id).min(1),
    alreadyLinked: z.boolean(),
    /** The actions the in-fence capture took (all "none" when already linked). */
    mappingActions: z.array(mappingActionSchema),
    preparation: publicationMappingPreparationReceiptSchema.nullable(),
    /** Wall time the inventory cutover fence was held; null when it was not taken. */
    fenceHoldMs: z.number().finite().nonnegative().nullable(),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    commandKey: z.string().uuid(),
    publicationTargetId: id.nullable(),
    /** Live Card Shellz stock destinations found for the store account. */
    targetCount: z.number().int().nonnegative(),
    blockers: z.array(publicationMembershipBlockerSchema).min(1),
  }).strict(),
]);

/** Read-only store-level view of the stock destination (ops-health and preview). */
export const dropshipEbayStockDestinationSchema = z.object({
  storeConnectionId: id,
  accountId: z.string().min(1),
  status: z.enum(["live", "not_live", "missing", "duplicated", "held", "source_not_ready"]),
  liveTargetCount: z.number().int().nonnegative(),
  publicationTargetId: id.nullable(),
  targetRevision: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  heldAt: z.date().nullable(),
}).strict();

export type DropshipEbayStockOrigin = z.infer<typeof dropshipEbayStockOriginSchema>;
export type DropshipEbayStockReadinessInput = z.infer<typeof dropshipEbayStockReadinessInputSchema>;
export type DropshipEbayStockActor = z.infer<typeof dropshipEbayStockActorSchema>;
export type DropshipEbayStockReadinessResult = z.infer<typeof dropshipEbayStockReadinessResultSchema>;
export type DropshipEbayStockDestination = z.infer<typeof dropshipEbayStockDestinationSchema>;
