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
  shopifyOwnershipRepairCommands,
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
  buildShopifyOwnershipGroups,
  normalizeShopifyAdminDomain,
  normalizeShopifyProductReference,
  shopifyOwnershipRepairRecommendationsSchema,
  shopifyOwnershipRepairPreviewHash,
  shopifyOwnershipRepairRequestHash,
  shopifyOwnershipRepairResultSchema,
  type ShopifyDuplicateOwnershipGroup,
  type ShopifyMappingLocalProduct,
  type ShopifyOwnershipRepairCommandRecord,
  type ShopifyOwnershipRepairRecommendation,
  type ShopifyOwnershipRepairResult,
  type ShopifyRemoteProductSnapshot,
} from "./shopify-product-mapping-reconciliation.domain";
import {
  type ShopifyMappingCredentials,
} from "./shopify-product-mapping-verifier";

const DEFAULT_SHOPIFY_API_VERSION = "2024-01";
const RETIRED_MAPPING_SYNC_ERROR =
  "Shopify mapping retired after the remote product and referenced variants were verified missing.";
const DETACHED_OWNERSHIP_SYNC_ERROR =
  "Inactive duplicate mapping detached by an audited Shopify ownership repair.";

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
  findOwnershipRepairCommand(
    idempotencyKey: string,
  ): Promise<ShopifyOwnershipRepairCommandRecord | null>;
  applyOwnershipRecommendations(input: {
    channel: ShopifyMappingChannelContext["channel"];
    recommendations: readonly ShopifyOwnershipRepairRecommendation[];
    remoteProducts: Map<string, ShopifyRemoteProductSnapshot>;
    idempotencyKey: string;
    requestHash: string;
    operator: string;
    reason: string;
    now: Date;
  }): Promise<{
    command: ShopifyOwnershipRepairCommandRecord;
    idempotentReplay: boolean;
  }>;
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

function mappingLockKey(channelId: number, shopifyProductId: string): string {
  return `shopify-product-mapping:${channelId}:${shopifyProductId}`;
}

function parseOwnershipRepairCommand(
  row: typeof shopifyOwnershipRepairCommands.$inferSelect,
): ShopifyOwnershipRepairCommandRecord {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_OWNERSHIP_REPAIR_RECEIPT_INVALID",
      "Stored Shopify ownership repair command has an invalid identifier",
      500,
    );
  }
  const result = shopifyOwnershipRepairResultSchema.safeParse(row.result);
  const recommendations = shopifyOwnershipRepairRecommendationsSchema
    .safeParse(row.recommendations);
  if (
    !result.success
    || !recommendations.success
    || result.data.channelId !== row.channelId
    || result.data.previewHash !== row.previewHash
    || new Date(result.data.completedAt).getTime()
      !== row.completedAt.getTime()
    || result.data.resolvedGroupCount !== recommendations.data.length
    || shopifyOwnershipRepairPreviewHash({
      channelId: row.channelId,
      shopDomain: result.data.shopDomain,
      recommendations: recommendations.data,
    }) !== row.previewHash
    || shopifyOwnershipRepairRequestHash({
      channelId: row.channelId,
      shopDomain: result.data.shopDomain,
      recommendations: recommendations.data,
      operator: row.operator,
      reason: row.reason,
    }) !== row.requestHash
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_OWNERSHIP_REPAIR_RECEIPT_INVALID",
      "Stored Shopify ownership repair command has an invalid result",
      500,
      { commandId: row.id },
    );
  }
  return Object.freeze({
    id: row.id,
    channelId: row.channelId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    previewHash: row.previewHash,
    operator: row.operator,
    reason: row.reason,
    recommendations: Object.freeze(recommendations.data),
    result: Object.freeze(result.data),
  });
}

export function assertOwnershipRepairCommandMatches(
  command: ShopifyOwnershipRepairCommandRecord,
  input: { channelId: number; requestHash: string },
): void {
  if (
    command.channelId !== input.channelId
    || command.requestHash !== input.requestHash
  ) {
    throw new ShopifyMappingReconciliationError(
      "SHOPIFY_OWNERSHIP_REPAIR_IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was already used for a different Shopify ownership repair",
      409,
      { commandId: command.id },
    );
  }
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

async function loadChannelContext(
  client: QueryClient,
  channelId: number,
): Promise<ShopifyMappingChannelContext> {
  const [channel] = await client
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

  const [connection] = await client
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
    const rawActiveChannelProductIds = source.variants
      .filter((variant) => variant.isActive)
      .flatMap((variant) => [
        variant.feedProductId,
        variant.listingProductId,
      ])
      .filter((value): value is string => (
        typeof value === "string" && value.trim() !== ""
      ));
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
        hasCanonicalChannelProductEvidence:
          rawActiveChannelProductIds.length > 0
          && rawActiveChannelProductIds.every(
            (value) => normalizeShopifyProductReference(value) !== null,
          ),
      },
    };
  });
}

function selectFreshOwnershipRepairGroups(input: {
  recommendations: readonly ShopifyOwnershipRepairRecommendation[];
  groups: readonly ShopifyDuplicateOwnershipGroup[];
}): ShopifyDuplicateOwnershipGroup[] {
  const groupsByProductId = new Map(
    input.groups.map((group) => [group.shopifyProductId, group]),
  );
  return [...input.recommendations]
    .sort((left, right) => left.shopifyProductId.localeCompare(
      right.shopifyProductId,
      "en",
      { numeric: true },
    ))
    .map((recommendation) => {
      const group = groupsByProductId.get(recommendation.shopifyProductId);
      if (!group || group.previewHash !== recommendation.expectedPreviewHash) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_OWNERSHIP_REPAIR_PREVIEW_STALE",
          "Shopify ownership evidence changed after review. Refresh and try again.",
          409,
          {
            shopifyProductId: recommendation.shopifyProductId,
            expectedPreviewHash: recommendation.expectedPreviewHash,
            currentPreviewHash: group?.previewHash ?? null,
          },
        );
      }
      if (
        group.decision !== "canonical_owner_recommended"
        || group.reason !== "single_active_owner_with_matching_evidence"
        || !group.remoteExists
        || group.recommendedProductId === null
        || group.nonCanonicalProductIds.length === 0
      ) {
        throw new ShopifyMappingReconciliationError(
          "SHOPIFY_OWNERSHIP_REPAIR_REVIEW_REQUIRED",
          "The selected Shopify ownership conflict is no longer safe for automatic repair.",
          409,
          {
            shopifyProductId: recommendation.shopifyProductId,
            decision: group.decision,
            reason: group.reason,
          },
        );
      }
      return group;
    });
}

function ownershipGroupAuditSnapshot(group: ShopifyDuplicateOwnershipGroup) {
  return {
    shopifyProductId: group.shopifyProductId,
    remoteExists: group.remoteExists,
    remoteTitle: group.remoteTitle,
    remoteStatus: group.remoteStatus,
    remoteShippingGroupCode: group.remoteShippingGroupCode,
    shippingGroupCode: group.shippingGroupCode,
    decision: group.decision,
    reason: group.reason,
    recommendedProductId: group.recommendedProductId,
    nonCanonicalProductIds: group.nonCanonicalProductIds,
    previewHash: group.previewHash,
    owners: group.owners,
  };
}

export function createShopifyProductMappingReconciliationRepository(
  database: typeof db = db,
):
  ShopifyProductMappingReconciliationRepository {
  return {
    async loadChannelContext(
      channelId: number,
    ): Promise<ShopifyMappingChannelContext> {
      return loadChannelContext(database, channelId);
    },

    async listMappedProducts(channelId: number): Promise<LoadedLocalProduct[]> {
      return loadMappedProducts(database, channelId);
    },

    async loadMappedProduct(
      productId: number,
      channelId: number,
    ): Promise<LoadedLocalProduct | null> {
      return (await loadMappedProducts(database, channelId, productId))[0]
        ?? null;
    },

    async findOwnershipRepairCommand(
      idempotencyKey: string,
    ): Promise<ShopifyOwnershipRepairCommandRecord | null> {
      const [row] = await database
        .select()
        .from(shopifyOwnershipRepairCommands)
        .where(eq(
          shopifyOwnershipRepairCommands.idempotencyKey,
          idempotencyKey,
        ))
        .limit(1);
      return row ? parseOwnershipRepairCommand(row) : null;
    },

    async retireStaleMapping(input): Promise<RetireStaleShopifyMappingResult> {
      return database.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${mappingLockKey(input.channelId, input.expectedProductId)},
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

    async applyOwnershipRecommendations(input) {
      return database.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`shopify-ownership-repair-command:${input.idempotencyKey}`},
              0::bigint
            )
          )
        `);

        const [priorRow] = await tx
          .select()
          .from(shopifyOwnershipRepairCommands)
          .where(eq(
            shopifyOwnershipRepairCommands.idempotencyKey,
            input.idempotencyKey,
          ))
          .limit(1);
        if (priorRow) {
          const prior = parseOwnershipRepairCommand(priorRow);
          assertOwnershipRepairCommandMatches(prior, {
            channelId: input.channel.id,
            requestHash: input.requestHash,
          });
          return { command: prior, idempotentReplay: true };
        }

        const targetShopifyProductIds = [...input.recommendations]
          .map((recommendation) => recommendation.shopifyProductId)
          .sort((left, right) => left.localeCompare(
            right,
            "en",
            { numeric: true },
          ));
        for (const shopifyProductId of targetShopifyProductIds) {
          await tx.execute(sql`
            SELECT pg_advisory_xact_lock(
              hashtextextended(
                ${mappingLockKey(input.channel.id, shopifyProductId)},
                0::bigint
              )
            )
          `);
        }

        // Advisory locks serialize every cooperative mapping writer. These
        // brief table fences also prevent a legacy direct writer from adding
        // a phantom owner between the locked evidence read and the detach.
        await tx.execute(sql`
          LOCK TABLE
            channels.channels,
            channels.channel_connections,
            catalog.products,
            catalog.product_variants,
            channels.channel_feeds,
            channels.channel_listings
          IN SHARE ROW EXCLUSIVE MODE
        `);

        const currentContext = await loadChannelContext(tx, input.channel.id);
        if (currentContext.channel.shopDomain !== input.channel.shopDomain) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_MAPPING_STORE_CHANGED",
            "The Shopify store connection changed after review. Refresh and try again.",
            409,
            {
              expectedShopDomain: input.channel.shopDomain,
              currentShopDomain: currentContext.channel.shopDomain,
            },
          );
        }

        const currentProducts = await loadMappedProducts(
          tx,
          input.channel.id,
        );
        const currentGroups = buildShopifyOwnershipGroups({
          channel: currentContext.channel,
          localProducts: currentProducts.map((product) => product.local),
          remoteProducts: input.remoteProducts,
        });
        const selectedGroups = selectFreshOwnershipRepairGroups({
          recommendations: input.recommendations,
          groups: currentGroups,
        });
        const detachedProductIds = [...new Set(selectedGroups.flatMap(
          (group) => group.nonCanonicalProductIds,
        ))].sort((left, right) => left - right);
        const expectedDetachedProductCount = selectedGroups.reduce(
          (count, group) => count + group.nonCanonicalProductIds.length,
          0,
        );
        if (detachedProductIds.length !== expectedDetachedProductCount) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_SCOPE_OVERLAP",
            "A local product appears in more than one ownership repair group.",
            409,
            { detachedProductIds },
          );
        }

        const detachedVariants = await tx
          .select({
            id: productVariants.id,
            productId: productVariants.productId,
            isActive: productVariants.isActive,
            salesEligibility: productVariants.salesEligibility,
          })
          .from(productVariants)
          .where(inArray(productVariants.productId, detachedProductIds))
          .orderBy(asc(productVariants.id));
        const activeSellableVariants = detachedVariants.filter(
          (variant) => variant.isActive
            && variant.salesEligibility === "sellable",
        );
        if (activeSellableVariants.length > 0) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_ACTIVE_VARIANT",
            "A noncanonical owner gained an active sellable variant after review.",
            409,
            {
              variantIds: activeSellableVariants.map((variant) => variant.id),
            },
          );
        }
        const detachedVariantIds = detachedVariants.map(
          (variant) => variant.id,
        );

        const clearedProducts = await tx
          .update(products)
          .set({
            shopifyProductId: null,
            updatedAt: input.now,
          })
          .where(inArray(products.id, detachedProductIds))
          .returning({ id: products.id });
        if (clearedProducts.length !== detachedProductIds.length) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_PRODUCT_SET_CHANGED",
            "The noncanonical product set changed during repair.",
            409,
            {
              expectedProductIds: detachedProductIds,
              updatedProductIds: clearedProducts.map((product) => product.id),
            },
          );
        }

        const clearedVariants = detachedVariantIds.length === 0
          ? []
          : await tx
            .update(productVariants)
            .set({
              shopifyVariantId: null,
              shopifyInventoryItemId: null,
              updatedAt: input.now,
            })
            .where(and(
              inArray(productVariants.id, detachedVariantIds),
              or(
                isNotNull(productVariants.shopifyVariantId),
                isNotNull(productVariants.shopifyInventoryItemId),
              ),
            ))
            .returning({ id: productVariants.id });

        const disabledFeeds = detachedVariantIds.length === 0
          ? []
          : await tx
            .update(channelFeeds)
            .set({
              channelProductId: null,
              channelVariantId: null,
              channelInventoryItemId: null,
              isActive: 0,
              lastSyncedQty: null,
              consecutivePushFailures: 0,
              quarantinedAt: null,
              quarantineReason: null,
              updatedAt: input.now,
            })
            .where(and(
              eq(channelFeeds.channelId, input.channel.id),
              eq(channelFeeds.channelType, "shopify"),
              inArray(channelFeeds.productVariantId, detachedVariantIds),
            ))
            .returning({ id: channelFeeds.id });

        const resetListings = detachedVariantIds.length === 0
          ? []
          : await tx
            .update(channelListings)
            .set({
              externalProductId: null,
              externalVariantId: null,
              externalUrl: null,
              syncStatus: "error",
              syncError: DETACHED_OWNERSHIP_SYNC_ERROR,
              updatedAt: input.now,
            })
            .where(and(
              eq(channelListings.channelId, input.channel.id),
              inArray(channelListings.productVariantId, detachedVariantIds),
            ))
            .returning({ id: channelListings.id });

        const remainingCatalogMappings = await tx
          .select({ id: products.id })
          .from(products)
          .where(and(
            inArray(products.id, detachedProductIds),
            isNotNull(products.shopifyProductId),
          ));
        const remainingVariantMappings = detachedVariantIds.length === 0
          ? []
          : await tx
            .select({ id: productVariants.id })
            .from(productVariants)
            .where(and(
              inArray(productVariants.id, detachedVariantIds),
              or(
                isNotNull(productVariants.shopifyVariantId),
                isNotNull(productVariants.shopifyInventoryItemId),
              ),
            ));
        const remainingFeedMappings = detachedVariantIds.length === 0
          ? []
          : await tx
            .select({ id: channelFeeds.id })
            .from(channelFeeds)
            .where(and(
              eq(channelFeeds.channelId, input.channel.id),
              eq(channelFeeds.channelType, "shopify"),
              inArray(channelFeeds.productVariantId, detachedVariantIds),
              or(
                isNotNull(channelFeeds.channelProductId),
                isNotNull(channelFeeds.channelVariantId),
                isNotNull(channelFeeds.channelInventoryItemId),
                eq(channelFeeds.isActive, 1),
              ),
            ));
        const remainingListingMappings = detachedVariantIds.length === 0
          ? []
          : await tx
            .select({ id: channelListings.id })
            .from(channelListings)
            .where(and(
              eq(channelListings.channelId, input.channel.id),
              inArray(channelListings.productVariantId, detachedVariantIds),
              or(
                isNotNull(channelListings.externalProductId),
                isNotNull(channelListings.externalVariantId),
              ),
            ));
        if (
          remainingCatalogMappings.length > 0
          || remainingVariantMappings.length > 0
          || remainingFeedMappings.length > 0
          || remainingListingMappings.length > 0
        ) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_INVARIANT_FAILED",
            "A detached owner retained Shopify mapping evidence.",
            500,
            {
              productIds: remainingCatalogMappings.map((row) => row.id),
              variantIds: remainingVariantMappings.map((row) => row.id),
              feedIds: remainingFeedMappings.map((row) => row.id),
              listingIds: remainingListingMappings.map((row) => row.id),
            },
          );
        }

        const afterProducts = await loadMappedProducts(tx, input.channel.id);
        const afterGroups = buildShopifyOwnershipGroups({
          channel: currentContext.channel,
          localProducts: afterProducts.map((product) => product.local),
          remoteProducts: input.remoteProducts,
        });
        const unresolvedTargets = new Set(
          afterGroups.map((group) => group.shopifyProductId),
        );
        const stillDuplicated = targetShopifyProductIds.filter(
          (shopifyProductId) => unresolvedTargets.has(shopifyProductId),
        );
        if (stillDuplicated.length > 0) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_INVARIANT_FAILED",
            "A repaired Shopify product still has multiple local owners.",
            500,
            { shopifyProductIds: stillDuplicated },
          );
        }

        const recommendations = [...input.recommendations].sort(
          (left, right) => left.shopifyProductId.localeCompare(
            right.shopifyProductId,
            "en",
            { numeric: true },
          ),
        );
        const previewHash = shopifyOwnershipRepairPreviewHash({
          channelId: input.channel.id,
          shopDomain: currentContext.channel.shopDomain,
          recommendations,
        });
        const recommendedProductIds = selectedGroups
          .map((group) => group.recommendedProductId!)
          .sort((left, right) => left - right);
        const result: ShopifyOwnershipRepairResult = Object.freeze({
          contractVersion: 1,
          channelId: input.channel.id,
          shopDomain: currentContext.channel.shopDomain,
          previewHash,
          resolvedGroupCount: selectedGroups.length,
          recommendedProductIds: Object.freeze(recommendedProductIds),
          detachedProductIds: Object.freeze(detachedProductIds),
          clearedCatalogProductCount: clearedProducts.length,
          clearedCatalogVariantCount: clearedVariants.length,
          detachedFeedCount: disabledFeeds.length,
          resetListingCount: resetListings.length,
          completedAt: input.now.toISOString(),
        });
        const [inserted] = await tx
          .insert(shopifyOwnershipRepairCommands)
          .values({
            channelId: input.channel.id,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            previewHash,
            operator: input.operator,
            reason: input.reason,
            recommendations,
            result,
            createdAt: input.now,
            completedAt: input.now,
          })
          .returning();
        if (!inserted) {
          throw new ShopifyMappingReconciliationError(
            "SHOPIFY_OWNERSHIP_REPAIR_COMMAND_NOT_RECORDED",
            "The Shopify ownership repair could not be recorded.",
            500,
          );
        }

        for (const group of selectedGroups) {
          await persistAuditEvent(tx, {
            actor: input.operator,
            action: "catalog.shopify_duplicate_ownership_resolved",
            target: `shopify.product:${group.shopifyProductId}`,
            changes: {
              before: ownershipGroupAuditSnapshot(group),
              after: {
                recommendedProductId: group.recommendedProductId,
                detachedProductIds: group.nonCanonicalProductIds,
                duplicateOwnerCount: 1,
              },
            },
            context: {
              commandId: inserted.id,
              channelId: input.channel.id,
              idempotencyKey: input.idempotencyKey,
              requestHash: input.requestHash,
              previewHash,
              reason: input.reason,
            },
          }, { timestamp: input.now });
        }

        return {
          command: parseOwnershipRepairCommand(inserted),
          idempotentReplay: false,
        };
      });
    },
  };
}
