import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import {
  channelPricing,
  channelPricingRules,
  products,
  productVariants,
  shopifyVariants,
} from "@shared/schema";

type EchelonDb = typeof db;

export type ChannelPriceSource =
  | "channel_pricing"
  | "retail_cache"
  | "catalog_variant";

export interface ChannelPriceResolution {
  priceCents: number | null;
  basePriceCents: number | null;
  source: ChannelPriceSource | null;
  appliedRule: {
    id: number;
    scope: string;
    scopeId: string | null;
    ruleType: string;
    value: string;
  } | null;
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
  const explicitChannelPrice = await resolveExplicitChannelPrice(dbArg, input.channelId, input.variantId);
  if (explicitChannelPrice !== null) {
    return {
      priceCents: explicitChannelPrice,
      basePriceCents: explicitChannelPrice,
      source: "channel_pricing",
      appliedRule: null,
    };
  }

  const base = await resolveDefaultRetailBasePrice(dbArg, input.variantId, input.fallbackCatalogPriceCents);
  if (base.basePriceCents === null) {
    return {
      priceCents: null,
      basePriceCents: null,
      source: null,
      appliedRule: null,
    };
  }

  const rule = await resolvePricingRule(dbArg, input.channelId, input.productId, input.variantId);
  if (!rule) {
    return {
      priceCents: base.basePriceCents,
      basePriceCents: base.basePriceCents,
      source: base.source,
      appliedRule: null,
    };
  }

  return {
    priceCents: applyPricingRule(base.basePriceCents, rule.ruleType, rule.value),
    basePriceCents: base.basePriceCents,
    source: base.source,
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
  const [row] = await dbArg
    .select({ price: channelPricing.price })
    .from(channelPricing)
    .where(and(
      eq(channelPricing.channelId, channelId),
      eq(channelPricing.productVariantId, variantId),
    ))
    .limit(1);

  return normalizeIntegerCents(row?.price);
}

async function resolveDefaultRetailBasePrice(
  dbArg: EchelonDb,
  variantId: number,
  fallbackCatalogPriceCents: unknown,
): Promise<{ basePriceCents: number | null; source: ChannelPriceSource | null }> {
  const [variant] = await dbArg
    .select({
      id: productVariants.id,
      sku: productVariants.sku,
      shopifyVariantId: productVariants.shopifyVariantId,
      catalogPriceCents: productVariants.priceCents,
    })
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .limit(1);

  const retailCachePrice = variant
    ? await resolveRetailCachePrice(dbArg, variant.shopifyVariantId, variant.sku)
    : null;
  if (retailCachePrice !== null) {
    return { basePriceCents: retailCachePrice, source: "retail_cache" };
  }

  const catalogPrice = normalizeIntegerCents(variant?.catalogPriceCents ?? fallbackCatalogPriceCents);
  if (catalogPrice !== null) {
    return { basePriceCents: catalogPrice, source: "catalog_variant" };
  }

  return { basePriceCents: null, source: null };
}

async function resolveRetailCachePrice(
  dbArg: EchelonDb,
  shopifyVariantId: string | null,
  sku: string | null,
): Promise<number | null> {
  if (shopifyVariantId) {
    const [byId] = await dbArg
      .select({ price: shopifyVariants.price })
      .from(shopifyVariants)
      .where(eq(shopifyVariants.id, shopifyVariantId))
      .limit(1);
    const price = parseDollarPriceToCents(byId?.price);
    if (price !== null) return price;
  }

  if (sku?.trim()) {
    const [bySku] = await dbArg
      .select({ price: shopifyVariants.price })
      .from(shopifyVariants)
      .where(sql`UPPER(${shopifyVariants.sku}) = ${sku.trim().toUpperCase()}`)
      .limit(1);
    const price = parseDollarPriceToCents(bySku?.price);
    if (price !== null) return price;
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
  if (variantRule.length > 0) return variantRule[0];

  const productRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "product"),
        eq(channelPricingRules.scopeId, String(productId)),
      ),
    );
  if (productRule.length > 0) return productRule[0];

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
    if (categoryRule.length > 0) return categoryRule[0];
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
  return channelRule[0] ?? null;
}

export function applyPricingRule(basePriceCents: number, ruleType: string, value: string | number): number {
  switch (ruleType) {
    case "percentage": {
      const basisPoints = parsePercentageToBasisPoints(value);
      if (basisPoints === null) {
        throw new Error(`Invalid channel pricing percentage value: ${value}`);
      }
      return Math.round((basePriceCents * (10_000 + basisPoints)) / 10_000);
    }
    case "fixed": {
      const fixedDeltaCents = parseDollarPriceToCents(value);
      if (fixedDeltaCents === null) {
        throw new Error(`Invalid channel pricing fixed value: ${value}`);
      }
      return basePriceCents + fixedDeltaCents;
    }
    case "override": {
      const overrideCents = parseDollarPriceToCents(value);
      if (overrideCents === null) {
        throw new Error(`Invalid channel pricing override value: ${value}`);
      }
      return overrideCents;
    }
    default:
      return basePriceCents;
  }
}

function parsePercentageToBasisPoints(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;

  const [wholeRaw, fractionalRaw = ""] = raw.split(".");
  const basisPoints = BigInt(wholeRaw) * BigInt(100) + BigInt((fractionalRaw + "00").slice(0, 2));
  return basisPoints <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(basisPoints) : null;
}
