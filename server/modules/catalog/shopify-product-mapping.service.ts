import { and, asc, eq, or, sql } from "drizzle-orm";
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
  evaluateShopifyProductMappingRepair,
  normalizeShopifyId,
  type ShopifyProductMappingSource,
  type ShopifyProductMappingSummary,
  type ShopifyVariantMappingResolution,
  type VerifiedShopifyVariantIdentity,
} from "./shopify-product-mapping.domain";
import { enqueueShippingGroupMetafieldWrite } from "./shipping-group-sync";

const DEFAULT_SHOPIFY_API_VERSION = "2024-01";
const SHOPIFY_REQUEST_TIMEOUT_MS = 10_000;
const SHOPIFY_VARIANT_PAGE_LIMIT = 250;
const SHOPIFY_VARIANT_MAX_PAGES = 20;

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
  variants: VerifiedShopifyVariantIdentity[];
}

export interface ShopifyProductMappingRepairResult {
  before: ShopifyProductMappingSummary;
  after: ShopifyProductMappingSummary;
  verifiedShopifyProduct: {
    id: string;
    title: string | null;
  };
  mappedVariantCount: number;
  updatedFeedCount: number;
  createdFeedCount: number;
  updatedListingCount: number;
  createdListingCount: number;
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
      catalogBarcode: row.catalogBarcode,
      catalogVariantId: row.catalogVariantId,
      catalogInventoryItemId: row.catalogInventoryItemId,
      feedId: row.feedId,
      feedIsActive: row.feedIsActive === null ? null : row.feedIsActive === 1,
      feedProductId: row.feedProductId,
      feedVariantId: row.feedVariantId,
      feedInventoryItemId: row.feedInventoryItemId,
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
  const normalizedDomain = normalizeShopDomain(shopDomain);
  const headers = {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
  const fetchShopify = async (url: string, resource: "product" | "variants"): Promise<Response> => {
    try {
      return await fetch(url, {
        headers,
        signal: AbortSignal.timeout(SHOPIFY_REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      throw new ShopifyProductMappingError(
        resource === "product" ? "SHOPIFY_PRODUCT_LOOKUP_FAILED" : "SHOPIFY_VARIANT_LOOKUP_FAILED",
        error instanceof Error && error.name === "TimeoutError"
          ? `Shopify ${resource} verification timed out`
          : `Shopify ${resource} verification could not reach Shopify`,
        502,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  };
  const parseShopifyJson = async <T>(responseToParse: Response, resource: string): Promise<T> => {
    try {
      return await responseToParse.json() as T;
    } catch (error: unknown) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_PRODUCT_RESPONSE_INVALID",
        `Shopify returned invalid JSON while verifying ${resource}`,
        502,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  };

  const response = await fetchShopify(
    `https://${normalizedDomain}/admin/api/${apiVersion}/products/${targetProductId}.json?fields=id,title`,
    "product",
  );

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

  const payload = await parseShopifyJson<{
    product?: { id?: string | number; title?: string | null };
  }>(response, "the product");
  const productId = normalizeShopifyId(payload.product?.id);
  if (!productId || productId !== targetProductId) {
    throw new ShopifyProductMappingError(
      "SHOPIFY_PRODUCT_RESPONSE_INVALID",
      "Shopify returned an invalid product identity",
      502,
      { requestedProductId: targetProductId, returnedProductId: productId },
    );
  }

  const variantsById = new Map<string, VerifiedShopifyVariantIdentity>();
  const variantsPath = `/admin/api/${apiVersion}/products/${targetProductId}/variants.json`;
  let variantsUrl: string | null = `https://${normalizedDomain}${variantsPath}?limit=${SHOPIFY_VARIANT_PAGE_LIMIT}`;
  let pageCount = 0;
  while (variantsUrl) {
    pageCount += 1;
    if (pageCount > SHOPIFY_VARIANT_MAX_PAGES) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_VARIANT_PAGINATION_LIMIT_EXCEEDED",
        `Shopify returned more than ${SHOPIFY_VARIANT_MAX_PAGES} variant pages`,
        502,
        { targetProductId, maxPages: SHOPIFY_VARIANT_MAX_PAGES },
      );
    }
    const variantResponse = await fetchShopify(variantsUrl, "variants");
    if (!variantResponse.ok) {
      const responseBody = await variantResponse.text();
      throw new ShopifyProductMappingError(
        "SHOPIFY_VARIANT_LOOKUP_FAILED",
        `Shopify variant verification failed with HTTP ${variantResponse.status}`,
        502,
        { responseStatus: variantResponse.status, responseBody: responseBody.slice(0, 500) },
      );
    }
    const variantPayload = await parseShopifyJson<{
      variants?: Array<{
        id?: string | number;
        product_id?: string | number;
        sku?: string | null;
        barcode?: string | null;
        inventory_item_id?: string | number | null;
      }>;
    }>(variantResponse, "product variants");
    for (const variant of variantPayload.variants ?? []) {
      const variantId = normalizeShopifyId(variant.id);
      const variantProductId = normalizeShopifyId(variant.product_id);
      if (!variantId || (variantProductId && variantProductId !== targetProductId)) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_PRODUCT_RESPONSE_INVALID",
          "Shopify returned a variant outside the requested product",
          502,
          { targetProductId, variantId, variantProductId },
        );
      }
      variantsById.set(variantId, {
        id: variantId,
        sku: variant.sku?.trim() || null,
        barcode: variant.barcode?.trim() || null,
        inventoryItemId: normalizeShopifyId(variant.inventory_item_id),
      });
    }

    const linkHeader = variantResponse.headers.get("link");
    const nextMatch = linkHeader
      ?.split(",")
      .map((part) => part.trim())
      .find((part) => /rel="?next"?/i.test(part))
      ?.match(/<([^>]+)>/);
    if (!nextMatch) {
      variantsUrl = null;
      continue;
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(nextMatch[1]);
    } catch {
      throw new ShopifyProductMappingError(
        "SHOPIFY_PRODUCT_RESPONSE_INVALID",
        "Shopify returned an invalid variant pagination URL",
        502,
        { targetProductId },
      );
    }
    if (
      nextUrl.protocol !== "https:"
      || nextUrl.hostname.toLowerCase() !== normalizedDomain.toLowerCase()
      || nextUrl.pathname !== variantsPath
    ) {
      throw new ShopifyProductMappingError(
        "SHOPIFY_PRODUCT_RESPONSE_INVALID",
        "Shopify returned an invalid variant pagination link",
        502,
        { targetProductId },
      );
    }
    variantsUrl = nextUrl.toString();
  }

  return {
    id: productId,
    title: payload.product?.title || null,
    variants: [...variantsById.values()].sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true })),
  };
}

function normalizedIdSql(column: unknown, targetProductId: string) {
  return sql`substring(${column} from '([0-9]+)$') = ${targetProductId}`;
}

function normalizedIdsSql(column: unknown, targetIds: string[]) {
  if (targetIds.length === 0) return sql`false`;
  return sql`(${sql.join(
    targetIds.map((targetId) => normalizedIdSql(column, targetId)),
    sql` OR `,
  )})`;
}

function mappingRequiresWrite(
  summary: ShopifyProductMappingSummary,
  targetProductId: string,
  variantMappings: ShopifyVariantMappingResolution[],
): boolean {
  if (summary.catalogProductId !== targetProductId || summary.status !== "consistent") return true;
  const variantsById = new Map(summary.variants.map((variant) => [variant.variantId, variant]));
  return variantMappings.some((mapping) => {
    const variant = variantsById.get(mapping.variantId);
    return !variant
      || variant.catalogVariantId !== mapping.remoteVariantId
      || variant.catalogInventoryItemId !== mapping.remoteInventoryItemId
      || (!variant.catalogBarcode && Boolean(mapping.remoteBarcode))
      || !variant.feedId
      || variant.feedIsActive !== true
      || variant.feedProductId !== targetProductId
      || variant.feedVariantId !== mapping.remoteVariantId
      || variant.feedInventoryItemId !== mapping.remoteInventoryItemId
      || !variant.listingId
      || variant.listingProductId !== targetProductId
      || variant.listingVariantId !== mapping.remoteVariantId;
  });
}

function activeVariantAuditSnapshot(summary: ShopifyProductMappingSummary) {
  return summary.variants
    .filter((variant) => variant.isActive)
    .map((variant) => ({
      variantId: variant.variantId,
      sku: variant.sku,
      barcode: variant.catalogBarcode,
      catalogVariantId: variant.catalogVariantId,
      catalogInventoryItemId: variant.catalogInventoryItemId,
      feedVariantId: variant.feedVariantId,
      feedInventoryItemId: variant.feedInventoryItemId,
      listingVariantId: variant.listingVariantId,
    }));
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
    expectedVariant?: {
      variantId: number;
      remoteVariantId: string | number;
    };
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
    const verifiedShopifyProduct = await fetchVerifiedShopifyProduct(
      before.channel.id,
      targetProductId,
    );
    const repairEvaluation = evaluateShopifyProductMappingRepair({
      summary: before,
      requestedProductId: targetProductId,
      verifiedRemoteVariants: verifiedShopifyProduct.variants,
      expectedVariant: input.expectedVariant,
    });
    if (!repairEvaluation.ok) {
      throw new ShopifyProductMappingError(
        repairEvaluation.code,
        repairEvaluation.code === "SHOPIFY_ACTIVE_VARIANTS_UNRESOLVED"
          ? "One or more active variants could not be matched uniquely to the verified Shopify product"
          : "The Shopify mapping is no longer repairable",
        409,
        repairEvaluation.context,
      );
    }
    const mappedVariantIds = repairEvaluation.mappedVariantIds;
    const variantMappings = repairEvaluation.variantMappings;
    const requiresWrite = mappingRequiresWrite(before, targetProductId, variantMappings);

    if (!requiresWrite) {
      return {
        before,
        after: before,
        verifiedShopifyProduct: {
          id: verifiedShopifyProduct.id,
          title: verifiedShopifyProduct.title,
        },
        mappedVariantCount: variantMappings.length,
        updatedFeedCount: 0,
        createdFeedCount: 0,
        updatedListingCount: 0,
        createdListingCount: 0,
        shippingGroupMetafieldQueued: false,
        alreadyConsistent: true,
      };
    }

    const writeResult = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`shopify-product-mapping:${before.channel.id}:${targetProductId}`}, 0::bigint)
        )
      `);
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

      const expectedOwnerByRemoteId = new Map(
        variantMappings.map((mapping) => [mapping.remoteVariantId, mapping.variantId]),
      );
      const catalogVariantOwners = await tx
        .select({
          variantId: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          remoteVariantId: productVariants.shopifyVariantId,
        })
        .from(productVariants)
        .where(normalizedIdsSql(productVariants.shopifyVariantId, mappedVariantIds));
      const conflictingCatalogOwner = catalogVariantOwners.find((owner) => {
        const remoteVariantId = normalizeShopifyId(owner.remoteVariantId);
        return remoteVariantId !== null && expectedOwnerByRemoteId.get(remoteVariantId) !== owner.variantId;
      });
      if (conflictingCatalogOwner) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_VARIANT_ALREADY_MAPPED",
          "A verified Shopify variant is already assigned to another Echelon variant",
          409,
          { conflictingCatalogOwner },
        );
      }

      const feedVariantOwners = await tx
        .select({
          feedId: channelFeeds.id,
          productVariantId: channelFeeds.productVariantId,
          remoteVariantId: channelFeeds.channelVariantId,
        })
        .from(channelFeeds)
        .where(and(
          eq(channelFeeds.channelId, before.channel.id),
          normalizedIdsSql(channelFeeds.channelVariantId, mappedVariantIds),
        ));
      const conflictingFeedOwner = feedVariantOwners.find((owner) => {
        const remoteVariantId = normalizeShopifyId(owner.remoteVariantId);
        return remoteVariantId !== null && expectedOwnerByRemoteId.get(remoteVariantId) !== owner.productVariantId;
      });
      if (conflictingFeedOwner) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_VARIANT_ALREADY_MAPPED",
          "A verified Shopify variant is already assigned to another channel feed",
          409,
          { conflictingFeedOwner },
        );
      }

      const listingVariantOwners = await tx
        .select({
          listingId: channelListings.id,
          productVariantId: channelListings.productVariantId,
          remoteVariantId: channelListings.externalVariantId,
        })
        .from(channelListings)
        .where(and(
          eq(channelListings.channelId, before.channel.id),
          normalizedIdsSql(channelListings.externalVariantId, mappedVariantIds),
        ));
      const conflictingListingOwner = listingVariantOwners.find((owner) => {
        const remoteVariantId = normalizeShopifyId(owner.remoteVariantId);
        return remoteVariantId !== null && expectedOwnerByRemoteId.get(remoteVariantId) !== owner.productVariantId;
      });
      if (conflictingListingOwner) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_VARIANT_ALREADY_MAPPED",
          "A verified Shopify variant is already assigned to another channel listing",
          409,
          { conflictingListingOwner },
        );
      }

      const now = new Date();
      const [updatedProduct] = await tx
        .update(products)
        .set({ shopifyProductId: targetProductId, updatedAt: now })
        .where(eq(products.id, input.productId))
        .returning({ id: products.id });
      if (!updatedProduct) {
        throw new ShopifyProductMappingError(
          "PRODUCT_NOT_FOUND",
          `Product ${input.productId} was not found`,
          404,
        );
      }

      let updatedFeedCount = 0;
      let createdFeedCount = 0;
      let updatedListingCount = 0;
      let createdListingCount = 0;
      for (const mapping of variantMappings) {
        const currentVariant = current.summary.variants.find(
          (variant) => variant.variantId === mapping.variantId,
        );
        const catalogVariantUpdates: Partial<typeof productVariants.$inferInsert> = {
          shopifyVariantId: mapping.remoteVariantId,
          shopifyInventoryItemId: mapping.remoteInventoryItemId,
          updatedAt: now,
        };
        if (!currentVariant?.catalogBarcode && mapping.remoteBarcode) {
          catalogVariantUpdates.barcode = mapping.remoteBarcode;
        }
        const [updatedVariant] = await tx
          .update(productVariants)
          .set(catalogVariantUpdates)
          .where(and(
            eq(productVariants.id, mapping.variantId),
            eq(productVariants.productId, input.productId),
            eq(productVariants.isActive, true),
          ))
          .returning({ id: productVariants.id });
        if (!updatedVariant) {
          throw new ShopifyProductMappingError(
            "ACTIVE_VARIANT_CHANGED",
            "An active variant changed while the Shopify mapping was being repaired",
            409,
            { variantId: mapping.variantId },
          );
        }

        const updatedFeeds = await tx
          .update(channelFeeds)
          .set({
            channelType: "shopify",
            channelProductId: targetProductId,
            channelVariantId: mapping.remoteVariantId,
            channelInventoryItemId: mapping.remoteInventoryItemId,
            channelSku: mapping.remoteSku || mapping.sku || null,
            isActive: 1,
            consecutivePushFailures: 0,
            quarantinedAt: null,
            quarantineReason: null,
            updatedAt: now,
          })
          .where(and(
            eq(channelFeeds.channelId, before.channel.id),
            eq(channelFeeds.channelType, "shopify"),
            eq(channelFeeds.productVariantId, mapping.variantId),
          ))
          .returning({ id: channelFeeds.id });
        if (updatedFeeds.length > 0) {
          updatedFeedCount += updatedFeeds.length;
        } else {
          await tx.insert(channelFeeds).values({
            channelId: before.channel.id,
            productVariantId: mapping.variantId,
            channelType: "shopify",
            channelProductId: targetProductId,
            channelVariantId: mapping.remoteVariantId,
            channelInventoryItemId: mapping.remoteInventoryItemId,
            channelSku: mapping.remoteSku || mapping.sku || null,
            isActive: 1,
          });
          createdFeedCount += 1;
        }

        const updatedListings = await tx
          .update(channelListings)
          .set({
            externalProductId: targetProductId,
            externalVariantId: mapping.remoteVariantId,
            externalSku: mapping.remoteSku || mapping.sku || null,
            syncStatus: "synced",
            syncError: null,
            lastSyncedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(channelListings.channelId, before.channel.id),
            eq(channelListings.productVariantId, mapping.variantId),
          ))
          .returning({ id: channelListings.id });
        if (updatedListings.length > 0) {
          updatedListingCount += updatedListings.length;
        } else {
          await tx.insert(channelListings).values({
            channelId: before.channel.id,
            productVariantId: mapping.variantId,
            externalProductId: targetProductId,
            externalVariantId: mapping.remoteVariantId,
            externalSku: mapping.remoteSku || mapping.sku || null,
            syncStatus: "synced",
            lastSyncedAt: now,
          });
          createdListingCount += 1;
        }
      }

      const repaired = await loadMapping(tx, input.productId, before.channel.id);
      if (
        repaired.summary.status !== "consistent"
        || repaired.summary.catalogProductId !== targetProductId
        || repaired.summary.activeVariantIssueIds.length > 0
      ) {
        throw new ShopifyProductMappingError(
          "SHOPIFY_MAPPING_REPAIR_INVARIANT_FAILED",
          "The repaired mapping did not reload as fully consistent",
          500,
          {
            status: repaired.summary.status,
            catalogProductId: repaired.summary.catalogProductId,
            activeVariantIssueIds: repaired.summary.activeVariantIssueIds,
          },
        );
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
            activeVariants: activeVariantAuditSnapshot(before),
          },
          after: {
            catalogProductId: repaired.summary.catalogProductId,
            evidenceProductIds: repaired.summary.evidenceProductIds,
            status: repaired.summary.status,
            activeVariants: activeVariantAuditSnapshot(repaired.summary),
          },
        },
        context: {
          channelId: before.channel.id,
          channelName: before.channel.name,
          verifiedShopifyTitle: verifiedShopifyProduct.title,
          mappedVariantIds,
          variantMappings,
          mappedVariantCount: variantMappings.length,
          updatedFeedCount,
          createdFeedCount,
          updatedListingCount,
          createdListingCount,
        },
      });

      await enqueueShippingGroupMetafieldWrite(tx, {
        shopifyProductId: targetProductId,
        shippingGroupCode: current.shippingGroupCode,
      });

      return {
        mappedVariantCount: variantMappings.length,
        updatedFeedCount,
        createdFeedCount,
        updatedListingCount,
        createdListingCount,
      };
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
