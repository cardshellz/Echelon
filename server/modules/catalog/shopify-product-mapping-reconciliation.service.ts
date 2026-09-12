import {
  buildShopifyMappingReconciliationReport,
  buildShopifyOwnershipReview,
  collectDuplicateShopifyOwnershipProductIds,
  evaluateDeadMappingRetirement,
  normalizeShopifyAdminDomain,
  normalizeShopifyProductReference,
  shopifyOwnershipRepairApplySchema,
  shopifyOwnershipRepairRequestHash,
  type ShopifyMappingReconciliationReport,
  type ShopifyOwnershipRepairExecutionResult,
  type ShopifyOwnershipReviewFilter,
  type ShopifyOwnershipReviewPage,
} from "./shopify-product-mapping-reconciliation.domain";
import {
  assertOwnershipRepairCommandMatches,
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

  async function loadLocalEvidence(channelId: number) {
    const context = await repository.loadChannelContext(channelId);
    const localProducts = await repository.listMappedProducts(channelId);
    return {
      channel: context.channel,
      credentials: context.credentials,
      localProducts: localProducts.map((product) => ({
        ...product.local,
        mappingFingerprint: product.summary.fingerprint,
      })),
    };
  }

  async function scan(
    channelId: number,
  ): Promise<ShopifyMappingReconciliationReport> {
    const evidence = await loadLocalEvidence(channelId);
    const productIds = [...new Set(evidence.localProducts
      .flatMap((product) => [
        product.shopifyProductId,
        ...product.evidenceProductIds,
      ])
      .filter((productId): productId is string => productId !== null))]
      .sort((left, right) =>
        left.localeCompare(right, "en", { numeric: true }));
    const remoteProducts = await verifier.lookupProducts(
      evidence.credentials,
      productIds,
    );

    return buildShopifyMappingReconciliationReport({
      generatedAt: clock().toISOString(),
      channel: evidence.channel,
      localProducts: evidence.localProducts,
      remoteProducts,
    });
  }

  async function reviewOwnership(inputToReview: {
    channelId: number;
    filter: ShopifyOwnershipReviewFilter;
    page: number;
    pageSize: number;
  }): Promise<ShopifyOwnershipReviewPage> {
    const evidence = await loadLocalEvidence(inputToReview.channelId);
    const duplicateProductIds = collectDuplicateShopifyOwnershipProductIds(
      evidence.localProducts,
    );
    const remoteProducts = await verifier.lookupProducts(
      evidence.credentials,
      duplicateProductIds,
    );
    return buildShopifyOwnershipReview({
      generatedAt: clock().toISOString(),
      channel: evidence.channel,
      localProducts: evidence.localProducts,
      remoteProducts,
      filter: inputToReview.filter,
      page: inputToReview.page,
      pageSize: inputToReview.pageSize,
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

  async function applyOwnershipRepair(inputToApply: {
    channelId: number;
    request: unknown;
    actor: string;
  }): Promise<ShopifyOwnershipRepairExecutionResult> {
    if (!Number.isInteger(inputToApply.channelId) || inputToApply.channelId <= 0) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_CHANNEL_ID",
        "A valid Shopify channel ID is required",
        400,
      );
    }
    const parsedRequest = shopifyOwnershipRepairApplySchema.safeParse(
      inputToApply.request,
    );
    if (!parsedRequest.success) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_OWNERSHIP_REPAIR_REQUEST",
        "Shopify ownership repair request is invalid",
        400,
        { issues: parsedRequest.error.issues },
      );
    }
    const actor = inputToApply.actor.trim();
    if (
      !actor
      || actor.length > 120
      || /[\u0000-\u001f\u007f]/.test(actor)
    ) {
      throw new ShopifyMappingReconciliationError(
        "AUTHENTICATED_ACTOR_REQUIRED",
        "A valid authenticated user identity is required",
        401,
      );
    }
    const request = parsedRequest.data;
    const expectedShopDomain = normalizeShopifyAdminDomain(
      request.expectedShopDomain,
    );
    if (!expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_SHOP_DOMAIN_INVALID",
        "A valid myshopify.com domain from the ownership review is required",
        400,
      );
    }
    const requestHash = shopifyOwnershipRepairRequestHash({
      channelId: inputToApply.channelId,
      shopDomain: expectedShopDomain,
      recommendations: request.recommendations,
      operator: actor,
      reason: request.reason,
    });

    const prior = await repository.findOwnershipRepairCommand(
      request.idempotencyKey,
    );
    if (prior) {
      assertOwnershipRepairCommandMatches(prior, {
        channelId: inputToApply.channelId,
        requestHash,
      });
      return Object.freeze({
        ...prior.result,
        commandId: prior.id,
        idempotentReplay: true,
      });
    }

    const context = await repository.loadChannelContext(inputToApply.channelId);
    if (context.channel.shopDomain !== expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_STORE_CHANGED",
        "The Shopify store connection changed after the ownership review. Refresh and try again.",
        409,
        {
          expectedShopDomain,
          currentShopDomain: context.channel.shopDomain,
        },
      );
    }
    const targetShopifyProductIds = request.recommendations
      .map((recommendation) => recommendation.shopifyProductId)
      .sort((left, right) => left.localeCompare(
        right,
        "en",
        { numeric: true },
      ));
    const remoteProducts = await verifier.lookupProducts(
      context.credentials,
      targetShopifyProductIds,
    );
    const applied = await repository.applyOwnershipRecommendations({
      channel: context.channel,
      recommendations: request.recommendations,
      remoteProducts,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      operator: actor,
      reason: request.reason,
      now: clock(),
    });
    return Object.freeze({
      ...applied.command.result,
      commandId: applied.command.id,
      idempotentReplay: applied.idempotentReplay,
    });
  }

  return {
    scan,
    reviewOwnership,
    retireStaleMapping,
    applyOwnershipRepair,
  };
}

export type ShopifyProductMappingReconciliationService = ReturnType<
  typeof createShopifyProductMappingReconciliationService
>;
