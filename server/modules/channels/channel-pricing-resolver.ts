import { z } from "zod";
import type { ChannelPriceProvenance } from "@shared/types/channel-listing-price";
import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import {
  channelPricing,
  channelPricingRules,
  products,
  productVariants,
  shopifyVariants,
} from "@shared/schema";

type EchelonDb = Pick<typeof db, "select">;

export type ChannelPriceSource =
  | "channel_pricing"
  | "retail_cache"
  | "catalog_variant";

export interface ChannelPriceResolution {
  priceCents: number | null;
  basePriceCents: number | null;
  source: ChannelPriceSource | null;
  provenance: ChannelPriceProvenance | null;
  appliedRule: {
    id: number;
    scope: string;
    scopeId: string | null;
    ruleType: string;
    value: string;
  } | null;
}

export class ChannelPricingResolutionError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown>) {
    super(message);
    this.name = "ChannelPricingResolutionError";
  }
}

interface ResolveChannelListingPriceInput {
  channelId: number;
  productId: number;
  variantId: number;
  fallbackCatalogPriceCents?: unknown;
}

export function normalizeIntegerCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === "bigint") {
    return value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }

  return null;
}

export function parseDollarPriceToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;

  const [dollarsRaw, centsRaw = ""] = raw.split(".");
  const dollars = BigInt(dollarsRaw);
  const cents = BigInt((centsRaw + "00").slice(0, 2));
  const total = dollars * BigInt(100) + cents;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

export async function resolveChannelListingPrice(
  dbArg: EchelonDb,
  input: ResolveChannelListingPriceInput,
): Promise<ChannelPriceResolution> {
  const id = z.number().int().positive().max(2_147_483_647);
  z.object({ channelId: id, productId: id, variantId: id }).parse(input);
  const explicitChannelPrice = await resolveExplicitChannelPrice(dbArg, input.channelId, input.variantId);
  if (explicitChannelPrice !== null) {
    return {
      priceCents: explicitChannelPrice,
      basePriceCents: explicitChannelPrice,
      source: "channel_pricing",
      provenance: { kind: "channel_price", channelId: input.channelId, variantId: input.variantId },
      appliedRule: null,
    };
  }

  const base = await resolveDefaultRetailBasePrice(dbArg, input.variantId, input.fallbackCatalogPriceCents);
  if (base.basePriceCents === null) {
    return {
      priceCents: null,
      basePriceCents: null,
      source: null,
      provenance: null,
      appliedRule: null,
    };
  }

  const rule = await resolvePricingRule(dbArg, input.channelId, input.productId, input.variantId);
  if (!rule) {
    return {
      priceCents: base.basePriceCents,
      basePriceCents: base.basePriceCents,
      source: base.source,
      provenance: base.provenance,
      appliedRule: null,
    };
  }

  return {
    priceCents: applyPricingRule(base.basePriceCents, rule.ruleType, rule.value),
    basePriceCents: base.basePriceCents,
    source: base.source,
    provenance: base.provenance,
    appliedRule: {
      id: rule.id,
      scope: rule.scope,
      scopeId: rule.scopeId,
      ruleType: rule.ruleType,
      value: rule.value,
    },
  };
}

async function resolveExplicitChannelPrice(
  dbArg: EchelonDb,
  channelId: number,
  variantId: number,
): Promise<number | null> {
  const rows = await dbArg.select({ price: channelPricing.price }).from(channelPricing)
    .where(and(eq(channelPricing.channelId, channelId), eq(channelPricing.productVariantId, variantId))).limit(2);
  if (rows.length > 1) throw new ChannelPricingResolutionError("CHANNEL_PRICE_AMBIGUOUS",
    "More than one explicit price exists for this channel variant. Resolve the conflicting prices before publishing.", { channelId, variantId });
  if (!rows.length) return null;
  const price = normalizeIntegerCents(rows[0].price);
  if (price === null) throw new ChannelPricingResolutionError("CHANNEL_PRICE_INVALID",
    "The saved channel price is not valid integer cents. Correct it before publishing.", { channelId, variantId });
  return price;
}

type BasePrice = Pick<ChannelPriceResolution, "basePriceCents" | "source" | "provenance">;

async function resolveDefaultRetailBasePrice(
  dbArg: EchelonDb,
  variantId: number,
  fallbackCatalogPriceCents: unknown,
): Promise<BasePrice> {
  const [variant] = await dbArg.select({
    id: productVariants.id, sku: productVariants.sku,
    shopifyVariantId: productVariants.shopifyVariantId,
    catalogPriceCents: productVariants.priceCents,
  }).from(productVariants).where(eq(productVariants.id, variantId)).limit(1);
  const retail = variant ? await resolveRetailCachePrice(dbArg, variantId, variant.shopifyVariantId, variant.sku) : null;
  if (retail !== null) return { basePriceCents: retail.priceCents, source: "retail_cache", provenance: retail.provenance };

  const rawCatalogPrice = variant?.catalogPriceCents ?? fallbackCatalogPriceCents;
  const catalogPrice = normalizeIntegerCents(rawCatalogPrice);
  if (catalogPrice !== null) return { basePriceCents: catalogPrice, source: "catalog_variant",
    provenance: { kind: "catalog_variant", variantId } };
  if (rawCatalogPrice !== null && rawCatalogPrice !== undefined && rawCatalogPrice !== "")
    throw new ChannelPricingResolutionError("CATALOG_PRICE_INVALID", "The Catalog price is not valid integer cents.", { variantId });
  return { basePriceCents: null, source: null, provenance: null };
}

async function resolveRetailCachePrice(
  dbArg: EchelonDb,
  variantId: number,
  shopifyVariantId: string | null,
  sku: string | null,
): Promise<{ priceCents: number; provenance: ChannelPriceProvenance } | null> {
  const read = (row: { id: string; price: unknown } | undefined,
    selection: "catalog_retail_link" | "unique_retail_sku") => {
    if (!row || row.price === null || row.price === undefined || row.price === "") return null;
    const priceCents = parseDollarPriceToCents(row.price);
    if (priceCents === null) throw new ChannelPricingResolutionError("RETAIL_PRICE_INVALID",
      "The selected retail source has an invalid price. Correct that price before publishing.", { variantId, retailVariantId: row.id });
    if (!row.id?.trim()) throw new ChannelPricingResolutionError("RETAIL_PRICE_IDENTITY_MISSING",
      "The retail price has no exact source identity.", { variantId });
    return { priceCents, provenance: { kind: "retail_cache" as const, variantId, retailVariantId: row.id, selection } };
  };
  if (shopifyVariantId) {
    const [byId] = await dbArg.select({ id: shopifyVariants.id, price: shopifyVariants.price })
      .from(shopifyVariants).where(eq(shopifyVariants.id, shopifyVariantId)).limit(1);
    const exact = read(byId, "catalog_retail_link");
    if (exact !== null) return exact;
  }
  if (sku?.trim()) {
    // The legacy cache has no store key. A SKU is only an unambiguous fallback,
    // never permission to select whichever store's row the database returns first.
    const matches = await dbArg.select({ id: shopifyVariants.id, price: shopifyVariants.price })
      .from(shopifyVariants).where(sql`UPPER(${shopifyVariants.sku}) = ${sku.trim().toUpperCase()}`).limit(2);
    if (matches.length > 1) throw new ChannelPricingResolutionError("RETAIL_PRICE_SOURCE_REQUIRED",
      "Multiple retail variants match this SKU. Set the exact Shopify variant link in Catalog or an explicit channel price before publishing.",
      { variantId, sku, candidateRetailVariantIds: matches.map(row => row.id) });
    return read(matches[0], "unique_retail_sku");
  }
  return null;
}

async function resolvePricingRule(
  dbArg: EchelonDb,
  channelId: number,
  productId: number,
  variantId: number,
) {
  const variantRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "variant"),
        eq(channelPricingRules.scopeId, String(variantId)),
      ),
    );
  if (variantRule.length > 0) return uniqueRule(variantRule, inputScope("variant", String(variantId)));

  const productRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "product"),
        eq(channelPricingRules.scopeId, String(productId)),
      ),
    );
  if (productRule.length > 0) return uniqueRule(productRule, inputScope("product", String(productId)));

  const productInfo = await dbArg.select({ productType: products.productType })
    .from(products)
    .where(eq(products.id, productId));

  if (productInfo.length > 0 && productInfo[0].productType) {
    const categoryRule = await dbArg.select()
      .from(channelPricingRules)
      .where(
        and(
          eq(channelPricingRules.channelId, channelId),
          eq(channelPricingRules.scope, "category"),
          eq(channelPricingRules.scopeId, productInfo[0].productType),
        ),
      );
    if (categoryRule.length > 0) return uniqueRule(categoryRule, inputScope("category", productInfo[0].productType));
  }

  const channelRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "channel"),
        sql`${channelPricingRules.scopeId} IS NULL`,
      ),
    );
  return uniqueRule(channelRule, inputScope("channel", null));

  function inputScope(scope: string, scopeId: string | null) { return { channelId, scope, scopeId }; }
}

function uniqueRule<T>(rows: T[], context: { channelId: number; scope: string; scopeId: string | null }): T | null {
  if (rows.length > 1) throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_AMBIGUOUS",
    "Multiple pricing rules exist at the same scope. Resolve the conflicting rules before publishing.", context);
  return rows[0] ?? null;
}

export function applyPricingRule(basePriceCents: number, ruleType: string, value: string | number): number {
  if (normalizeIntegerCents(basePriceCents) === null) throw new Error("Channel base price must be nonnegative safe integer cents");
  switch (ruleType) {
    case "percentage": {
      const basisPoints = parsePercentageToBasisPoints(value);
      if (basisPoints === null) {
        throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_INVALID", "The saved percentage pricing rule is invalid. Correct it before publishing.", { ruleType });
      }
      // Integer half-up rounding preserves cents even when the intermediate
      // product exceeds JavaScript's exact Number range.
      const numerator = BigInt(basePriceCents) * (BigInt(10_000) + BigInt(basisPoints));
      return checkedCents((numerator + BigInt(5_000)) / BigInt(10_000));
    }
    case "fixed": {
      const fixedDeltaCents = parseDollarPriceToCents(value);
      if (fixedDeltaCents === null) {
        throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_INVALID", "The saved fixed pricing rule is invalid. Correct it before publishing.", { ruleType });
      }
      return checkedCents(BigInt(basePriceCents) + BigInt(fixedDeltaCents));
    }
    case "override": {
      const overrideCents = parseDollarPriceToCents(value);
      if (overrideCents === null) {
        throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_INVALID", "The saved override pricing rule is invalid. Correct it before publishing.", { ruleType });
      }
      return overrideCents;
    }
    default:
      throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_INVALID", "The saved pricing rule type is unsupported.", { ruleType });
  }
}

function checkedCents(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChannelPricingResolutionError("CHANNEL_PRICING_RULE_INVALID", "Channel selling price exceeds safe integer cents. Correct the pricing rule before publishing.", {});
  return Number(value);
}

function parsePercentageToBasisPoints(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;

  const [wholeRaw, fractionalRaw = ""] = raw.split(".");
  const basisPoints = BigInt(wholeRaw) * BigInt(100) + BigInt((fractionalRaw + "00").slice(0, 2));
  return basisPoints <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(basisPoints) : null;
}
