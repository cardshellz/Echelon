import {
  buildShopifyProductConsolidationPlan,
  shopifyProductConsolidationApplyRequestSchema,
  shopifyProductConsolidationEvidenceSchema,
  shopifyProductConsolidationPreviewRequestSchema,
  shopifyProductConsolidationRequestHash,
  type ShopifyProductConsolidationResult,
  type ShopifyProductConsolidationEvidence,
  type ShopifyProductConsolidationPlan,
} from "./shopify-product-consolidation.domain";
import {
  assertShopifyProductConsolidationCommandMatches,
  createShopifyProductConsolidationRepository,
  type ShopifyProductConsolidationRepository,
} from "./shopify-product-consolidation.repository";
import {
  createShopifyProductMappingReconciliationRepository,
  ShopifyMappingReconciliationError,
  type ShopifyProductMappingReconciliationRepository,
} from "./shopify-product-mapping-reconciliation.repository";
import { normalizeShopifyAdminDomain } from "./shopify-product-mapping-reconciliation.domain";
import {
  createShopifyProductMappingVerifier,
  type ShopifyProductMappingVerifier,
} from "./shopify-product-mapping-verifier";

export interface ShopifyProductConsolidationPreviewResult {
  readonly contractVersion: 1;
  readonly generatedAt: string;
  readonly readOnly: true;
  readonly evidence: ShopifyProductConsolidationEvidence;
  readonly plan: ShopifyProductConsolidationPlan;
}

export interface ShopifyProductConsolidationExecutionResult
  extends ShopifyProductConsolidationResult {
  readonly commandId: number;
  readonly idempotentReplay: boolean;
}

type ChannelContextRepository = Pick<
  ShopifyProductMappingReconciliationRepository,
  "loadChannelContext"
>;

export function createShopifyProductConsolidationService(input: {
  repository?: ShopifyProductConsolidationRepository;
  channelContextRepository?: ChannelContextRepository;
  verifier?: ShopifyProductMappingVerifier;
  clock?: () => Date;
} = {}) {
  const repository = input.repository
    ?? createShopifyProductConsolidationRepository();
  const channelContextRepository = input.channelContextRepository
    ?? createShopifyProductMappingReconciliationRepository();
  const verifier = input.verifier ?? createShopifyProductMappingVerifier();
  const clock = input.clock ?? (() => new Date());

  async function preview(inputToPreview: {
    channelId: number;
    request: unknown;
  }): Promise<ShopifyProductConsolidationPreviewResult> {
    if (!Number.isSafeInteger(inputToPreview.channelId) || inputToPreview.channelId <= 0) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_CHANNEL_ID",
        "A valid Shopify channel ID is required",
        400,
      );
    }
    const parsedRequest = shopifyProductConsolidationPreviewRequestSchema.safeParse(
      inputToPreview.request,
    );
    if (!parsedRequest.success) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_PRODUCT_CONSOLIDATION_REQUEST",
        "Shopify product consolidation preview request is invalid",
        400,
        { issues: parsedRequest.error.issues },
      );
    }

    const context = await channelContextRepository.loadChannelContext(
      inputToPreview.channelId,
    );
    const local = await repository.loadLocalEvidence({
      channelId: inputToPreview.channelId,
      shopDomain: context.channel.shopDomain,
      shopifyProductId: parsedRequest.data.shopifyProductId,
      canonicalProductId: parsedRequest.data.canonicalProductId,
    });
    const [remoteProducts, remoteVariantProductIds] = await Promise.all([
      verifier.lookupProducts(
        context.credentials,
        [parsedRequest.data.shopifyProductId],
      ),
      verifier.lookupVariantProductIds(
        context.credentials,
        [...local.externalVariantIds],
      ),
    ]);
    const remoteProduct = remoteProducts.get(parsedRequest.data.shopifyProductId);
    if (!remoteProduct) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_REMOTE_EVIDENCE_INCOMPLETE",
        "Shopify did not return evidence for the requested product",
        502,
        { shopifyProductId: parsedRequest.data.shopifyProductId },
      );
    }
    const missingVariantEvidence = local.externalVariantIds.filter(
      (variantId) => !remoteVariantProductIds.has(variantId),
    );
    if (missingVariantEvidence.length > 0) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_REMOTE_EVIDENCE_INCOMPLETE",
        "Shopify did not return parent evidence for every referenced variant",
        502,
        { variantIds: missingVariantEvidence },
      );
    }

    const evidence = shopifyProductConsolidationEvidenceSchema.parse({
      channelId: local.channelId,
      shopDomain: local.shopDomain,
      shopifyProductId: local.shopifyProductId,
      remoteProductExists: remoteProduct.exists,
      remoteProductTitle: remoteProduct.title,
      ownerProductIds: local.ownerProductIds,
      canonicalProductId: local.canonicalProductId,
      activeCutoverFreezeId: local.activeCutoverFreezeId,
      products: local.products,
      remoteVariantProductIds: Object.fromEntries(remoteVariantProductIds),
    });
    return Object.freeze({
      contractVersion: 1,
      generatedAt: clock().toISOString(),
      readOnly: true,
      evidence,
      plan: buildShopifyProductConsolidationPlan(evidence),
    });
  }

  async function apply(inputToApply: {
    channelId: number;
    request: unknown;
    actor: string;
  }): Promise<ShopifyProductConsolidationExecutionResult> {
    if (!Number.isSafeInteger(inputToApply.channelId) || inputToApply.channelId <= 0) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_CHANNEL_ID",
        "A valid Shopify channel ID is required",
        400,
      );
    }
    const parsedRequest = shopifyProductConsolidationApplyRequestSchema.safeParse(
      inputToApply.request,
    );
    if (!parsedRequest.success) {
      throw new ShopifyMappingReconciliationError(
        "INVALID_SHOPIFY_PRODUCT_CONSOLIDATION_REQUEST",
        "Shopify product consolidation request is invalid",
        400,
        { issues: parsedRequest.error.issues },
      );
    }
    const actor = inputToApply.actor.trim();
    if (!actor || actor.length > 120 || /[\u0000-\u001f\u007f]/.test(actor)) {
      throw new ShopifyMappingReconciliationError(
        "AUTHENTICATED_ACTOR_REQUIRED",
        "A valid authenticated user identity is required",
        401,
      );
    }
    const expectedShopDomain = normalizeShopifyAdminDomain(
      parsedRequest.data.expectedShopDomain,
    );
    if (!expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_SHOP_DOMAIN_INVALID",
        "A valid myshopify.com domain from the consolidation preview is required",
        400,
      );
    }
    const request = {
      ...parsedRequest.data,
      expectedShopDomain,
    };
    const requestHash = shopifyProductConsolidationRequestHash({
      actor,
      request,
    });

    const prior = await repository.findCommand(request.idempotencyKey);
    if (prior) {
      assertShopifyProductConsolidationCommandMatches(prior, {
        channelId: inputToApply.channelId,
        requestHash,
      });
      return Object.freeze({
        ...prior.result,
        commandId: prior.id,
        idempotentReplay: true,
      });
    }

    const context = await channelContextRepository.loadChannelContext(
      inputToApply.channelId,
    );
    if (context.channel.shopDomain !== expectedShopDomain) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_MAPPING_STORE_CHANGED",
        "The Shopify store connection changed after review. Refresh and try again.",
        409,
        {
          expectedShopDomain,
          currentShopDomain: context.channel.shopDomain,
        },
      );
    }
    const local = await repository.loadLocalEvidence({
      channelId: inputToApply.channelId,
      shopDomain: context.channel.shopDomain,
      shopifyProductId: request.shopifyProductId,
      canonicalProductId: request.canonicalProductId,
    });
    const [remoteProducts, remoteVariantProductIds] = await Promise.all([
      verifier.lookupProducts(context.credentials, [request.shopifyProductId]),
      verifier.lookupVariantProductIds(
        context.credentials,
        [...local.externalVariantIds],
      ),
    ]);
    const remoteProduct = remoteProducts.get(request.shopifyProductId);
    if (!remoteProduct) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_REMOTE_EVIDENCE_INCOMPLETE",
        "Shopify did not return evidence for the requested product",
        502,
        { shopifyProductId: request.shopifyProductId },
      );
    }
    const missingVariantEvidence = local.externalVariantIds.filter(
      (variantId) => !remoteVariantProductIds.has(variantId),
    );
    if (missingVariantEvidence.length > 0) {
      throw new ShopifyMappingReconciliationError(
        "SHOPIFY_PRODUCT_CONSOLIDATION_REMOTE_EVIDENCE_INCOMPLETE",
        "Shopify did not return parent evidence for every referenced variant",
        502,
        { variantIds: missingVariantEvidence },
      );
    }

    const applied = await repository.applyConsolidation({
      channelId: inputToApply.channelId,
      shopDomain: context.channel.shopDomain,
      request,
      requestHash,
      actor,
      now: clock(),
      remoteProductExists: remoteProduct.exists,
      remoteProductTitle: remoteProduct.title,
      remoteVariantProductIds,
    });
    return Object.freeze({
      ...applied.command.result,
      commandId: applied.command.id,
      idempotentReplay: applied.idempotentReplay,
    });
  }

  return { preview, apply };
}

export type ShopifyProductConsolidationService = ReturnType<
  typeof createShopifyProductConsolidationService
>;
