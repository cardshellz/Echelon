import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import {
  channelConnections,
  channelFeeds,
  channelListings,
  channels,
  products,
  productVariants,
  shippingGroups,
} from "@shared/schema";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import {
  buildShopifyProductMappingSummary,
  normalizeShopifyId,
  type ShopifyProductMappingSummary,
  type ShopifyProductMappingSource,
} from "./shopify-product-mapping.domain";
import {
  normalizeShopifyAdminDomain,
  normalizeShopifyProductReference,
  type ShopifyMappingLocalProduct,
} from "./shopify-product-mapping-reconciliation.domain";
import {
  type ShopifyMappingCredentials,
} from "./shopify-product-mapping-verifier";

const DEFAULT_SHOPIFY_API_VERSION = "2024-01";
const RETIRED_MAPPING_SYNC_ERROR =
  "Shopify mapping retired after the remote product and referenced variants were verified missing.";

type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionClient = Parameters<TransactionCallback>[0];
type QueryClient = typeof db | TransactionClient;

export interface LoadedLocalProduct {
  local: ShopifyMappingLocalProduct;
  summary: ShopifyProductMappingSummary;
}

export interface ShopifyMappingChannelContext {
  channel: {
    id: number;
    name: string;
    shopDomain: string;
  };
  credentials: ShopifyMappingCredentials;
}

export interface RetireStaleShopifyMappingResult {
  productId: number;
  retiredShopifyProductId: string;
  disabledFeedCount: number;
  resetListingCount: number;
  clearedVariantCount: number;
  afterStatus: ShopifyProductMappingSummary["status"];
}

export class ShopifyMappingReconciliationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShopifyMappingReconciliationError";
  }
}

export interface ShopifyProductMappingReconciliationRepository {
  loadChannelContext(channelId: number): Promise<ShopifyMappingChannelContext>;
  listMappedProducts(channelId: number): Promise<LoadedLocalProduct[]>;
  loadMappedProduct(
    productId: number,
    channelId: number,
  ): Promise<LoadedLocalProduct | null>;
  retireStaleMapping(input: {
    productId: number;
    channelId: number;
    expectedProductId: string;
    expectedFingerprint: string;
    actor: string;
    verifiedMissingVariantIds: string[];
    now: Date;
  }): Promise<RetireStaleShopifyMappingResult>;
}

export function collectAllMappedShopifyVariantIds(
  summary: ShopifyProductMappingSummary,
): string[] {
  return [...new Set(summary.variants.flatMap((variant) => [
    variant.catalogVariantId,
    variant.feedVariantId,
    variant.listingVariantId,
  ].map(normalizeShopifyId).filter((id): id is string => id !== null)))]
    .sort((left, right) =>
      left.localeCompare(right, "en", { numeric: true }));
}

function variantAuditSnapshot(summary: ShopifyProductMappingSummary) {
  return summary.variants.map((variant) => ({
    variantId: variant.variantId,
    sku: variant.sku,
    isActive: variant.isActive,
    catalogVariantId: variant.catalogVariantId,
    catalogInventoryItemId: variant.catalogInventoryItemId,
    feedId: variant.feedId,
    feedIsActive: variant.feedIsActive,
    feedProductId: variant.feedProductId,
    feedVariantId: variant.feedVariantId,
    feedInventoryItemId: variant.feedInventoryItemId,
    listingId: variant.listingId,
    listingProductId: variant.listingProductId,
    listingVariantId: variant.listingVariantId,
  }));
}

function retiredVariantAuditSnapshot(summary: ShopifyProductMappingSummary) {
  return summary.variants.map((variant) => ({
    variantId: variant.variantId,
    sku: variant.sku,
    isActive: variant.isActive,
    catalogVariantId: null,
    catalogInventoryItemId: null,
    feed: variant.feedId === null
      ? null
      : {
          id: variant.feedId,
          isActive: false,
          productId: null,
          retainedDeadVariantId: variant.feedVariantId,
          inventoryItemId: null,
        },
    listing: variant.listingId === null
      ? null
      : {
          id: variant.listingId,
          productId: null,
          variantId: null,
          syncStatus: "error",
          syncError: RETIRED_MAPPING_SYNC_ERROR,
        },
  }));
}

async function loadMappedProducts(
  client: QueryClient,
  channelId: number,
  productId?: number,
): Promise<LoadedLocalProduct[]> {
  const productRows = await client
    .selectDistinct({
      id: products.id,
      name: products.name,
      sku: products.sku,
      shopifyProductId: products.shopifyProductId,
      shippingGroupCode: shippingGroups.code,
    })
    .from(products)
    .leftJoin(shippingGroups, eq(products.shippingGroupId, shippingGroups.id))
    .leftJoin(
      productVariants,
      and(
        eq(productVariants.productId, products.id),
        eq(productVariants.salesEligibility, "sellable"),
      ),
    )
    .leftJoin(
      channelFeeds,
      and(
        eq(channelFeeds.productVariantId, productVariants.id),
        eq(channelFeeds.channelId, channelId),
        eq(channelFeeds.channelType, "shopify"),
        eq(channelFeeds.isActive, 1),
      ),
    )
    .leftJoin(
      channelListings,
      and(
        eq(channelListings.productVariantId, productVariants.id),
        eq(channelListings.channelId, channelId),
      ),
    )
    .where(and(
      productId === undefined ? undefined : eq(products.id, productId),
      or(
        isNotNull(products.shopifyProductId),
        isNotNull(channelFeeds.id),
        isNotNull(channelListings.externalProductId),
        isNotNull(channelListings.externalVariantId),
      ),
    ))
    .orderBy(asc(products.id));

  if (productRows.length === 0) return [];

  const productIds = productRows.map((product) => product.id);
  const variantRows = await client
    .select({
      productId: productVariants.productId,
      variantId: productVariants.id,
      sku: productVariants.sku,
      isActive: productVariants.isActive,
      catalogBarcode: productVariants.barcode,
      catalogVariantId: productVariants.shopifyVariantId,
      catalogInventoryItemId: productVariants.shopifyInventoryItemId,
      feedId: channelFeeds.id,
      feedIsActive: channelFeeds.isActive,
      feedProductId: channelFeeds.channelProductId,
      feedVariantId: channelFeeds.channelVariantId,
      feedInventoryItemId: channelFeeds.channelInventoryItemId,
      listingId: channelListings.id,
      listingProductId: channelListings.externalProductId,
      listingVariantId: channelListings.externalVariantId,
    })
    .from(productVariants)
    .leftJoin(
      channelFeeds,
      and(
        eq(channelFeeds.productVariantId, productVariants.id),
        eq(channelFeeds.channelId, channelId),
        eq(channelFeeds.channelType, "shopify"),
      ),
    )
    .leftJoin(
      channelListings,
      and(
        eq(channelListings.productVariantId, productVariants.id),
        eq(channelListings.channelId, channelId),
      ),
    )
    .where(and(
      inArray(productVariants.productId, productIds),
      eq(productVariants.salesEligibility, "sellable"),
    ))
    .orderBy(asc(productVariants.productId), asc(productVariants.id));

  const variantsByProductId = new Map<
    number,
    ShopifyProductMappingSource["variants"]
  >();
  for (const row of variantRows) {
    const variants = variantsByProductId.get(row.productId) ?? [];
    variants.push({
      variantId: row.variantId,
      sku: row.sku,
      isActive: row.isActive,
      catalogBarcode: row.catalogBarcode,
      catalogVariantId: row.catalogVariantId,
      catalogInventoryItemId: row.catalogInventoryItemId,
      feedId: row.feedId,
      feedIsActive: row.feedIsActive === null
        ? null
        : row.feedIsActive === 1,
      feedProductId: row.feedProductId,
      feedVariantId: row.feedVariantId,
      feedInventoryItemId: row.feedInventoryItemId,
      listingId: row.listingId,
      listingProductId: row.listingProductId,
      listingVariantId: row.listingVariantId,
    });
    variantsByProductId.set(row.productId, variants);
  }

  return productRows.map((product) => {
    const rawShopifyProductId = product.shopifyProductId;
    const shopifyProductId = normalizeShopifyProductReference(
      rawShopifyProductId,
    );
    const source: ShopifyProductMappingSource = {
      productId: product.id,
      productName: product.name,
      productSku: product.sku,
      catalogProductId: shopifyProductId,
      channel: {
        id: channelId,
        name: "",
      },
      variants: variantsByProductId.get(product.id) ?? [],
    };
    const summary = buildShopifyProductMappingSummary(source);
    return {
      summary,
      local: {
        productId: product.id,
        productName: product.name,
        productSku: product.sku,
        rawShopifyProductId,
        shopifyProductId,
        shippingGroupCode: product.shippingGroupCode,
        mappingStatus: summary.status,
        mappingFingerprint: summary.fingerprint,
        evidenceProductIds: summary.evidenceProductIds,
        activeVariantCount: summary.activeVariantCount,
        activeVariantIssueIds: summary.activeVariantIssueIds,
      },
    };
  });
}

export function createShopifyProductMappingReconciliationRepository():
  ShopifyProductMappingReconciliationRepository {
  return {
    async loadChannelContext(
      channelId: number,
    ): Promise<ShopifyMappingChannelContext> {
      const [channel] = await db
        .select({
          id: channels.id,
          name: channels.name,
          isDefault: channels.isDefault,
        })
        .from(channels)
        .where(and(
          eq(channels.id, channelId),
          eq(channels.provider, "shopify"),
        ))
        .limit(1);

      if (!channel) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_CHANNEL_NOT_FOUND",
          `Shopify channel ${channelId} was not found`,
          404,
        );
      }
      if (channel.isDefault !== 1) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_DEFAULT_CHANNEL_REQUIRED",
          "Product mapping reconciliation is available only for the provider-default Shopify channel",
          409,
          { channelId, channelName: channel.name },
        );
      }

      const [connection] = await db
        .select({
          shopDomain: channelConnections.shopDomain,
          accessToken: channelConnections.accessToken,
          apiVersion: channelConnections.apiVersion,
        })
        .from(channelConnections)
        .where(eq(channelConnections.channelId, channelId))
        .orderBy(desc(channelConnections.updatedAt), desc(channelConnections.id))
        .limit(1);
      const shopDomain = connection?.shopDomain
        || process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = connection?.accessToken
        || process.env.SHOPIFY_ACCESS_TOKEN;

      if (!shopDomain || !accessToken) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_CREDENTIALS_NOT_CONFIGURED",
          "Shopify credentials are not configured for this channel",
          400,
          { channelId },
        );
      }

      const normalizedShopDomain = normalizeShopifyAdminDomain(shopDomain);
      if (!normalizedShopDomain) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_SHOP_DOMAIN_INVALID",
          "The Shopify connection has an invalid myshopify.com domain",
          500,
          { channelId },
        );
      }
      return {
        channel: {
          id: channel.id,
          name: channel.name,
          shopDomain: normalizedShopDomain,
        },
        credentials: {
          shopDomain: normalizedShopDomain,
          accessToken,
          apiVersion: connection?.apiVersion || DEFAULT_SHOPIFY_API_VERSION,
        },
      };
    },

    async listMappedProducts(channelId: number): Promise<LoadedLocalProduct[]> {
      return loadMappedProducts(db, channelId);
    },

    async loadMappedProduct(
      productId: number,
      channelId: number,
    ): Promise<LoadedLocalProduct | null> {
      return (await loadMappedProducts(db, channelId, productId))[0] ?? null;
    },

    async retireStaleMapping(input): Promise<RetireStaleShopifyMappingResult> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`shopify-product-mapping-retire:${input.channelId}:${input.expectedProductId}`},
              0::bigint
            )
          )
        `);
        await tx.execute(sql`
          SELECT id
          FROM catalog.products
          WHERE id = ${input.productId}
          FOR UPDATE
        `);

        const current = (
          await loadMappedProducts(tx, input.channelId, input.productId)
        )[0];
        if (!current) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_MAPPING_NOT_FOUND",
            "The Shopify product mapping no longer exists",
            409,
            { productId: input.productId },
          );
        }
        if (
          current.local.shopifyProductId !== input.expectedProductId
          || current.local.mappingFingerprint !== input.expectedFingerprint
        ) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_MAPPING_CHANGED",
            "The Shopify mapping changed after verification. Refresh and try again.",
            409,
            {
              productId: input.productId,
              expectedProductId: input.expectedProductId,
              currentProductId: current.local.shopifyProductId,
            },
          );
        }

        const currentMappedVariantIds = collectAllMappedShopifyVariantIds(
          current.summary,
        );
        if (
          currentMappedVariantIds.length
            !== input.verifiedMissingVariantIds.length
          || currentMappedVariantIds.some(
            (variantId, index) =>
              variantId !== input.verifiedMissingVariantIds[index],
          )
        ) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_MAPPING_CHANGED",
            "Variant mappings changed after Shopify verification. Refresh and try again.",
            409,
            {
              productId: input.productId,
              expectedVariantIds: input.verifiedMissingVariantIds,
              currentVariantIds: currentMappedVariantIds,
            },
          );
        }

        await tx
          .update(products)
          .set({
            shopifyProductId: null,
            updatedAt: input.now,
          })
          .where(eq(products.id, input.productId));

        const clearedVariants = await tx
          .update(productVariants)
          .set({
            shopifyVariantId: null,
            shopifyInventoryItemId: null,
            updatedAt: input.now,
          })
          .where(and(
            eq(productVariants.productId, input.productId),
            eq(productVariants.salesEligibility, "sellable"),
          ))
          .returning({ id: productVariants.id });
        const internalVariantIds = clearedVariants.map((variant) => variant.id);

        const disabledFeeds = internalVariantIds.length === 0
          ? []
          : await tx
            .update(channelFeeds)
            .set({
              channelProductId: null,
              channelInventoryItemId: null,
              isActive: 0,
              lastSyncedQty: null,
              consecutivePushFailures: 0,
              quarantinedAt: null,
              quarantineReason: null,
              updatedAt: input.now,
            })
            .where(and(
              eq(channelFeeds.channelId, input.channelId),
              eq(channelFeeds.channelType, "shopify"),
              inArray(channelFeeds.productVariantId, internalVariantIds),
            ))
            .returning({ id: channelFeeds.id });

        const resetListings = internalVariantIds.length === 0
          ? []
          : await tx
            .update(channelListings)
            .set({
              externalProductId: null,
              externalVariantId: null,
              externalUrl: null,
              syncStatus: "error",
              syncError: RETIRED_MAPPING_SYNC_ERROR,
              updatedAt: input.now,
            })
            .where(and(
              eq(channelListings.channelId, input.channelId),
              inArray(channelListings.productVariantId, internalVariantIds),
            ))
            .returning({ id: channelListings.id });

        const after = (
          await loadMappedProducts(tx, input.channelId, input.productId)
        )[0];
        if (after) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_MAPPING_RETIREMENT_INVARIANT_FAILED",
            "The retired Shopify mapping remained attached to the product",
            500,
            {
              productId: input.productId,
              status: after.local.mappingStatus,
              shopifyProductId: after.local.shopifyProductId,
            },
          );
        }

        await persistAuditEvent(tx, {
          actor: input.actor,
          action: "catalog.shopify_product_mapping_retired",
          target: `catalog.product:${input.productId}`,
          changes: {
            before: {
              catalogProductId: current.summary.catalogProductId,
              status: current.summary.status,
              variants: variantAuditSnapshot(current.summary),
            },
            after: {
              catalogProductId: null,
              status: "unmapped",
              variants: retiredVariantAuditSnapshot(current.summary),
            },
          },
          context: {
            channelId: input.channelId,
            retiredShopifyProductId: input.expectedProductId,
            verifiedMissingVariantIds: input.verifiedMissingVariantIds,
            disabledFeedIds: disabledFeeds.map((feed) => feed.id),
            resetListingIds: resetListings.map((listing) => listing.id),
            clearedVariantIds: internalVariantIds,
          },
        }, { timestamp: input.now });

        return {
          productId: input.productId,
          retiredShopifyProductId: input.expectedProductId,
          disabledFeedCount: disabledFeeds.length,
          resetListingCount: resetListings.length,
          clearedVariantCount: clearedVariants.length,
          afterStatus: "unmapped",
        };
      });
    },
  };
}
