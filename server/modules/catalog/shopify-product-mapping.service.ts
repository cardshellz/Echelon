import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
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
  collectMappedShopifyVariantIds,
  evaluateShopifyProductMappingRepair,
  normalizeShopifyId,
  type ShopifyProductMappingSource,
  type ShopifyProductMappingSummary,
} from "./shopify-product-mapping.domain";
import { enqueueShippingGroupMetafieldWrite } from "./shipping-group-sync";

const DEFAULT_SHOPIFY_API_VERSION = "2024-01";
const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;

type TransactionCallback = Parameters<typeof db.transaction>[0];
type TransactionClient = Parameters<TransactionCallback>[0];
type QueryClient = typeof db | TransactionClient;

interface LoadedMapping {
  summary: ShopifyProductMappingSummary;
  shippingGroupCode: string | null;
}

interface VerifiedShopifyProduct {
  id: string;
  title: string | null;
  variantIds: string[];
}

export interface ShopifyProductMappingRepairResult {
  before: ShopifyProductMappingSummary;
  after: ShopifyProductMappingSummary;
  verifiedShopifyProduct: {
    id: string;
    title: string | null;
  };
  updatedFeedCount: number;
  updatedListingCount: number;
  shippingGroupMetafieldQueued: boolean;
  alreadyConsistent: boolean;
}

export class ShopifyProductMappingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShopifyProductMappingError";
  }
}

function normalizeShopDomain(value: string): string {
  const trimmed = value.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  return trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
}

async function resolveShopifyChannel(
  client: QueryClient,
  requestedChannelId?: number | null,
) {
  const rows = await client
    .select({
      id: channels.id,
      name: channels.name,
    })
    .from(channels)
    .where(
      requestedChannelId
        ? and(eq(channels.id, requestedChannelId), eq(channels.provider, "shopify"))
        : eq(channels.provider, "shopify"),
    )
    .orderBy(sql`CASE WHEN ${channels.isDefault} = 1 THEN 0 ELSE 1 END`, asc(channels.id))
    .limit(1);

  if (!rows[0]) {
    throw new ShopifyProductMappingError(
      "SHOPIFY_CHANNEL_NOT_CONFIGURED",
      requestedChannelId
        ? `Shopify channel ${requestedChannelId} was not found`
        : "No Shopify channel is configured",
      400,
    );
  }
  return rows[0];
}

async function loadMapping(
  client: QueryClient,
  productId: number,
  channelId?: number | null,
): Promise<LoadedMapping> {
  const [product] = await client
    .select({
      id: products.id,
      name: products.name,
      sku: products.sku,
      shopifyProductId: products.shopifyProductId,
      shippingGroupCode: shippingGroups.code,
    })
    .from(products)
    .leftJoin(shippingGroups, eq(products.shippingGroupId, shippingGroups.id))
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) {
    throw new ShopifyProductMappingError(
      "PRODUCT_NOT_FOUND",
      `Product ${productId} was not found`,
      404,
    );
  }

  const channel = await resolveShopifyChannel(client, channelId);
  const rows = await client
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      isActive: productVariants.isActive,
      catalogVariantId: productVariants.shopifyVariantId,
      feedId: channelFeeds.id,
      feedIsActive: channelFeeds.isActive,
      feedProductId: channelFeeds.channelProductId,
      feedVariantId: channelFeeds.channelVariantId,
      listingId: channelListings.id,
      listingProductId: channelListings.externalProductId,
      listingVariantId: channelListings.externalVariantId,
    })
    .from(productVariants)
    .leftJoin(
      channelFeeds,
      and(
        eq(channelFeeds.productVariantId, productVariants.id),
        eq(channelFeeds.channelId, channel.id),
        eq(channelFeeds.channelType, "shopify"),
      ),
    )
    .leftJoin(
      channelListings,
      and(
        eq(channelListings.productVariantId, productVariants.id),
        eq(channelListings.channelId, channel.id),
      ),
    )
    .where(eq(productVariants.productId, product.id))
    .orderBy(asc(productVariants.id));

  const source: ShopifyProductMappingSource = {
    productId: product.id,
    productName: product.name,
    productSku: product.sku,
    catalogProductId: product.shopifyProductId,
    channel,
    variants: rows.map((row) => ({
      variantId: row.variantId,
      sku: row.sku,
      isActive: row.isActive,
      catalogVariantId: row.catalogVariantId,
      feedId: row.feedId,
      feedIsActive: row.feedIsActive === null ? null : row.feedIsActive === 1,
      feedProductId: row.feedProductId,
      feedVariantId: row.feedVariantId,
      listingId: row.listingId,
      listingProductId: row.listingProductId,
      listingVariantId: row.listingVariantId,
    })),
  };

  return {
    summary: buildShopifyProductMappingSummary(source),
    shippingGroupCode: product.shippingGroupCode,
  };
}

async function fetchVerifiedShopifyProduct(
  channelId: number,
  targetProductId: string,
  requiredVariantIds: string[],
): Promise<VerifiedShopifyProduct> {
  const [connection] = await db
    .select({
      shopDomain: channelConnections.shopDomain,
      accessToken: channelConnections.accessToken,
      apiVersion: channelConnections.apiVersion,
    })
    .from(channelConnections)
    .where(eq(channelConnections.channelId, channelId))
    .limit(1);

  const shopDomain = connection?.shopDomain || process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = connection?.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shopDomain || !accessToken) {
    throw new ShopifyProductMappingError(
      "SHOPIFY_CREDENTIALS_NOT_CONFIGURED",
      "Shopify credentials are not configured for this channel",
      400,
    );
  }

  const apiVersion = connection?.apiVersion || DEFAULT_SHOPIFY_API_VERSION;
  let response: Response;
  try {
    response = await fetch(
      `https://${normalizeShopDomain(shopDomain)}/admin/api/${apiVersion}/products/${targetProductId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error: unknown) {
    throw new ShopifyProductMappingError(
      "SHOPIFY_PRODUCT_LOOKUP_FAILED",
      error instanceof Error && error.name === "TimeoutError"
        ? "Shopify product verification timed out"
        : "Shopify product verification could not reach Shopify",
      502,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new ShopifyProductMappingError(
      response.status === 404 ? "SHOPIFY_PRODUCT_NOT_FOUND" : "SHOPIFY_PRODUCT_LOOKUP_FAILED",
      response.status === 404
        ? `Shopify product ${targetProductId} does not exist`
        : `Shopify product verification failed with HTTP ${response.status}`,
      response.status === 404 ? 409 : 502,
      { responseStatus: response.status, responseBody: responseBody.slice(0, 500) },
    );
  }

  const payload = await response.json() as {
    product?: { id?: string | number; title?: string | null; variants?: Array<{ id?: string | number }> };
  };
  const productId = normalizeShopifyId(payload.product?.id);
  if (!productId || productId !== targetProductId) {
    throw new ShopifyProductMappingError(
      "SHOPIFY_PRODUCT_RESPONSE_INVALID",
      "Shopify returned an invalid product identity",
      502,
      { requestedProductId: targetProductId, returnedProductId: productId },
    );
  }

  const verifiedVariantIds = new Set(
    (payload.product?.variants || [])
      .map((variant) => normalizeShopifyId(variant.id))
      .filter((variantId): variantId is string => variantId !== null),
  );

  // Shopify product payloads can truncate large variant sets. Verify any
  // locally linked variant omitted from that payload through its own endpoint.
  for (const requiredVariantId of requiredVariantIds) {
    if (verifiedVariantIds.has(requiredVariantId)) continue;
    let variantResponse: Response;
    try {
      variantResponse = await fetch(
        `https://${normalizeShopDomain(shopDomain)}/admin/api/${apiVersion}/variants/${requiredVariantId}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error: unknown) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_VARIANT_LOOKUP_FAILED",
        `Shopify variant ${requiredVariantId} could not be verified`,
        502,
        { variantId: requiredVariantId, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (variantResponse.status === 404) continue;
    if (!variantResponse.ok) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_VARIANT_LOOKUP_FAILED",
        `Shopify variant verification failed with HTTP ${variantResponse.status}`,
        502,
        { variantId: requiredVariantId, responseStatus: variantResponse.status },
      );
    }
    const variantPayload = await variantResponse.json() as {
      variant?: { id?: string | number; product_id?: string | number };
    };
    if (
      normalizeShopifyId(variantPayload.variant?.id) === requiredVariantId
      && normalizeShopifyId(variantPayload.variant?.product_id) === targetProductId
    ) {
      verifiedVariantIds.add(requiredVariantId);
    }
  }

  return {
    id: productId,
    title: payload.product?.title || null,
    variantIds: [...verifiedVariantIds],
  };
}

function normalizedIdSql(column: unknown, targetProductId: string) {
  return sql`substring(${column} from '([0-9]+)$') = ${targetProductId}`;
}

export function createShopifyProductMappingService() {
  async function getSummary(
    productId: number,
    channelId?: number | null,
  ): Promise<ShopifyProductMappingSummary> {
    return (await loadMapping(db, productId, channelId)).summary;
  }

  async function repair(input: {
    productId: number;
    targetProductId: string | number;
    channelId?: number | null;
    actor: string;
  }): Promise<ShopifyProductMappingRepairResult> {
    const targetProductId = normalizeShopifyId(input.targetProductId);
    if (!targetProductId) {
      throw new ShopifyProductMappingError(
        "INVALID_SHOPIFY_PRODUCT_ID",
        "Enter a valid Shopify product ID",
        400,
      );
    }

    const loaded = await loadMapping(db, input.productId, input.channelId);
    const before = loaded.summary;
    const alreadyConsistent = before.status === "consistent"
      && before.catalogProductId === targetProductId
      && before.evidenceProductIds.length === 1
      && before.evidenceProductIds[0] === targetProductId;
    if (!alreadyConsistent && (!before.repairable || before.recommendedProductId !== targetProductId)) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_MAPPING_NOT_REPAIRABLE",
        "The mapping cannot be repaired automatically because channel records do not agree on one target product",
        409,
        {
          status: before.status,
          catalogProductId: before.catalogProductId,
          evidenceProductIds: before.evidenceProductIds,
          requestedProductId: targetProductId,
        },
      );
    }

    const mappedVariantIdsBeforeVerification = collectMappedShopifyVariantIds(before);
    const verifiedShopifyProduct = await fetchVerifiedShopifyProduct(
      before.channel.id,
      targetProductId,
      mappedVariantIdsBeforeVerification,
    );
    const repairEvaluation = evaluateShopifyProductMappingRepair({
      summary: before,
      requestedProductId: targetProductId,
      verifiedRemoteVariantIds: verifiedShopifyProduct.variantIds,
    });
    if (!repairEvaluation.ok) {
      throw new ShopifyProductMappingError(
        repairEvaluation.code,
        repairEvaluation.code === "SHOPIFY_VARIANTS_OUTSIDE_TARGET_PRODUCT"
          ? "One or more linked Shopify variants do not belong to the proposed Shopify product"
          : "The Shopify mapping is no longer repairable",
        409,
        repairEvaluation.context,
      );
    }
    const mappedVariantIds = repairEvaluation.mappedVariantIds;

    if (alreadyConsistent) {
      return {
        before,
        after: before,
        verifiedShopifyProduct: {
          id: verifiedShopifyProduct.id,
          title: verifiedShopifyProduct.title,
        },
        updatedFeedCount: 0,
        updatedListingCount: 0,
        shippingGroupMetafieldQueued: false,
        alreadyConsistent: true,
      };
    }

    const writeResult = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM catalog.products WHERE id = ${input.productId} FOR UPDATE`);
      const current = await loadMapping(tx, input.productId, before.channel.id);
      if (current.summary.fingerprint !== before.fingerprint) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_MAPPING_CHANGED",
          "The mapping changed while it was being verified. Refresh and try again.",
          409,
        );
      }

      const [duplicateProduct] = await tx
        .select({ id: products.id, sku: products.sku, name: products.name })
        .from(products)
        .where(and(
          sql`${products.id} <> ${input.productId}`,
          normalizedIdSql(products.shopifyProductId, targetProductId),
        ))
        .limit(1);
      if (duplicateProduct) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_PRODUCT_ALREADY_MAPPED",
          "The target Shopify product is already assigned to another Echelon product",
          409,
          { targetProductId, duplicateProduct },
        );
      }

      const [crossProductMapping] = await tx
        .select({
          productId: productVariants.productId,
          variantId: productVariants.id,
          sku: productVariants.sku,
          feedProductId: channelFeeds.channelProductId,
          listingProductId: channelListings.externalProductId,
        })
        .from(productVariants)
        .leftJoin(channelFeeds, and(
          eq(channelFeeds.productVariantId, productVariants.id),
          eq(channelFeeds.channelId, before.channel.id),
          eq(channelFeeds.channelType, "shopify"),
        ))
        .leftJoin(channelListings, and(
          eq(channelListings.productVariantId, productVariants.id),
          eq(channelListings.channelId, before.channel.id),
        ))
        .where(and(
          sql`${productVariants.productId} <> ${input.productId}`,
          or(
            normalizedIdSql(channelFeeds.channelProductId, targetProductId),
            normalizedIdSql(channelListings.externalProductId, targetProductId),
          ),
        ))
        .limit(1);
      if (crossProductMapping) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_CHANNEL_PRODUCT_ALREADY_MAPPED",
          "The target Shopify product appears in channel mappings for another Echelon product",
          409,
          { targetProductId, crossProductMapping },
        );
      }

      const [updatedProduct] = await tx
        .update(products)
        .set({ shopifyProductId: targetProductId, updatedAt: new Date() })
        .where(eq(products.id, input.productId))
        .returning({ id: products.id });
      if (!updatedProduct) {
        throw new ShopifyProductMappingError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} was not found`,
          404,
        );
      }

      const variantIds = current.summary.variants.map((variant) => variant.variantId);
      let updatedFeedCount = 0;
      let updatedListingCount = 0;
      if (variantIds.length > 0) {
        const updatedFeeds = await tx
          .update(channelFeeds)
          .set({ channelProductId: targetProductId, updatedAt: new Date() })
          .where(and(
            eq(channelFeeds.channelId, before.channel.id),
            eq(channelFeeds.channelType, "shopify"),
            inArray(channelFeeds.productVariantId, variantIds),
          ))
          .returning({ id: channelFeeds.id });
        updatedFeedCount = updatedFeeds.length;

        const updatedListings = await tx
          .update(channelListings)
          .set({ externalProductId: targetProductId, updatedAt: new Date() })
          .where(and(
            eq(channelListings.channelId, before.channel.id),
            inArray(channelListings.productVariantId, variantIds),
          ))
          .returning({ id: channelListings.id });
        updatedListingCount = updatedListings.length;
      }

      await persistAuditEvent(tx, {
        actor: input.actor,
        action: "catalog.shopify_product_mapping_repaired",
        target: `catalog.product:${input.productId}`,
        changes: {
          before: {
            catalogProductId: before.catalogProductId,
            evidenceProductIds: before.evidenceProductIds,
            status: before.status,
          },
          after: {
            catalogProductId: targetProductId,
            evidenceProductIds: [targetProductId],
            status: "consistent",
          },
        },
        context: {
          channelId: before.channel.id,
          channelName: before.channel.name,
          verifiedShopifyTitle: verifiedShopifyProduct.title,
          mappedVariantIds,
          updatedFeedCount,
          updatedListingCount,
        },
      });

      await enqueueShippingGroupMetafieldWrite(tx, {
        shopifyProductId: targetProductId,
        shippingGroupCode: current.shippingGroupCode,
      });

      return { updatedFeedCount, updatedListingCount };
    });

    const after = await getSummary(input.productId, before.channel.id);
    return {
      before,
      after,
      verifiedShopifyProduct: {
        id: verifiedShopifyProduct.id,
        title: verifiedShopifyProduct.title,
      },
      ...writeResult,
      shippingGroupMetafieldQueued: true,
      alreadyConsistent: false,
    };
  }

  return { getSummary, repair };
}

export type ShopifyProductMappingService = ReturnType<typeof createShopifyProductMappingService>;
