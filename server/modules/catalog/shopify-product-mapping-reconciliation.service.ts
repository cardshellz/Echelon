import {
  buildShopifyMappingReconciliationReport,
  evaluateDeadMappingRetirement,
  normalizeShopifyAdminDomain,
  normalizeShopifyProductReference,
  type ShopifyMappingReconciliationReport,
} from "./shopify-product-mapping-reconciliation.domain";
import {
  collectAllMappedShopifyVariantIds,
  createShopifyProductMappingReconciliationRepository,
  ShopifyMappingReconciliationError,
  type RetireStaleShopifyMappingResult,
  type ShopifyProductMappingReconciliationRepository,
} from "./shopify-product-mapping-reconciliation.repository";
import {
  createShopifyProductMappingVerifier,
  type ShopifyProductMappingVerifier,
} from "./shopify-product-mapping-verifier";

export { ShopifyMappingReconciliationError }
  from "./shopify-product-mapping-reconciliation.repository";

export function createShopifyProductMappingReconciliationService(input: {
  repository?: ShopifyProductMappingReconciliationRepository;
  verifier?: ShopifyProductMappingVerifier;
  clock?: () => Date;
} = {}) {
  const repository = input.repository
    ?? createShopifyProductMappingReconciliationRepository();
  const verifier = input.verifier ?? createShopifyProductMappingVerifier();
  const clock = input.clock ?? (() => new Date());

  async function scan(
    channelId: number,
  ): Promise<ShopifyMappingReconciliationReport> {
    const context = await repository.loadChannelContext(channelId);
    const localProducts = await repository.listMappedProducts(channelId);
    const productIds = [...new Set(localProducts
      .flatMap((product) => [
        product.local.shopifyProductId,
        ...product.local.evidenceProductIds,
      ])
      .filter((productId): productId is string => productId !== null))]
      .sort((left, right) =>
        left.localeCompare(right, "en", { numeric: true }));
    const remoteProducts = await verifier.lookupProducts(
      context.credentials,
      productIds,
    );

    return buildShopifyMappingReconciliationReport({
      generatedAt: clock().toISOString(),
      channel: context.channel,
      localProducts: localProducts.map((product) => ({
        ...product.local,
        mappingFingerprint: product.summary.fingerprint,
      })),
      remoteProducts,
    });
  }

  async function retireStaleMapping(inputToRetire: {
    productId: number;
    channelId: number;
    expectedProductId: string | number;
    expectedFingerprint: string;
    expectedShopDomain: string;
    actor: string;
  }): Promise<RetireStaleShopifyMappingResult> {
    const expectedProductId = normalizeShopifyProductReference(
      inputToRetire.expectedProductId,
    );
    if (!expectedProductId) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_PRODUCT_ID",
        "A valid Shopify product ID is required",
        400,
      );
    }
    if (!inputToRetire.expectedFingerprint.trim()) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_FINGERPRINT_REQUIRED",
        "Refresh mapping health before retiring a stale mapping",
        400,
      );
    }
    const expectedShopDomain = normalizeShopifyAdminDomain(
      inputToRetire.expectedShopDomain,
    );
    if (!expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_SHOP_DOMAIN_INVALID",
        "A valid myshopify.com domain from the health scan is required",
        400,
      );
    }
    const actor = inputToRetire.actor.trim();
    if (!actor) {
      throw new ShopifyMappingReconciliationError(
        "AUTHENTICATED_ACTOR_REQUIRED",
        "Authenticated user identity is required",
        401,
      );
    }

    const context = await repository.loadChannelContext(
      inputToRetire.channelId,
    );
    if (context.channel.shopDomain !== expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_STORE_CHANGED",
        "The Shopify store connection changed after the health scan. Refresh and try again.",
        409,
        {
          expectedShopDomain,
          currentShopDomain: context.channel.shopDomain,
        },
      );
    }
    const loaded = await repository.loadMappedProduct(
      inputToRetire.productId,
      inputToRetire.channelId,
    );
    if (!loaded) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_NOT_FOUND",
        "The Shopify product mapping no longer exists",
        409,
        { productId: inputToRetire.productId },
      );
    }
    if (
      loaded.local.shopifyProductId !== expectedProductId
      || loaded.summary.fingerprint !== inputToRetire.expectedFingerprint
    ) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_CHANGED",
        "The Shopify mapping changed after the health scan. Refresh and try again.",
        409,
        {
          productId: inputToRetire.productId,
          expectedProductId,
          currentProductId: loaded.local.shopifyProductId,
        },
      );
    }

    const mappedVariantIds = collectAllMappedShopifyVariantIds(loaded.summary);
    const verification = await verifier.verifyProductAndVariants(
      context.credentials,
      expectedProductId,
      mappedVariantIds,
    );
    const retirement = evaluateDeadMappingRetirement({
      expectedProductId,
      remoteProductExists: verification.remoteProductExists,
      liveVariantIds: verification.liveVariantIds,
    });
    if (!retirement.ok) {
      throw new ShopifyMappingReconciliationError(
        retirement.code,
        retirement.code === "SHOPIFY_PRODUCT_STILL_EXISTS"
          ? "Shopify still owns this product. The mapping was not changed."
          : "At least one referenced Shopify variant still exists. The mapping requires manual review.",
        409,
        retirement.context,
      );
    }

    return repository.retireStaleMapping({
      productId: inputToRetire.productId,
      channelId: inputToRetire.channelId,
      expectedProductId,
      expectedFingerprint: loaded.summary.fingerprint,
      actor,
      verifiedMissingVariantIds: mappedVariantIds,
      now: clock(),
    });
  }

  return { scan, retireStaleMapping };
}

export type ShopifyProductMappingReconciliationService = ReturnType<
  typeof createShopifyProductMappingReconciliationService
>;
