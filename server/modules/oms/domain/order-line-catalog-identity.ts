import { z } from "zod";

const optionalReference = z.string().trim().max(100).regex(/^[^\u0000-\u001f\u007f]*$/).nullish();
export const orderLineIdentityInputSchema = z.object({
  channelId: z.number().int().positive().safe(),
  externalVariantId: optionalReference,
  externalProductId: optionalReference,
  sku: optionalReference,
  previousVariantId: z.number().int().positive().safe().nullish(),
});
export type OrderLineIdentityInput = z.input<typeof orderLineIdentityInputSchema>;
export const catalogIdentityCandidateSchema = z.object({
  id: z.number().int().positive().safe(),
  sku: z.string().max(100).regex(/^[^\u0000-\u001f\u007f]*$/).nullable(),
  isActive: z.boolean(),
  compareAtPriceCents: z.number().int().safe().nullable(),
});
export type CatalogIdentityCandidate = z.infer<typeof catalogIdentityCandidateSchema>;
export const channelIdentityCandidateSchema = catalogIdentityCandidateSchema.extend({
  externalProductId: z.string().nullable(),
});
export type ChannelIdentityCandidate = z.infer<typeof channelIdentityCandidateSchema>;
export type ResolvedOrderLineIdentity = CatalogIdentityCandidate & { matchedBy: "channel_variant_id" | "sku" };

export class OrderLineIdentityError extends Error {
  readonly classification = "manual_review";
  constructor(readonly code: string, message: string, readonly context: Readonly<{ channelId?: number; variantId?: number }>) {
    // The existing webhook inbox persists Error.message, so retain the machine-readable code there too.
    super(`${code}: ${message}`);
    this.name = "OrderLineIdentityError";
  }
}

/** Pure decision: external identities are already scoped to this channel by the repository. */
export function selectOrderLineCatalogIdentity(
  rawInput: OrderLineIdentityInput,
  channelCandidates: readonly ChannelIdentityCandidate[],
  skuCandidates: readonly CatalogIdentityCandidate[],
): ResolvedOrderLineIdentity | null {
  const parsed = orderLineIdentityInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new OrderLineIdentityError("ORDER_LINE_IDENTITY_INVALID", "Order line identity is malformed", { channelId: rawInput.channelId });
  const input = parsed.data;
  const fail = (code: string, message: string): never => {
    throw new OrderLineIdentityError(code, message, { channelId: input.channelId });
  };
  const parsedChannel = z.array(channelIdentityCandidateSchema).safeParse(channelCandidates);
  const parsedSku = z.array(catalogIdentityCandidateSchema).safeParse(skuCandidates);
  if (!parsedChannel.success || !parsedSku.success) {
    throw new OrderLineIdentityError("ORDER_LINE_CATALOG_EVIDENCE_INVALID", "Catalog identity evidence is malformed", { channelId: input.channelId });
  }
  const channel = parsedChannel.data;
  const bySku = parsedSku.data;
  if (channel.length > 1 || bySku.length > 1) {
    fail("ORDER_LINE_IDENTITY_AMBIGUOUS", "Order line identity matches multiple catalog variants");
  }
  const external = channel[0];
  const sku = bySku[0];
  const selectedId = external?.id ?? sku?.id;
  if (input.previousVariantId != null && selectedId !== undefined && input.previousVariantId !== selectedId) {
    fail("ORDER_LINE_IDENTITY_CHANGE_REQUIRES_REVIEW", "Source identity would replace the catalog identity of an existing order line");
  }
  if (external) {
    if (!input.externalVariantId) fail("ORDER_LINE_IDENTITY_INVALID", "Channel candidate requires an external variant identity");
    if (input.externalProductId && external.externalProductId && input.externalProductId !== external.externalProductId) {
      fail("ORDER_LINE_PRODUCT_IDENTITY_CONFLICT", "Channel variant and source product identities disagree");
    }
    if (sku && sku.id !== external.id) fail("ORDER_LINE_IDENTITY_CONFLICT", "Source SKU and channel variant identify different catalog items");
    if (!external.isActive && input.previousVariantId !== external.id) {
      fail("ORDER_LINE_VARIANT_INACTIVE", "Channel variant is linked to an inactive catalog item");
    }
    return { id: external.id, sku: external.sku, isActive: external.isActive,
      compareAtPriceCents: external.compareAtPriceCents, matchedBy: "channel_variant_id" };
  }
  // Historical bound identities may be inactive; new SKU-only assignments require an active catalog item.
  // Never fall back to an unscoped provider ID or a title.
  return sku?.isActive ? { ...sku, matchedBy: "sku" } : null;
}

/** Source SKU remains on OMS; WMS uses the catalog snapshot when an identity is resolved. */
export function selectWmsCatalogSku(sourceSku: string | null, catalogSku: string | null): string {
  return catalogSku?.trim() || sourceSku?.trim() || "UNKNOWN";
}

export function normalizeShopifyLineVariantId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ShopifyLineVariantIdentityError("Expected a lossless positive identity");
  }
  if (typeof value !== "number" && typeof value !== "string") throw new ShopifyLineVariantIdentityError("Invalid type");
  const text = String(value).trim().replace(/^gid:\/\/shopify\/ProductVariant\//, "");
  if (!/^[1-9][0-9]{0,99}$/.test(text)) throw new ShopifyLineVariantIdentityError("Invalid identity");
  return text;
}

class ShopifyLineVariantIdentityError extends Error {
  readonly code = "SHOPIFY_LINE_VARIANT_ID_INVALID";
  readonly classification = "manual_review";
  constructor(reason: string) { super(`SHOPIFY_LINE_VARIANT_ID_INVALID: ${reason}`); this.name = "ShopifyLineVariantIdentityError"; }
}
