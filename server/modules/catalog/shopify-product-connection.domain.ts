import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson } from "@shared/utils/canonical-json";
import { SHOPIFY_PRODUCT_VARIANT_LIMIT, type ShopifyProductConnectionRequest } from "@shared/catalog/shopify-product-connection";
import type { ShopifyProductMappingSummary, VerifiedShopifyVariantIdentity } from "./shopify-product-mapping.domain";

export class ShopifyProductConnectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 409,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ShopifyProductConnectionError";
  }
}

export interface ShopifyConnectionSource {
  product: {
    id: number;
    sku: string | null;
    name: string;
    title: string | null;
    description: string | null;
    vendor: string | null;
    productType: string | null;
    tags: string[];
    isActive: boolean;
    trackInventory: boolean;
  };
  variants: Array<{
    id: number;
    sku: string | null;
    name: string;
    barcode: string | null;
    isActive: boolean;
    salesEligibility: "sellable" | "internal_only";
    requiresShipping: boolean;
    trackInventory: boolean;
    priceCents: number | null;
    compareAtPriceCents: number | null;
    priceCurrency?: string | null;
    channelPrice?: { price: string; compareAtPrice: string | null; currency: string } | null;
  }>;
  images: Array<{ url: string; alt: string | null }>;
  mapping: ShopifyProductMappingSummary;
  channel: { id: number; name: string; shopDomain: string; connectionId: number; apiVersion: string };
}

export interface ShopifyConnectionRemoteProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  ownership: string | null;
  variants: Array<VerifiedShopifyVariantIdentity & {
    title: string;
    priceCents: number;
    optionValue: string;
    localVariantId: number | null;
    ownership?: string | null;
    requiresShipping?: boolean;
    trackInventory?: boolean;
    inventoryQuantity?: number;
    compareAtPriceCents?: number | null;
  }>;
}

export interface ShopifyConnectionCreateSpec {
  title: string;
  descriptionHtml: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  images: Array<{ url: string; alt: string | null }>;
  variants: Array<{
    localVariantId: number | null;
    sku: string | null;
    name: string;
    optionValue: string;
    barcode: string | null;
    requiresShipping: boolean;
    trackInventory: boolean;
    priceCents: number;
    compareAtPriceCents: number | null;
  }>;
}

export interface ShopifyConnectionReviewEvidence {
  remoteProductId: string | null;
  remoteFingerprint: string | null;
  bindings: Array<{ variantId: number; remoteVariantId: string }>;
}

export function resolveShopifyConnectionPrice(input: {
  primaryStore: boolean;
  catalogPrice: number | null;
  catalogCompareAtPrice: number | null;
  channelPrice: number | null;
  channelCompareAtPrice: number | null;
}): { priceCents: number | null; compareAtPriceCents: number | null } {
  if (input.channelPrice !== null) return { priceCents: input.channelPrice, compareAtPriceCents: input.channelCompareAtPrice };
  // Catalog prices are the primary-store compatibility values. Another store
  // needs its own price; amounts are never treated as an implicit FX conversion.
  return input.primaryStore ? { priceCents: input.catalogPrice, compareAtPriceCents: input.catalogCompareAtPrice }
    : { priceCents: null, compareAtPriceCents: null };
}

export function connectionFingerprint(value: unknown): string {
  // PostgreSQL jsonb reorders keys. Receipts and preview fingerprints must not
  // depend on insertion order or an operator's locale.
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseShopifyProductReference(value: string, shopDomain: string): string {
  const text = value.trim();
  if (/^[1-9][0-9]{0,29}$/.test(text)) return text;
  const gid = /^gid:\/\/shopify\/Product\/([1-9][0-9]{0,29})$/.exec(text);
  if (gid) return gid[1];
  try {
    const url = new URL(text);
    const store = shopDomain.replace(/\.myshopify\.com$/, "");
    const classic = url.hostname === shopDomain ? /^\/admin\/products\/([1-9][0-9]*)\/?$/.exec(url.pathname) : null;
    const modern = url.hostname === "admin.shopify.com"
      ? new RegExp(`^/store/${store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/products/([1-9][0-9]*)/?$`).exec(url.pathname)
      : null;
    if (url.protocol === "https:" && !url.username && !url.password && (classic || modern)) {
      return (classic || modern)![1];
    }
  } catch { /* A malformed URL is a validation error, never a request target. */ }
  throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_REFERENCE_INVALID", "Enter a product ID or an admin product URL for the selected Shopify store.", 400);
}

export function eligibleConnectionVariants(source: ShopifyConnectionSource) {
  return source.variants.filter(variant => variant.isActive && variant.salesEligibility === "sellable")
    .sort((left, right) => left.id - right.id);
}

export function assertProductConnectionAllowed(source: ShopifyConnectionSource): void {
  if (!source.product.isActive) {
    throw new ShopifyProductConnectionError("PRODUCT_INACTIVE", "Activate this catalog product before connecting it to Shopify.");
  }
  if (source.variants.length > 0 && eligibleConnectionVariants(source).length === 0) {
    throw new ShopifyProductConnectionError("NO_SELLABLE_VARIANTS", "This product has no active customer-sellable variants. Archived and internal-only variants are excluded.");
  }
  if (source.mapping.status === "conflict" || source.mapping.status === "mismatch") {
    throw new ShopifyProductConnectionError("SHOPIFY_MAPPING_REVIEW_REQUIRED", "Resolve the conflicting Shopify identities shown on this product before connecting it.");
  }
}

export function buildShopifyConnectionCreateSpec(
  source: ShopifyConnectionSource,
  request: ShopifyProductConnectionRequest,
): ShopifyConnectionCreateSpec {
  assertProductConnectionAllowed(source);
  if (source.mapping.catalogProductId || source.mapping.evidenceProductIds.length > 0) {
    throw new ShopifyProductConnectionError("SHOPIFY_PRODUCT_ALREADY_CONNECTED", "This product already has a Shopify identity in this channel. Use the existing connection.");
  }
  const title = (source.product.title || source.product.name).trim();
  if (!title || title.length > 255) {
    throw new ShopifyProductConnectionError("SHOPIFY_TITLE_INVALID", "The catalog product needs a title of 1 to 255 characters.", 400);
  }
  if (source.product.tags.length > 249 || source.product.tags.some(tag => !tag.trim() || tag.length > 255)) {
    throw new ShopifyProductConnectionError("SHOPIFY_TAGS_INVALID", "Use at most 249 nonempty catalog tags, each no longer than 255 characters.", 422);
  }
  const active = eligibleConnectionVariants(source);
  const seenImages = new Set<string>();
  const images = source.images.filter(image => {
    if (seenImages.has(image.url)) return false;
    seenImages.add(image.url); return true;
  });
  for (const image of source.images) {
    let url: URL;
    try { url = new URL(image.url); }
    catch { throw new ShopifyProductConnectionError("CATALOG_IMAGE_INVALID", "A catalog image has an invalid publication URL.", 422); }
    if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname)
      || !url.hostname.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)\.?$/i.test(url.hostname)) {
      throw new ShopifyProductConnectionError("CATALOG_IMAGE_INVALID", "Catalog images need public HTTPS addresses without embedded credentials.", 422);
    }
  }
  if (source.images.length > 250) throw new ShopifyProductConnectionError("SHOPIFY_MEDIA_LIMIT", "Select at most 250 catalog photos before creating a Shopify product.", 422);
  const variants = active.length > 0 ? active.map(variant => ({ ...variant, localVariantId: variant.id })) : [{
    localVariantId: null, sku: source.product.sku, name: "Default Title", barcode: null,
    // A product without warehouse variants has no saved shipping flag. The
    // operator reviews this explicit choice; non-inventory does not mean digital.
    requiresShipping: request.productOnlyRequiresShipping,
    trackInventory: request.productOnlyRequiresShipping && source.product.trackInventory,
    priceCents: null, compareAtPriceCents: null,
  }];
  if (variants.length > SHOPIFY_PRODUCT_VARIANT_LIMIT) throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_LIMIT", "Shopify supports at most 2,048 variants per product.", 400);
  const prices = new Map(request.prices.map(price => [price.variantId, price]));
  if (request.prices.some(price => !variants.some(variant => variant.localVariantId === price.variantId))) {
    throw new ShopifyProductConnectionError("PRICE_VARIANT_NOT_SELECTED", "Prices must refer only to this product's selected sellable variants.", 400);
  }
  const names = variants.map(variant => variant.name.trim() || variant.sku?.trim() || "Variant");
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  const options = names.map((name, index) => counts.get(name)! > 1 ? `${name} (${variants[index].sku || variants[index].localVariantId})` : name);
  if (new Set(options).size !== options.length) {
    throw new ShopifyProductConnectionError("SHOPIFY_OPTIONS_AMBIGUOUS", "Give sellable variants distinct names or SKUs before creating their Shopify options.", 422);
  }
  return {
    title, descriptionHtml: source.product.description, vendor: source.product.vendor,
    productType: source.product.productType, tags: [...source.product.tags], images,
    variants: variants.map((variant, index) => {
      const price = prices.get(variant.localVariantId);
      if (!price && "priceCurrency" in variant && variant.priceCurrency !== request.currency) {
        throw new ShopifyProductConnectionError("SHOPIFY_PRICE_CURRENCY_REQUIRED", `Enter an explicit ${request.currency} price for ${variant.sku || variant.name}. Saved prices use another currency.`, 400);
      }
      const priceCents = price?.priceCents ?? variant.priceCents;
      const compareAtPriceCents = price?.compareAtPriceCents === undefined ? variant.compareAtPriceCents : price.compareAtPriceCents;
      if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0) {
        throw new ShopifyProductConnectionError("SHOPIFY_PRICE_REQUIRED", `Enter a price for ${variant.sku || variant.name}.`, 400);
      }
      if (compareAtPriceCents !== null && (!Number.isSafeInteger(compareAtPriceCents) || compareAtPriceCents < priceCents)) {
        throw new ShopifyProductConnectionError("SHOPIFY_COMPARE_PRICE_INVALID", "A compare-at price must be at least the selling price.", 400);
      }
      const optionValue = options[index];
      if (optionValue.length > 255) throw new ShopifyProductConnectionError("SHOPIFY_OPTION_TOO_LONG", "A variant name is longer than Shopify's 255-character limit.", 400);
      return { ...variant, optionValue, priceCents, compareAtPriceCents };
    }),
  };
}

export function resolveConnectionBindings(
  source: ShopifyConnectionSource,
  remote: ShopifyConnectionRemoteProduct,
  explicit: ShopifyProductConnectionRequest["bindings"],
): Array<{ variantId: number; remoteVariantId: string }> {
  assertProductConnectionAllowed(source);
  const active = eligibleConnectionVariants(source);
  if (explicit.some(binding => !active.some(variant => variant.id === binding.variantId))) {
    throw new ShopifyProductConnectionError("SHOPIFY_BINDING_NOT_SELECTED", "A selected mapping refers to an archived, internal-only, or unrelated catalog variant.", 400);
  }
  const used = new Set<string>();
  return active.map(variant => {
    const chosen = explicit.find(binding => binding.variantId === variant.id);
    const localSku = variant.sku?.trim().toUpperCase();
    const candidates = chosen
      ? remote.variants.filter(candidate => candidate.id === chosen.remoteVariantId)
      : remote.variants.filter(candidate => localSku && candidate.sku?.trim().toUpperCase() === localSku);
    if (candidates.length !== 1 || used.has(candidates[0].id)) {
      throw new ShopifyProductConnectionError("SHOPIFY_VARIANT_SELECTION_REQUIRED", `Select one distinct Shopify variant for ${variant.sku || variant.name}.`);
    }
    used.add(candidates[0].id);
    return { variantId: variant.id, remoteVariantId: candidates[0].id };
  });
}
