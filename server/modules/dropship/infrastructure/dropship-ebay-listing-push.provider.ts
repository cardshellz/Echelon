import { DropshipError } from "../domain/errors";
import { resolveEbayMpn } from "../domain/ebay-product-identifiers";
import { describeEbayErrors, parseEbayErrorBody } from "./ebay-error-body";
import { ebaySellRequestHeaders } from "./ebay-sell-headers";
import { createProviderRequestDeadline } from "../../channels/provider-request-limits";
import { executeEbayQuantityHttp } from "../../channels/adapters/ebay/ebay-quantity-http";
import { ebayQuantityMutationIdentity, executeAdmittedEbayQuantityRequest, type EbayQuantityRequestAdmission } from "../../channels/quantity-publication-request";
import type {
  DropshipMarketplaceListingPushProvider,
  DropshipMarketplaceListingPushRequest,
  DropshipMarketplaceListingPushResult,
} from "../application/dropship-marketplace-listing-push-provider";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";
import {
  EbayMarketplaceListingConnector,
  type EbayListingConnectorDraft,
  type EbayListingLifecycleClient,
  type EbayListingRebuildPreview,
  type EbayListingRebuildResult,
} from "../../channels/listing-connectors/ebay-listing.connector";
import {
  EbayListingBuilder,
  type EbayListingConfig as SharedEbayListingConfig,
} from "../../channels/adapters/ebay/ebay-listing-builder";
import type {
  EbayBulkPriceQuantityRequest,
  EbayBulkPriceQuantityResponse,
  EbayInventoryItem,
  EbayInventoryItemGroup,
  EbayOffer,
} from "../../channels/adapters/ebay/ebay-types";
import { ebayListingImagesFromUrls } from "../../channels/ebay-listing-photos.domain";
import type { ChannelListingPayload } from "../../channels/channel-adapter.interface";
import {
  isEbayResourceAuthFailureStatus,
  recordEbayAccessTokenRejection,
} from "./dropship-ebay-auth-failure";
import { DropshipEbayTokenOwner, resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";
import type { DropshipEbayPushPublicationReader } from "./dropship-ebay-push-publication.reader";
import {
  EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_STATUS,
  isEbayConnectorAccessTokenRejection,
  translateEbayConnectorError,
} from "./dropship-ebay-connector-errors";
import type {
  DropshipEbayFulfillmentPolicyGuard,
  DropshipEbayFulfillmentPolicyPreflight,
} from "../application/dropship-ebay-fulfillment-policy-guard";
import type {
  DropshipEbayManagedLocationProvider,
} from "../application/dropship-ebay-managed-location-service";
import type { DropshipEbayStockReadinessPort } from "../application/dropship-ebay-stock-readiness-port";
import {
  PUBLICATION_SCOPE_BUSY_BACKOFF_MS, PUBLICATION_SCOPE_BUSY_CODE, stockLinkError, stockLinkRefusal,
} from "../domain/stock-link-readiness";

type FetchLike = typeof fetch;
interface Clock {
  now(): Date;
}

interface EbayListingConfig {
  marketplaceId: string;
  merchantLocationKey: string;
  businessPolicies: {
    paymentPolicyId: string;
    returnPolicyId: string;
    fulfillmentPolicyId: string;
  };
  environment: "sandbox" | "production";
}

interface EbayOfferResponse {
  offers?: Array<
    EbayOffer & {
      offerId?: string;
      listingId?: string;
      status?: string;
    }
  >;
}

export interface DropshipEbayListingLifecycleClient extends EbayListingLifecycleClient {
  getInventoryItemGroup(
    groupKey: string,
  ): Promise<(EbayInventoryItemGroup & { variantSKUs?: string[] }) | null>;
  deleteInventoryItemGroup(groupKey: string): Promise<void>;
  withdrawOffer(offerId: string): Promise<void>;
  withdrawOfferByInventoryItemGroup(
    groupKey: string,
    marketplaceId: string,
  ): Promise<void>;
}

export interface DropshipEbayReplacementSession {
  readonly marketplaceId: string;
  readonly client: DropshipEbayListingLifecycleClient;
}

export interface DropshipEbayListingRebuildRequest {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  readonly marketplaceConfig: Record<string, unknown>;
  readonly draft: EbayListingConnectorDraft;
}

const EBAY_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

/** Collaborators added after the positional ones; every field is optional at construction. */
export interface EbayDropshipListingPushProviderOptions {
  /**
   * Required for every eBay listing push (pushListing refuses without it, like the
   * fulfillment policy guard and managed locations): under canonical authority a
   * live managed listing needs its stock link before the first eBay write. The
   * replacement composition builds this provider without it and never pushes.
   */
  readonly stockReadiness?: DropshipEbayStockReadinessPort;
  /** Injected wait for the bounded PUBLICATION_SCOPE_BUSY retry (tests pass a recorder). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: { debug(event: Record<string, unknown>): void; warn(event: Record<string, unknown>): void };
}

const defaultScopeBusyLogger = {
  debug: (event: Record<string, unknown>) => console.debug(JSON.stringify({ level: "debug", ...event })),
  warn: (event: Record<string, unknown>) => console.warn(JSON.stringify({ level: "warn", ...event })),
};

export class EbayDropshipListingPushProvider implements DropshipMarketplaceListingPushProvider {
  private readonly tokenOwner: DropshipEbayTokenOwner;
  private readonly listingConnector = new EbayMarketplaceListingConnector();
  private readonly listingBuilder = new EbayListingBuilder();

  constructor(
    private readonly credentials: DropshipMarketplaceCredentialRepository,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly clock: Clock = { now: () => new Date() },
    private readonly fulfillmentPolicyGuard?: DropshipEbayFulfillmentPolicyGuard,
    private readonly managedLocations?: DropshipEbayManagedLocationProvider,
    private readonly quantityAdmission?: (credential: DropshipMarketplaceStoreCredentials) => EbayQuantityRequestAdmission,
    private readonly existingPublication?: DropshipEbayPushPublicationReader,
    private readonly options: EbayDropshipListingPushProviderOptions = {},
  ) {
    this.tokenOwner = new DropshipEbayTokenOwner({ credentials, fetchFn: fetchImpl, clock });
  }

  async pushListing(
    input: DropshipMarketplaceListingPushRequest,
  ): Promise<DropshipMarketplaceListingPushResult> {
    const stockReadiness = this.requiredStockReadiness();
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: "listing_push",
    });
    // Before any eBay call: legacy authority returns at once; canonical authority
    // refuses a positive push of a store that is not live + managed (plan F2 2.8).
    const stock = await stockReadiness.begin({ request: input, credential });
    const config = {
      ...parseEbayListingConfig(
        input.listingIntent.marketplaceConfig,
        credential.config,
      ),
      environment: resolveDropshipEbayProviderEnvironment(credential),
    };

    assertEbayReady(input, config);
    const preflight = await this.assertFulfillmentPolicyCompatible({ credential, config });
    await this.reconcileManagedLocation({ credential, config, preflight });
    const baseUrl = EBAY_BASE_URLS[config.environment];
    const draft = buildDropshipEbayListingDraft(
      input,
      config,
      this.listingBuilder,
    );
    // The shared connector refuses with EbayListingSyncError, which the worker
    // cannot classify; see rethrowConnectorFailure.
    const sku = draft.inventoryItems[0]?.sku;
    const connectorResult = await this.listingConnector.pushListing({
      client: this.createConnectorClient({ credential, config, baseUrl, correlation: {
        job_id: input.jobId, job_item_id: input.jobItemId, listing_id: input.listingId, product_variant_id: input.productVariantId } }),
      resolvePublishedIdentity: this.existingPublication
        ? discovered => this.existingPublication!.resolve({ ...input,
            listingIntent: { ...input.listingIntent, marketplaceConfig: { ...input.listingIntent.marketplaceConfig, marketplaceId: config.marketplaceId } } }, credential, discovered)
        : undefined,
      // After the connector matched the SKU's existing offers and proved any
      // published identity, before its first write: the stock link is made for
      // exactly the offer eBay will use, and a refusal leaves eBay untouched. An
      // automatic re-queue's run always passes through it, so it never adopts an
      // eBay listing the vendor listing did not record (review TW-1).
      beforeFirstMutation: stock.mustLink || input.automaticRetry === true
        ? resolved => stockReadiness.ensureLinked({ request: input, credential, environment: config.environment,
            sku: sku ?? "", resolved, ...(stock.mustLink ? {} : { linkStock: false }) })
        : undefined,
      draft: {
        productId: input.productVariantId,
        marketplaceId: config.marketplaceId,
        inventoryItems: draft.inventoryItems,
        offers: draft.offers,
        itemGroup: draft.itemGroup,
        publishMode:
          input.listingIntent.listingMode === "live" ? "publish" : "stage",
        hasExistingExternalIds: Boolean(
          input.existingExternalListingId || input.existingExternalOfferId,
        ),
        existingExternalProductId: input.existingExternalListingId,
        existingOfferIdsByVariantId: {
          [input.productVariantId]: input.existingExternalOfferId,
        },
        updateOfferAfterCreate: true,
      },
    }).catch((error: unknown) => this.rethrowConnectorFailure(credential, error));

    const offerId =
      connectorResult.externalOfferIds[input.productVariantId] ?? null;
    const listingId =
      connectorResult.externalProductId ?? input.existingExternalListingId;
    if (input.listingIntent.listingMode === "live" && !listingId) {
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_ID_REQUIRED",
        "eBay publish did not return a listing id.",
        { retryable: true },
      );
    }

    return {
      status: connectorResult.status,
      externalListingId: listingId ?? offerId!,
      externalOfferId: offerId,
      rawResult: {
        provider: "ebay",
        marketplaceId: config.marketplaceId,
        listingMode: input.listingIntent.listingMode,
        published: connectorResult.published,
      },
    };
  }

  async previewListingRebuild(
    input: DropshipEbayListingRebuildRequest & { readonly currentExternalListingId: string },
  ): Promise<EbayListingRebuildPreview> {
    const session = await this.createReplacementLifecycleClient(input);
    assertRebuildMarketplaceMatches(input.draft, session.marketplaceId);
    return this.listingConnector.previewListingRebuild({
      client: session.client,
      draft: input.draft,
      currentExternalListingId: input.currentExternalListingId,
    });
  }

  async executeListingRebuild(
    input: DropshipEbayListingRebuildRequest & { readonly preview: EbayListingRebuildPreview },
  ): Promise<EbayListingRebuildResult> {
    const session = await this.createReplacementSession(input);
    assertRebuildMarketplaceMatches(input.draft, session.marketplaceId);
    return this.listingConnector.executeListingRebuild({
      client: session.client,
      draft: input.draft,
      preview: input.preview,
      resolvePublishedIdentity: this.existingPublication
        ? discovered => this.existingPublication!.resolveRebuild(input, session.credential, discovered)
        : undefined,
    });
  }
  async createReplacementLifecycleClient(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceConfig: Record<string, unknown>;
  }): Promise<DropshipEbayReplacementSession> {
    const { marketplaceId,client } = await this.createReplacementSession(input);
    return { marketplaceId,client };
  }
  private async createReplacementSession(input: {
    vendorId: number;
    storeConnectionId: number;
    marketplaceConfig: Record<string, unknown>;
  }): Promise<DropshipEbayReplacementSession & { credential: DropshipMarketplaceStoreCredentials }> {
    const credential = await this.tokenOwner.loadFreshForStoreConnection({
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      operation: "listing_replacement",
    });
    const config = {
      ...parseEbayListingConfig(
        input.marketplaceConfig,
        credential.config,
      ),
      environment: resolveDropshipEbayProviderEnvironment(credential),
    };
    await this.assertFulfillmentPolicyCompatible({ credential, config });
    return {
      credential,
      marketplaceId: config.marketplaceId,
      client: this.createConnectorClient({
        credential,
        config,
        baseUrl: EBAY_BASE_URLS[config.environment],
      }),
    };
  }
  private async assertFulfillmentPolicyCompatible(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
  }): Promise<DropshipEbayFulfillmentPolicyPreflight> {
    if (!this.fulfillmentPolicyGuard) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_GUARD_REQUIRED",
        "eBay listing push requires fulfillment policy compatibility validation.",
        { retryable: false },
      );
    }
    const preflight = await this.fulfillmentPolicyGuard.evaluateWithAccessToken({
      storeConnectionId: input.credential.storeConnectionId,
      marketplaceId: input.config.marketplaceId,
      fulfillmentPolicyId: input.config.businessPolicies.fulfillmentPolicyId,
      accessToken: input.credential.accessToken,
      environment: input.config.environment,
      fresh: true,
    });
    if (!preflight.compatible) {
      throw new DropshipError(
        "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
        "The selected eBay fulfillment policy exceeds current Card Shellz fulfillment capabilities.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          fulfillmentPolicyId: preflight.fulfillmentPolicyId,
          capabilityEvidenceHash: preflight.capabilityEvidenceHash,
          issues: preflight.issues,
          retryable: false,
        },
      );
    }
    return preflight;
  }
  private async reconcileManagedLocation(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    preflight: DropshipEbayFulfillmentPolicyPreflight;
  }): Promise<void> {
    if (!this.managedLocations) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_PROVIDER_REQUIRED",
        "eBay listing push requires the Card Shellz-managed inventory location provider.",
        { retryable: false },
      );
    }
    const originWarehouseId = input.preflight.originWarehouseId;
    if (!Number.isSafeInteger(originWarehouseId) || (originWarehouseId ?? 0) <= 0) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_WAREHOUSE_REQUIRED",
        "eBay listing push requires a verified Card Shellz origin warehouse.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          originWarehouseId,
          retryable: false,
        },
      );
    }
    const location = await this.managedLocations.ensureWithAccessToken({
      accessToken: input.credential.accessToken,
      environment: input.config.environment,
      storeConnectionId: input.credential.storeConnectionId,
      originWarehouseId: originWarehouseId as number,
    });
    if (location.merchantLocationKey !== input.config.merchantLocationKey) {
      throw new DropshipError(
        "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
        // This text reaches the vendor's failure email as is
        // (dropship-listing-push-worker-service.ts, describeFailedListingPushJob).
        // Interim (PR 12 PROPOSAL): it names the step's [Update now] under the
        // Shipping policy row; the old setup panel's button is gone (verify VC1).
        "Card Shellz needs to update where your eBay listings ship from. Open Listing settings, choose Update now under Shipping policy, then queue the listing again.",
        {
          storeConnectionId: input.credential.storeConnectionId,
          originWarehouseId,
          retryable: false,
        },
      );
    }
  }
  private createConnectorClient(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    baseUrl: string;
    /** Push ids for the quantity request's own log lines (absent for replacement sessions). */
    correlation?: Readonly<Record<string, unknown>>;
  }): DropshipEbayListingLifecycleClient {
    return {
      getInventoryItemGroup: async (groupKey) => {
        try {
          return await this.requestEbay<
            EbayInventoryItemGroup & { variantSKUs?: string[] }
          >({
            credential: input.credential,
            config: input.config,
            correlation: input.correlation,
            method: "GET",
            path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
            baseUrl: input.baseUrl,
          });
        } catch (error: unknown) {
          if (error instanceof DropshipError && error.context?.status === 404)
            return null;
          throw error;
        }
      },
      getInventoryItem: async (sku) => {
        try {
          return await this.requestEbay<EbayInventoryItem>({
            credential: input.credential,
            config: input.config,
            correlation: input.correlation,
            method: "GET",
            path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
            baseUrl: input.baseUrl,
          });
        } catch (error: unknown) {
          if (isEbayNotFound(error)) return null;
          throw error;
        }
      },
      createOrReplaceInventoryItem: async (sku, item) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "PUT",
          path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
          body: item,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      getOffers: async (sku, marketplaceId) => {
        let result: EbayOfferResponse;
        try {
          result = await this.requestEbay<EbayOfferResponse>({
            credential: input.credential,
            config: input.config,
            correlation: input.correlation,
            method: "GET",
            path: `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`,
            baseUrl: input.baseUrl,
          });
        } catch (error: unknown) {
          // A SKU with no offer yet answers 404 (25713 "This Offer is not
          // available"), not an empty list; the channel client reads it the
          // same way. Every other refusal still fails the push.
          if (isEbayNotFound(error)) return { offers: [] };
          throw error;
        }
        return {
          offers: (result.offers ?? [])
            .filter(
              (
                offer,
              ): offer is EbayOffer & {
                offerId: string;
                listingId?: string;
                status?: string;
              } => Boolean(offer.offerId),
            )
            .map(
              (offer) =>
                offer as EbayOffer & { offerId: string; listingId?: string },
            ),
        };
      },
      createOffer: async (offer) => {
        const result = await this.requestEbay<{ offerId?: string }>({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: "/sell/inventory/v1/offer",
          body: offer,
          baseUrl: input.baseUrl,
        });
        if (!result.offerId) {
          throw new DropshipError(
            "DROPSHIP_EBAY_OFFER_ID_REQUIRED",
            "eBay create offer did not return an offer id.",
            { retryable: true },
          );
        }
        return result.offerId;
      },
      updateOffer: async (offerId, offer) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "PUT",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
          body: offer,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      createOrReplaceInventoryItemGroup: async (groupKey, group) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "PUT",
          path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
          body: { ...group, inventoryItemGroupKey: groupKey },
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      deleteInventoryItemGroup: async (groupKey) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "DELETE",
          path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
          expectNoContent: true,
          baseUrl: input.baseUrl,
        });
      },
      publishOffer: async (offerId) => {
        return await this.requestEbay<{ listingId?: string }>({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
          baseUrl: input.baseUrl,
        });
      },
      publishOfferByInventoryItemGroup: async (groupKey, marketplaceId) => {
        return await this.requestEbay<{ listingId?: string }>({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
          body: { inventoryItemGroupKey: groupKey, marketplaceId },
          baseUrl: input.baseUrl,
        });
      },
      bulkUpdatePriceQuantity: async (body: EbayBulkPriceQuantityRequest) => {
        return await this.requestEbay<EbayBulkPriceQuantityResponse>({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: "/sell/inventory/v1/bulk_update_price_quantity",
          body,
          baseUrl: input.baseUrl,
        });
      },
      withdrawOffer: async (offerId) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`,
          baseUrl: input.baseUrl,
        });
      },
      withdrawOfferByInventoryItemGroup: async (groupKey, marketplaceId) => {
        await this.requestEbay({
          credential: input.credential,
          config: input.config,
          correlation: input.correlation,
          method: "POST",
          path: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
          body: { inventoryItemGroupKey: groupKey, marketplaceId },
          baseUrl: input.baseUrl,
        });
      },
    };
  }

  private async requestEbay<T = Record<string, unknown>>(input: {
    credential: DropshipMarketplaceStoreCredentials;
    config: EbayListingConfig;
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    expectNoContent?: boolean;
    baseUrl: string;
    correlation?: Readonly<Record<string, unknown>>;
  }): Promise<T> {
    if (ebayQuantityMutationIdentity(input.method, input.path, input.body)) {
      if (!this.quantityAdmission) throw new DropshipError("QUANTITY_PUBLICATION_ADMISSION_REQUIRED", "eBay listing quantity writes require an admitted owner.", { retryable: false });
      const admission = this.quantityAdmission(input.credential);
      // PUBLICATION_SCOPE_BUSY is raised when the exact SKU's provider scope
      // try-lock is held (often the outbox draining the row the stock link just
      // queued), before planning or any provider I/O, and its durable catch-up
      // is an upsert. Repeating the same request is therefore safe; it is
      // bounded, and the last refusal is rethrown unchanged.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await executeAdmittedEbayQuantityRequest<T>(input, admission, request =>
            this.requestEbayUnadmitted({ ...input, ...request, method: request.method as typeof input.method,
              expectNoContent: request.expectNoContent }));
        } catch (error) {
          // A multi-row bulk request is admitted row by row; a later row's refusal
          // can follow an earlier row's provider write, so it is never repeated here.
          if (!isPublicationScopeBusy(error) || isMultiRowBulkRequest(input)) throw error;
          const context = { action: "dropship.listing_push.quantity_request", error_code: PUBLICATION_SCOPE_BUSY_CODE,
            vendor_id: input.credential.vendorId, store_connection_id: input.credential.storeConnectionId,
            ...input.correlation, endpoint: `${input.method} ${input.path}`, attempt };
          if (attempt > PUBLICATION_SCOPE_BUSY_BACKOFF_MS.length) {
            this.scopeBusyLogger().warn({ ...context, outcome: "gave_up", classification: "transient",
              message: "The exact eBay SKU stayed busy after every bounded retry; the push fails retryable." });
            throw error;
          }
          const waitMs = PUBLICATION_SCOPE_BUSY_BACKOFF_MS[attempt - 1]!;
          this.scopeBusyLogger().debug({ ...context, outcome: "retry", wait_ms: waitMs });
          await this.sleep(waitMs);
        }
      }
    }
    return this.requestEbayUnadmitted(input);
  }

  private requiredStockReadiness(): DropshipEbayStockReadinessPort {
    // Fail closed like the other required push collaborators: without the port a
    // canonical push could write quantity to an unlinked listing.
    if (!this.options.stockReadiness) throw stockLinkError(stockLinkRefusal("DROPSHIP_STOCK_READINESS_REQUIRED"));
    return this.options.stockReadiness;
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
  }

  private scopeBusyLogger() {
    return this.options.logger ?? defaultScopeBusyLogger;
  }

  private async requestEbayUnadmitted<T = Record<string, unknown>>(input: {
    credential: DropshipMarketplaceStoreCredentials; config: EbayListingConfig;
    method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown;
    expectNoContent?: boolean; baseUrl: string;
  }): Promise<T> {
    if (ebayQuantityMutationIdentity(input.method,input.path,input.body)) {
      return executeEbayQuantityHttp<T>({ url: `${input.baseUrl}${input.path}`,method: input.method,path: input.path,body: input.body,
        headers: ebaySellRequestHeaders({ accessToken: input.credential.accessToken, method: input.method, marketplaceId: input.config.marketplaceId }),
        request: this.fetchImpl,now: () => this.clock.now(),
        onFailure: (status,text) => this.throwListingHttpError(input.credential,status,text,`${input.method} ${input.path}`) });
    }
    const deadline = createProviderRequestDeadline();
    try {
    const response = await this.fetchImpl(`${input.baseUrl}${input.path}`, {
      method: input.method,
      signal: deadline.signal,
      headers: ebaySellRequestHeaders({ accessToken: input.credential.accessToken, method: input.method, marketplaceId: input.config.marketplaceId }),
      body: input.body ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.text();
    if (response.status === 204 || input.expectNoContent) {
      if (response.ok) return undefined as T;
    }
    if (!response.ok) {
      await this.throwListingHttpError(input.credential,response.status,text,`${input.method} ${input.path}`);
    }
    return parseEbayJson<T>({
      text,
      code: "DROPSHIP_EBAY_LISTING_PUSH_INVALID_RESPONSE",
      message: "eBay listing push returned invalid JSON.",
    });
    } finally { deadline.dispose(); }
  }

  /**
   * Translate a shared connector refusal so the worker files permanent ones as
   * not retryable (dropship-ebay-connector-errors.ts).
   *
   * The identity observer borrows the stored access token from the same token
   * owner, right after this provider's own GET succeeded with it, and reports a
   * 401 as EBAY_AUTH_REQUIRED. Record that rejection exactly as
   * throwListingHttpError records a 401 on this provider's own calls, so the
   * next attempt refreshes the token instead of reusing it; the error stays
   * retryable. The record is guarded by the credential this push loaded: if the
   * stored token has changed since, the repository refuses with
   * DROPSHIP_CREDENTIAL_CHANGED (retryable) and that refusal is what surfaces,
   * as it does on the HTTP path. Nothing is swallowed either way.
   */
  private async rethrowConnectorFailure(credential: DropshipMarketplaceStoreCredentials,error: unknown): Promise<never> {
    const translated = translateEbayConnectorError(error);
    if (isEbayConnectorAccessTokenRejection(translated)) {
      await recordEbayAccessTokenRejection({
        credentials: this.credentials,
        credential,
        status: EBAY_CONNECTOR_ACCESS_TOKEN_REJECTED_STATUS,
        failureCode: translated.code,
        message: translated.message,
        now: this.clock.now(),
      });
    }
    throw translated;
  }

  private async throwListingHttpError(credential: DropshipMarketplaceStoreCredentials,status: number,text: string,endpoint: string): Promise<never> {
      const accessTokenRejected = isEbayResourceAuthFailureStatus(status);
      // eBay's own reason travels with the failure: it is the only thing that
      // tells an operator or vendor what to change before trying again.
      const providerErrors = parseEbayErrorBody(text);
      const reason = describeEbayErrors(providerErrors);
      const message = reason
        ? `eBay listing push failed with HTTP ${status}: ${reason}`
        : `eBay listing push failed with HTTP ${status}.`;
      if (accessTokenRejected) {
        await recordEbayAccessTokenRejection({
          credentials: this.credentials,
          credential,
          status,
          failureCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
          message,
          now: this.clock.now(),
        });
      }
      throw new DropshipError(
        "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
        message,
        {
          retryable: accessTokenRejected || status === 429 || status >= 500,
          status,
          // Which eBay call refused: the reason alone does not say.
          endpoint,
          body: text.slice(0, 1000),
          providerErrors,
        },
      );
  }

}

function isEbayNotFound(error: unknown): boolean {
  return error instanceof DropshipError && error.context?.status === 404;
}

function isMultiRowBulkRequest(input: { path: string; body?: unknown }): boolean {
  const requests = input.body && typeof input.body === "object" ? (input.body as { requests?: unknown }).requests : undefined;
  return input.path.includes("bulk_update_price_quantity") && Array.isArray(requests) && requests.length > 1;
}

/** The inventory admission's own refusal (QuantityPublicationAdmissionError), matched by name and code
 * so this provider does not import an inventory-planning internal. */
function isPublicationScopeBusy(error: unknown): boolean {
  return error instanceof Error && error.name === "QuantityPublicationAdmissionError"
    && (error as { code?: unknown }).code === PUBLICATION_SCOPE_BUSY_CODE;
}

function assertRebuildMarketplaceMatches(
  draft: EbayListingConnectorDraft,
  configuredMarketplaceId: string,
): void {
  if (draft.marketplaceId !== configuredMarketplaceId) {
    throw new DropshipError(
      "DROPSHIP_EBAY_REBUILD_MARKETPLACE_MISMATCH",
      "The requested rebuild marketplace does not match the store connection.",
      {
        requestedMarketplaceId: draft.marketplaceId,
        configuredMarketplaceId,
        retryable: false,
      },
    );
  }
}
export function parseEbayListingConfig(
  intentConfig: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): EbayListingConfig {
  const config = {
    ...connectionConfig,
    ...intentConfig,
  };
  const businessPolicies = recordFromConfig(config, "businessPolicies");
  const parsed = {
    marketplaceId: requiredConfigString(config, "marketplaceId"),
    merchantLocationKey: requiredConfigString(config, "merchantLocationKey"),
    businessPolicies: {
      paymentPolicyId: requiredConfigString(
        businessPolicies,
        "paymentPolicyId",
      ),
      returnPolicyId: requiredConfigString(businessPolicies, "returnPolicyId"),
      fulfillmentPolicyId: requiredConfigString(
        businessPolicies,
        "fulfillmentPolicyId",
      ),
    },
    environment:
      config.environment === "sandbox"
        ? ("sandbox" as const)
        : ("production" as const),
  };
  return parsed;
}

function assertEbayReady(
  input: DropshipMarketplaceListingPushRequest,
  config: EbayListingConfig,
): void {
  const intent = input.listingIntent;
  if (!intent.sku?.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_SKU_REQUIRED",
      "eBay listing push requires a SKU.",
      { retryable: false },
    );
  }
  if (intent.imageUrls.length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_IMAGE_REQUIRED",
      "eBay listing push requires at least one product image.",
      {
        retryable: false,
      },
    );
  }
  if (!isPublishableEbayWeightGrams(intent.weightGrams)) {
    throw new DropshipError(
      "DROPSHIP_EBAY_PACKAGE_WEIGHT_REQUIRED",
      "eBay listing push requires a positive catalog variant weight.",
      { productVariantId: input.productVariantId, retryable: false },
    );
  }
  if (!intent.marketplaceCategoryId?.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_BROWSE_CATEGORY_REQUIRED",
      "eBay listing push requires the catalog product's eBay browse category.",
      {
        productVariantId: input.productVariantId,
        retryable: false,
      },
    );
  }
  if (!config.merchantLocationKey) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED",
      "eBay listing configuration is incomplete.",
      {
        retryable: false,
      },
    );
  }
}

/**
 * Any weight above 0 can be listed. The catalog keeps fractions of a gram
 * (`weight_grams` is numeric(10,2) since migration 185, so 1 lb is 453.59 g),
 * and the eBay builder sends whole grams, never less than 1
 * (`ebay-listing-builder.ts`). The listing preview accepts the same weights
 * (`weight_grams > 0`, `getPackageReadiness`). Not finite would serialize as
 * null, so it is refused.
 */
function isPublishableEbayWeightGrams(weightGrams: number | null): weightGrams is number {
  return typeof weightGrams === "number" && Number.isFinite(weightGrams) && weightGrams > 0;
}

export function buildDropshipEbayListingDraft(
  input: Pick<DropshipMarketplaceListingPushRequest, "productVariantId" | "listingIntent" | "existingExternalOfferId">,
  config: EbayListingConfig,
  listingBuilder: EbayListingBuilder,
) {
  const intent = input.listingIntent;
  const marketplaceCategoryId = intent.marketplaceCategoryId?.trim();
  if (!marketplaceCategoryId) {
    throw new DropshipError(
      "DROPSHIP_EBAY_BROWSE_CATEGORY_REQUIRED",
      "eBay listing push requires the catalog product's eBay browse category.",
      { productVariantId: input.productVariantId, retryable: false },
    );
  }
  const sku = intent.sku?.trim();
  if (!sku) {
    throw new DropshipError(
      "DROPSHIP_EBAY_SKU_REQUIRED",
      "eBay listing push requires a SKU.",
      {
        retryable: false,
      },
    );
  }
  const listing: ChannelListingPayload = {
    productId: input.productVariantId,
    title: intent.title,
    description: intent.description ?? intent.title,
    category: intent.category,
    tags: null,
    status: "active",
    variants: [
      {
        variantId: input.productVariantId,
        sku,
        name: intent.title,
        barcode: null,
        gtin: intent.gtin,
        // eBay refuses to publish with a Brand but no MPN; the placeholder
        // stands in for products the catalog has no part number for.
        mpn: resolveEbayMpn({ mpn: intent.mpn, itemSpecifics: intent.itemSpecifics }).mpn,
        weightGrams: intent.weightGrams,
        priceCents: intent.priceCents,
        compareAtPriceCents: null,
        isListed: true,
        externalVariantId: input.existingExternalOfferId,
        externalInventoryItemId: null,
      },
    ],
    images: ebayListingImagesFromUrls(intent.imageUrls),
    metadata: {
      itemSpecifics: buildEbayAspects(input),
    },
  };
  const sharedConfig: SharedEbayListingConfig = {
    merchantLocationKey: config.merchantLocationKey,
    marketplaceId: config.marketplaceId,
    listingPolicies: config.businessPolicies,
  };
  const quantityByVariantId = new Map([
    [input.productVariantId, intent.quantity],
  ]);

  return listingBuilder.buildListingDraft(listing, sharedConfig, {
    availableQuantityByVariantId: quantityByVariantId,
    categoryIdOverride: marketplaceCategoryId,
    conditionOverride: mapEbayCondition(intent.condition),
    descriptionHtmlOverride: intent.description ?? intent.title,
    includeOfferTax: false,
    requirePackageWeight: true,
    storeCategoryNames: intent.storeCategoryNames,
  });
}

function buildEbayAspects(
  input: Pick<DropshipMarketplaceListingPushRequest, "listingIntent">,
): Record<string, string[]> {
  const raw = input.listingIntent.itemSpecifics ?? {};
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      const values = value.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      );
      if (values.length > 0) aspects[key] = values;
    } else if (typeof value === "string" && value.trim()) {
      aspects[key] = [value.trim()];
    }
  }
  if (input.listingIntent.brand && !aspects.Brand) {
    aspects.Brand = [input.listingIntent.brand];
  }
  return aspects;
}

function mapEbayCondition(
  condition: string | null,
): EbayInventoryItem["condition"] {
  const normalized = condition?.trim().toLowerCase();
  if (!normalized || normalized === "new") {
    return "NEW";
  }
  if (normalized === "used") {
    return "USED_GOOD";
  }
  const candidate = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return isEbayCondition(candidate) ? candidate : "NEW";
}

function isEbayCondition(
  value: string,
): value is EbayInventoryItem["condition"] {
  return [
    "NEW",
    "LIKE_NEW",
    "NEW_OTHER",
    "NEW_WITH_DEFECTS",
    "MANUFACTURER_REFURBISHED",
    "CERTIFIED_REFURBISHED",
    "EXCELLENT_REFURBISHED",
    "VERY_GOOD_REFURBISHED",
    "GOOD_REFURBISHED",
    "SELLER_REFURBISHED",
    "USED_EXCELLENT",
    "USED_VERY_GOOD",
    "USED_GOOD",
    "USED_ACCEPTABLE",
    "FOR_PARTS_OR_NOT_WORKING",
  ].includes(value);
}

function requiredConfigString(
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_CONFIG_REQUIRED",
      "eBay listing configuration is incomplete.",
      {
        missingKey: key,
        retryable: false,
      },
    );
  }
  return value.trim();
}

function recordFromConfig(
  config: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = config[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseEbayJson<T>(input: {
  text: string;
  code: string;
  message: string;
}): T {
  if (!input.text) return {} as T;
  try {
    return JSON.parse(input.text) as T;
  } catch {
    throw new DropshipError(input.code, input.message, { retryable: true });
  }
}
