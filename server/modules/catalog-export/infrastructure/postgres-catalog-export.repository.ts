import { asc, eq, gt, inArray } from "drizzle-orm";
import {
  channelConnections,
  channelFeeds,
  channels,
  productVariants,
  products,
} from "@shared/schema";
import { db } from "../../../db";
import type { CatalogExportRepository } from "../application/catalog-export.service";
import type { CatalogExternalIdentifier } from "../domain/catalog-export";

export class PostgresCatalogExportRepository implements CatalogExportRepository {
  constructor(private readonly database: typeof db = db) {}

  async listVariantSnapshots(input: {
    afterVariantId: number | null;
    limit: number;
  }) {
    const variants = await this.database.select({
      variantId: productVariants.id,
      productId: products.id,
      variantName: productVariants.name,
      productName: products.name,
      variantSku: productVariants.sku,
      productSku: products.sku,
      gtin: productVariants.gtin,
      barcode: productVariants.barcode,
      mpn: productVariants.mpn,
      brand: products.brand,
      baseUnit: products.baseUnit,
      inventoryType: products.inventoryType,
      productStatus: products.status,
      productIsActive: products.isActive,
      variantIsActive: productVariants.isActive,
      productUpdatedAt: products.updatedAt,
      variantUpdatedAt: productVariants.updatedAt,
    })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(input.afterVariantId === null
        ? undefined
        : gt(productVariants.id, input.afterVariantId))
      .orderBy(asc(productVariants.id))
      .limit(input.limit);

    const variantIds = variants.map((variant) => variant.variantId);
    if (variantIds.length === 0) return [];
    const mappings = await this.database.select({
      variantId: channelFeeds.productVariantId,
      provider: channels.provider,
      channelId: channels.id,
      shopDomain: channelConnections.shopDomain,
      externalVariantId: channelFeeds.channelVariantId,
      externalProductId: channelFeeds.channelProductId,
      channelSku: channelFeeds.channelSku,
    })
      .from(channelFeeds)
      .innerJoin(channels, eq(channels.id, channelFeeds.channelId))
      .leftJoin(channelConnections, eq(channelConnections.channelId, channels.id))
      // Channel-feed activation controls future operational synchronization. It
      // does not invalidate the provider identity previously assigned to this
      // canonical variant. Accounting consumers need that historical identity
      // to resolve retained sales and refunds after a listing is deactivated.
      .where(inArray(channelFeeds.productVariantId, variantIds))
      .orderBy(asc(channelFeeds.productVariantId), asc(channels.id));

    const identifiersByVariant = new Map<number, CatalogExternalIdentifier[]>();
    const seen = new Set<string>();
    for (const mapping of mappings) {
      const provider = mapping.provider.trim().toLowerCase();
      const scope = mapping.shopDomain?.trim().toLowerCase() || `channel:${mapping.channelId}`;
      const candidates: CatalogExternalIdentifier[] = [
        {
          provider,
          scope,
          identifierType: "variant_id",
          value: mapping.externalVariantId.trim(),
        },
      ];
      if (mapping.externalProductId?.trim()) candidates.push({
        provider,
        scope,
        identifierType: "product_id",
        value: mapping.externalProductId.trim(),
      });
      if (mapping.channelSku?.trim()) candidates.push({
        provider,
        scope,
        identifierType: "sku",
        value: mapping.channelSku.trim(),
      });
      for (const identifier of candidates) {
        const key = [mapping.variantId, identifier.provider, identifier.scope,
          identifier.identifierType, identifier.value].join("\u0000");
        if (seen.has(key)) continue;
        seen.add(key);
        const values = identifiersByVariant.get(mapping.variantId) ?? [];
        values.push(identifier);
        identifiersByVariant.set(mapping.variantId, values);
      }
    }

    return variants.map((variant) => ({
      ...variant,
      externalIdentifiers: identifiersByVariant.get(variant.variantId) ?? [],
    }));
  }
}
