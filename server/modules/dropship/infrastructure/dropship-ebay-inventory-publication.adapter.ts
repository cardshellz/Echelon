import type { Pool } from "pg";
import { ebaySellRequestHeaders } from "./ebay-sell-headers";
import { executeEbayQuantityHttpResponse, EbayQuantityResponseUncertainError } from "../../channels/adapters/ebay/ebay-quantity-http";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "../../channels/provider-request-limits";
import {
  EbayInventoryQuantityError, ebayInventoryMarketplace, ebayInventoryOffersPath,
  publishEbayInventoryQuantity, readEbayInventoryQuantity, EbayInventoryQuantityPreflightError, type EbayInventoryQuantityClient,
  type EbayResolvedPublishedOffer,
} from "../../channels/adapters/ebay/ebay-inventory-quantity";
import { observeEbayQuantityRequest } from "../../inventory-planning/application/quantity-provider-request-evidence";
import { readDropshipEbayPublishedQuantities } from "../../inventory-planning/quantity-publication";
import { logger as platformLogger } from "../../../platform/observability/logger";

import { pool as defaultPool } from "../../../db";
import {
  InventoryPublicationTransportConfigurationError,
  InventoryPublicationTransportError,
  InventoryPublicationNotSentError,
  type AbsoluteInventoryPublicationRequest,
  type AbsoluteInventoryPublicationResult,
  type AbsoluteInventoryReadRequest,
  type AbsoluteInventoryReadResult,
  type InventoryPublicationTransportAdapter,
} from "../../inventory-planning/application/inventory-publication-transport";
import { DropshipError } from "../domain/errors";
import {
  chooseQuantityBaseline,
  decideQuantityPreWrite,
  quantitySalesWindows,
  type QuantityBaseline,
} from "../domain/marketplace-quantity-decision";
import { MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";
import { hasUnsettledPushAttempt } from "../domain/marketplace-sync-history";
import { marketplacePublishBaseline } from "../domain/marketplace-sync-sweep";
import { sumMarketplaceSalesWithClient } from "./dropship-listing-marketplace-sales.repository";
import {
  markListingsMarketplaceSyncDueWithClient,
  readMarketplaceListingSyncStateWithClient,
  readMarketplaceSyncEventsWithClient,
} from "./dropship-marketplace-listing-sync-state.repository";
import {
  isEbayResourceAuthFailureStatus,
} from "./dropship-ebay-auth-failure";
import {
  RefreshingDropshipEbayRegistrationCredentialProvider,
  resolveDropshipEbayProviderEnvironment,
  type DropshipEbayRegistrationCredentialProvider,
} from "./dropship-ebay-registration-credentials";
import {
  createDropshipMarketplaceCredentialRepositoryFromEnv,
  type DropshipMarketplaceCredentialRepository,
  type DropshipMarketplaceStoreCredentials,
} from "./dropship-marketplace-credentials";

const EBAY_BASE_URLS = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
} as const;

interface DropshipInventoryPublicationDestination {
  storeConnectionId: number;
  vendorId: number;
  providerKey: string;
  status: string;
}

export interface DropshipInventoryPublicationDestinationReader {
  load(storeConnectionId: number): Promise<DropshipInventoryPublicationDestination | null>;
}

export class PgDropshipInventoryPublicationDestinationReader
  implements DropshipInventoryPublicationDestinationReader
{
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async load(storeConnectionId: number): Promise<DropshipInventoryPublicationDestination | null> {
    const client = await this.connectionPool.connect();
    try {
      const row = (await client.query<{
        id: number;
        vendor_id: number;
        platform: string;
        status: string;
      }>(
        `SELECT id, vendor_id, platform, status
         FROM dropship.dropship_store_connections
         WHERE id = $1`,
        [storeConnectionId],
      )).rows[0];
      if (!row) return null;
      return {
        storeConnectionId: positiveInteger(row.id, "storeConnectionId"),
        vendorId: positiveInteger(row.vendor_id, "vendorId"),
        providerKey: nonblank(row.platform, "providerKey").toLowerCase(),
        status: nonblank(row.status, "status"),
      };
    } finally {
      client.release();
    }
  }
}

/** What Dropship recorded for the store variant's eBay listing, and whether a push of it is running now. */
export interface DropshipInventoryListingIdentity {
  /** The offer the last completed push recorded; null when no push has completed. */
  externalOfferId: string | null;
  /** A queued or processing push item exists for this store and variant. */
  pushInFlight: boolean;
}

export interface DropshipInventoryListingIdentityReader {
  load(storeConnectionId: number, productVariantId: number): Promise<DropshipInventoryListingIdentity>;
}

/** Dropship-owned rows only (dropship_vendor_listings is unique per store and variant). */
export class PgDropshipInventoryListingIdentityReader implements DropshipInventoryListingIdentityReader {
  constructor(private readonly database: Pick<Pool, "query"> = defaultPool) {}

  async load(storeConnectionId: number, productVariantId: number): Promise<DropshipInventoryListingIdentity> {
    const row = (await this.database.query<{ external_offer_id: string | null; push_in_flight: boolean }>(
      `SELECT
         (SELECT NULLIF(BTRIM(vl.external_offer_id), '') FROM dropship.dropship_vendor_listings vl
          WHERE vl.store_connection_id = $1 AND vl.product_variant_id = $2 AND vl.platform = 'ebay') AS external_offer_id,
         EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji
           JOIN dropship.dropship_listing_push_jobs j ON j.id = ji.job_id
           WHERE j.store_connection_id = $1 AND ji.product_variant_id = $2
             AND j.job_type = 'push' AND ji.action = 'push'
             AND j.status IN ('queued', 'processing') AND ji.status IN ('queued', 'processing')) AS push_in_flight`,
      [storeConnectionId, productVariantId],
    )).rows[0];
    if (!row || typeof row.push_in_flight !== "boolean") {
      throw configurationError("DROPSHIP_EBAY_LISTING_IDENTITY_INVALID", "The Dropship listing identity read returned no row.",
        { storeConnectionId, productVariantId });
    }
    return { externalOfferId: row.external_offer_id ?? null, pushInFlight: row.push_in_flight };
  }
}

/**
 * What the pre-write quantity guard (eBay sync-back owner rule 1, plan v4
 * §6.4 SB31, review OR-2) judges a write by: Card Shellz's own last settled
 * quantity on eBay (B, not counting the row being written), the sales since,
 * the store's sales ledger start and whether the listing is live.
 */
export interface DropshipQuantityPreWriteFacts {
  listingId: number;
  baseline: QuantityBaseline | null;
  salesAll: number;
  salesLedgerSince: Date | null;
  listingLive: boolean;
}

export interface DropshipQuantityPreWriteGuardReader {
  /** Null when the size has no Dropship eBay listing in the store (nothing to judge). */
  load(storeConnectionId: number, productVariantId: number, at: Date): Promise<DropshipQuantityPreWriteFacts | null>;
  /** After a refusal: the sync job reads the listing first on its next run, to decide eBay's number. */
  markDue(listingId: number): Promise<void>;
}

/**
 * The guard's facts from Dropship's own rows and inventory planning's
 * published reader, in one read-only snapshot. Under this transport the
 * authority is canonical (it is inventory planning's outbox transport), so B
 * is the newer of the last completed push and IP's newest settled row, with
 * the row being written now left out (`excludeLeased`), as the sync job's
 * rule makes it (marketplacePublishBaseline, chooseQuantityBaseline).
 */
export class PgDropshipQuantityPreWriteGuardReader implements DropshipQuantityPreWriteGuardReader {
  constructor(private readonly database: Pick<Pool, "connect"> = defaultPool) {}

  async load(storeConnectionId: number, productVariantId: number, at: Date): Promise<DropshipQuantityPreWriteFacts | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const found = (await client.query<{ id: number; marketplace_sales_ledger_since: Date | null; open: boolean }>(`
        SELECT l.id, sc.marketplace_sales_ledger_since,
          EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji WHERE ji.listing_id = l.id
            AND ji.status IN ('queued', 'processing')) AS open
        FROM dropship.dropship_vendor_listings l JOIN dropship.dropship_store_connections sc ON sc.id = l.store_connection_id
        WHERE l.store_connection_id = $1 AND l.product_variant_id = $2 AND l.platform = 'ebay'`,
      [storeConnectionId, productVariantId])).rows[0];
      const state = found ? await readMarketplaceListingSyncStateWithClient(client, found.id) : null;
      if (!found || !state) {
        await client.query("COMMIT");
        return null;
      }
      const events = await readMarketplaceSyncEventsWithClient(client, state.listingId);
      const [published] = await readDropshipEbayPublishedQuantities(client, { storeConnectionId, productVariantIds: [productVariantId],
        excludeLeased: true });
      const baseline = chooseQuantityBaseline(marketplacePublishBaseline({ authority: "canonical",
        push: { pushedQuantity: state.pushedQuantity, lastPushedAt: state.lastPushedAt, hasOpenPushItem: found.open,
          hasUnsettledAttempt: hasUnsettledPushAttempt(events) },
        published: published ? { desiredQuantity: published.desiredQuantity, settledAt: published.settledAt } : null,
      }), state.quantityBaseline);
      const sales = baseline && baseline.at.getTime() <= at.getTime()
        ? await sumMarketplaceSalesWithClient(client, { listingId: state.listingId, ...quantitySalesWindows(baseline.at, at) })
        : { all: 0, live: 0 };
      await client.query("COMMIT");
      return { listingId: state.listingId, baseline, salesAll: sales.all, salesLedgerSince: found.marketplace_sales_ledger_since,
        listingLive: state.status !== "ended" && !state.issueCodes.includes("ended_out_of_stock") };
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        // The read's own error is the one that matters; the rollback failure is logged so it is not lost.
        platformLogger.warn("dropship.ebay_inventory.quantity_guard_rollback_failed", { error_code: "DROPSHIP_QUANTITY_GUARD_ROLLBACK_FAILED",
          store_connection_id: storeConnectionId, product_variant_id: productVariantId,
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) });
      });
      throw error;
    } finally {
      client.release();
    }
  }

  async markDue(listingId: number): Promise<void> {
    const client = await this.database.connect();
    try {
      await markListingsMarketplaceSyncDueWithClient(client, [listingId]);
    } finally {
      client.release();
    }
  }
}

/** Raised (not sent, retryable) while a push of the variant is still creating or publishing its offer: nothing is on sale yet. */
export const DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT = "DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT";
/**
 * Raised (not sent, retryable) while a push of the variant runs and eBay already
 * shows one PUBLISHED offer for the SKU that is not the listing's recorded one
 * (none recorded yet, or the push is replacing it). Unlike
 * DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT something is on sale: if the outbox gives
 * up on the row (its attempt cap) and the push then ends without writing, that
 * offer keeps its last quantity, so ops-health counts this dead letter (review
 * AV1-1, dropship-stock-destination-health DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED).
 * 44 characters: last_error_class is varchar(60).
 */
export const DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT = "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT";
/** Raised (not sent, dead letter) when the one PUBLISHED offer is not the listing's recorded offer. */
export const DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED = "DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED";
/** Raised (not sent, dead letter) when no push recorded an offer and none is running. */
export const DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN = "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN";

/**
 * eBay transport for a Dropship-owned store. It accepts an already-planned
 * absolute quantity and never reads ATP, allocation policy, or warehouse data.
 *
 * Offer identity (plan F2 2.9): a quantity is only ever written to the offer the
 * listing's own completed push recorded. While a push of the variant is queued or
 * processing (its stock link may have queued this row before the offer exists or
 * is recorded), a missing or unrecorded offer defers the row as retryable; the
 * outbox retries it with its own bounded backoff.
 */
export class EbayDropshipInventoryPublicationTransportAdapter
  implements InventoryPublicationTransportAdapter
{
  readonly destinationKind = "dropship_store_connection" as const;
  readonly providerKey = "ebay";
  readonly supportedScopeTypes = ["account"] as const;

  constructor(
    private readonly destinations: DropshipInventoryPublicationDestinationReader,
    private readonly credentials: DropshipEbayRegistrationCredentialProvider,
    private readonly credentialHealth: Pick<DropshipMarketplaceCredentialRepository, "recordAuthFailure">,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: { now(): Date } = { now: () => new Date() },
    private readonly listingIdentities?: DropshipInventoryListingIdentityReader,
    /** Absent: no quantity guard, every write goes as before (owner rule 1 then relies on the sync job alone). */
    private readonly quantityGuard?: DropshipQuantityPreWriteGuardReader,
  ) {}

  async publishAbsolute(
    request: AbsoluteInventoryPublicationRequest,
  ): Promise<AbsoluteInventoryPublicationResult> {
    let client: EbayInventoryQuantityClient;
    let sku: string;
    let marketplace: string;
    let identity: DropshipInventoryListingIdentity;
    let guard: DropshipQuantityPreWriteFacts | null;
    const at = this.clock.now();
    try {
      const context = await this.loadContext(request);
      sku = exactEbayInventoryItemKey(request);
      marketplace = ebayInventoryMarketplace(context.credential.config.marketplaceId);
      client = this.quantityClient(context);
      identity = context.identity;
      guard = this.quantityGuard
        ? await this.quantityGuard.load(context.destination.storeConnectionId, request.productVariantId, at) : null;
    } catch (error) { throw translateQuantityError(new EbayInventoryQuantityPreflightError(error)); }
    try {
      const response = await publishEbayInventoryQuantity(client, sku, marketplace, request.desiredQuantity,
        { expectOffer: offer => {
          assertRecordedOffer(offer, identity, request);
          assertQuantityWriteAllowed(offer, guard, request, at);
        } });
      return { publishedQuantity: request.desiredQuantity, providerResponse: response };
    } catch (error) {
      const translated = deferWhilePushInFlight(translateQuantityError(error), identity, request);
      if (guard && isQuantityGuardRefusal(translated)) await this.markDueAfterRefusal(guard.listingId, request);
      throw translated;
    }
  }

  /**
   * The refusal already proved nothing was sent and the outbox retries the row
   * (bounded); marking the listing due only brings the sync job's decision
   * sooner, so a failure here is logged and the refusal still stands.
   */
  private async markDueAfterRefusal(listingId: number, request: AbsoluteInventoryPublicationRequest): Promise<void> {
    try {
      await this.quantityGuard!.markDue(listingId);
    } catch (error) {
      platformLogger.warn("dropship.ebay_inventory.quantity_guard_mark_due_failed", { error_code: "DROPSHIP_QUANTITY_GUARD_MARK_DUE_FAILED",
        listing_id: listingId, store_connection_id: request.destination.dropshipStoreConnectionId,
        product_variant_id: request.productVariantId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async readAbsolute(
    request: AbsoluteInventoryReadRequest,
  ): Promise<AbsoluteInventoryReadResult> {
    let identity: DropshipInventoryListingIdentity | null = null;
    try {
      const context = await this.loadContext(request);
      identity = context.identity;
      const observation = await readEbayInventoryQuantity(
        this.quantityClient(context), exactEbayInventoryItemKey(request), ebayInventoryMarketplace(context.credential.config.marketplaceId),
        { expectOffer: offer => assertRecordedOffer(offer, context.identity, request) },
      );
      return {
        observedQuantity: observation.observedQuantity,
        quantityConsistent: observation.quantityConsistent,
        providerResponse: observation,
      };
    } catch (error) {
      const translated = translateQuantityError(error);
      throw identity ? deferWhilePushInFlight(translated, identity, request) : translated;
    }
  }

  private quantityClient(context: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
  }): EbayInventoryQuantityClient {
    return {
      getInventoryItem: (sku) => this.requestJson({ ...context, method: "GET", path: inventoryItemPath(sku) }),
      getInventoryOffersPage: (sku, marketplaceId, offset, limit) => this.requestJson({
        ...context, method: "GET", path: ebayInventoryOffersPath(sku, marketplaceId, offset, limit), operation: "offer_lookup",
      }),
      bulkUpdatePriceQuantity: (body, marketplaceId) => this.requestQuantity({
        ...context, method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", body, marketplaceId,
      }),
    };
  }

  private async loadContext(
    request: AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest,
  ): Promise<{
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    identity: DropshipInventoryListingIdentity;
  }> {
    if (request.destination.kind !== this.destinationKind) {
      throw configurationError(
        "PUBLICATION_DESTINATION_KIND_MISMATCH",
        "The publication request destination does not match the Dropship transport adapter.",
        { expectedKind: this.destinationKind, actualKind: request.destination.kind },
      );
    }
    if (request.providerScopeType !== "account") {
      throw configurationError(
        "DROPSHIP_EBAY_INVENTORY_SCOPE_UNSUPPORTED",
        "Dropship eBay inventory publication requires an exact account scope.",
        { providerScopeType: request.providerScopeType },
      );
    }
    const destination = await this.destinations.load(
      request.destination.dropshipStoreConnectionId,
    );
    if (!destination
      || destination.storeConnectionId !== request.destination.dropshipStoreConnectionId) {
      throw configurationError(
        "DROPSHIP_INVENTORY_DESTINATION_NOT_FOUND",
        "The exact Dropship store connection does not exist.",
        { storeConnectionId: request.destination.dropshipStoreConnectionId },
      );
    }
    if (destination.providerKey !== this.providerKey) {
      throw configurationError(
        "DROPSHIP_INVENTORY_PROVIDER_MISMATCH",
        "The Dropship store provider does not match the selected inventory adapter.",
        { storeConnectionId: destination.storeConnectionId, providerKey: destination.providerKey },
      );
    }
    if (destination.status !== "connected") {
      throw configurationError(
        "DROPSHIP_INVENTORY_DESTINATION_NOT_CONNECTED",
        "The Dropship store must be connected before inventory can be published.",
        { storeConnectionId: destination.storeConnectionId, status: destination.status },
      );
    }
    let credential: DropshipMarketplaceStoreCredentials;
    try {
      credential = await this.credentials.loadFreshForStoreConnection({
        vendorId: destination.vendorId,
        storeConnectionId: destination.storeConnectionId,
      });
    } catch (error) {
      throw translateDropshipError(error);
    }
    if (credential.vendorId !== destination.vendorId
      || credential.storeConnectionId !== destination.storeConnectionId
      || credential.platform !== this.providerKey) {
      throw configurationError(
        "DROPSHIP_INVENTORY_CREDENTIAL_OWNER_MISMATCH",
        "The refreshed credential does not belong to the exact Dropship destination.",
        { storeConnectionId: destination.storeConnectionId, vendorId: destination.vendorId },
      );
    }
    if (credential.externalAccountIdentityScheme !== "provider_user_id"
      || credential.externalAccountId?.trim() !== request.externalScopeId.trim()) {
      throw configurationError(
        "DROPSHIP_INVENTORY_ACCOUNT_IDENTITY_MISMATCH",
        "The publication target account does not match the verified Dropship provider account.",
        {
          storeConnectionId: destination.storeConnectionId,
          targetExternalScopeId: request.externalScopeId,
          credentialExternalAccountId: credential.externalAccountId,
          credentialIdentityScheme: credential.externalAccountIdentityScheme,
        },
      );
    }
    const environment = resolveDropshipEbayProviderEnvironment(credential);
    if (!this.listingIdentities) {
      // Fail closed: without the recorded offer a write could reach an offer this
      // listing does not own.
      throw configurationError("DROPSHIP_EBAY_LISTING_IDENTITY_READER_REQUIRED",
        "Dropship eBay inventory publication requires the listing identity reader.");
    }
    const identity = await this.listingIdentities.load(destination.storeConnectionId,
      positiveInteger(request.productVariantId, "productVariantId"));
    return { destination, credential, baseUrl: EBAY_BASE_URLS[environment], identity };
  }

  private async requestJson(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "GET";
    path: string;
    operation?: InventoryHttpOperation;
  }): Promise<Record<string, unknown>> {
    const response = await this.request(input);
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Classified below without exposing the provider body.
    }
    throw new InventoryPublicationTransportError(
      "DROPSHIP_EBAY_INVENTORY_RESPONSE_INVALID",
      "eBay inventory read returned invalid JSON.",
      true,
      { status: response.status },
    );
  }

  private async requestQuantity(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "POST";
    path: string;
    body: unknown;
    marketplaceId: string;
  }): Promise<unknown> {
    const response = await observeEbayQuantityRequest(input,async () => {
      try {
        return await executeEbayQuantityHttpResponse({
          url: `${input.baseUrl}${input.path}`,method: input.method,path: input.path,body: input.body,
          headers: ebaySellRequestHeaders({ accessToken: input.credential.accessToken, method: input.method, marketplaceId: input.marketplaceId }),
          request: this.fetchFn,now: () => this.clock.now(),
          onFailure: (status,text) => this.throwInventoryHttpError(input.destination,status,text),
        });
      } catch (error) {
        if (error instanceof InventoryPublicationTransportError) throw error;
        // The shared transport now validates acknowledgements before returning.
        // Preserve this adapter's established failure contract without reparsing
        // the response or mistaking an incomplete HTTP success for a network loss.
        if (error instanceof EbayQuantityResponseUncertainError && error.httpStatus >= 200 && error.httpStatus < 300)
          throw new InventoryPublicationTransportError("EBAY_INVENTORY_ACKNOWLEDGEMENT_INVALID",
            "eBay did not confirm the exact SKU/offer quantity operation.", true, {}, { cause: error });
        throw new InventoryPublicationTransportError("DROPSHIP_EBAY_INVENTORY_NETWORK_ERROR",
          "eBay inventory publication did not yield a conclusive response.",true,
          { errorName: error instanceof Error ? error.name : "UnknownError" },{ cause: error });
      }
    });
    return response.value;
  }

  private async request(input: {
    destination: DropshipInventoryPublicationDestination;
    credential: DropshipMarketplaceStoreCredentials;
    baseUrl: string;
    method: "GET";
    path: string;
    operation?: InventoryHttpOperation;
  }): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${input.baseUrl}${input.path}`, {
        method: input.method,
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
        headers: ebaySellRequestHeaders({
          accessToken: input.credential.accessToken,
          method: input.method,
          marketplaceId: ebayInventoryMarketplace(input.credential.config.marketplaceId),
        }),
      });
    } catch (error) {
      throw new InventoryPublicationTransportError(
        "DROPSHIP_EBAY_INVENTORY_NETWORK_ERROR",
        "eBay inventory publication failed before a response was received.",
        true,
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        { cause: error },
      );
    }
    if (response.ok) return response;
    return this.throwInventoryHttpError(input.destination,response.status,await response.text(),input.operation);
  }

  private async throwInventoryHttpError(destination: DropshipInventoryPublicationDestination,status: number,text: string,
    operation?: InventoryHttpOperation): Promise<never> {
    const responseBody = text.slice(0,1_000);
    const accessTokenRejected = isEbayResourceAuthFailureStatus(status);
    if (accessTokenRejected) {
      const now = this.clock.now();
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw configurationError(
          "DROPSHIP_EBAY_INVENTORY_CLOCK_INVALID",
          "The inventory publication clock returned an invalid time.",
        );
      }
      await this.credentialHealth.recordAuthFailure?.({
        vendorId: destination.vendorId,
        storeConnectionId: destination.storeConnectionId,
        platform: "ebay",
        status: "refresh_failed",
        failureCode: "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR",
        message: `eBay inventory publication failed with HTTP ${status}.`,
        retryable: true,
        statusCode: status,
        invalidateAccessToken: true,
        now,
      });
    }
    const retryable = accessTokenRejected
      || status === 408
      || status === 425
      || status === 429
      || status >= 500;
    throw new InventoryPublicationTransportError(
      "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR",
      `eBay inventory publication failed with HTTP ${status}.`,
      retryable,
      { status, body: responseBody, ...(operation ? { operation } : {}) },
    );
  }
}

/** Which read refused, when it matters to the in-flight deferral (an offer lookup 404 means no offer yet). */
type InventoryHttpOperation = "offer_lookup";

type PublicationRequest = AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest;

function identityContext(identity: DropshipInventoryListingIdentity, request: PublicationRequest, offerId: string | null) {
  return { storeConnectionId: request.destination.dropshipStoreConnectionId, productVariantId: request.productVariantId,
    externalInventoryItemId: request.externalInventoryItemId, recordedOfferId: identity.externalOfferId,
    publishedOfferId: offerId, pushInFlight: identity.pushInFlight };
}

/**
 * Runs inside discovery, before any item read or quantity write, so every refusal
 * is a proven no-send. The recorded offer passes. Otherwise a running push of the
 * variant is waited for first (retryable), whether nothing is recorded yet or the
 * push is replacing the recorded offer and records the new one only when it
 * completes (review CF-7); the outbox's bounded attempts cap the wait. That wait
 * has its own class (PUBLISHED_OFFER_PUSH_IN_FLIGHT, review AV1-1): a PUBLISHED offer
 * exists, so a row the outbox gives up on is an offer whose quantity is no longer
 * updated. With no push running, a different offer is refused for good
 * (IDENTITY_CHANGED) and an unrecorded one too (IDENTITY_UNPROVEN).
 */
function assertRecordedOffer(offer: EbayResolvedPublishedOffer, identity: DropshipInventoryListingIdentity, request: PublicationRequest): void {
  if (identity.externalOfferId !== null && offer.offerId === identity.externalOfferId) return;
  if (identity.pushInFlight) {
    throw new InventoryPublicationNotSentError(DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT,
      "A push of this Dropship listing is still running and eBay shows a published offer it has not recorded; the quantity is sent after the push records its eBay offer.",
      true, identityContext(identity, request, offer.offerId));
  }
  if (identity.externalOfferId !== null) {
    throw new InventoryPublicationNotSentError(DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED,
      "The SKU's published eBay offer is not the offer this Dropship listing recorded; no quantity was sent.",
      false, identityContext(identity, request, offer.offerId));
  }
  throw new InventoryPublicationNotSentError(DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN,
    "No completed push recorded this Dropship listing's eBay offer; no quantity was sent.",
    false, identityContext(identity, request, offer.offerId));
}

/**
 * The pre-write quantity guard (owner rule 1, SB31): inside discovery, after
 * the offer identity check and before any write, a write that would raise
 * eBay above a number Card Shellz's last quantity and the sales since cannot
 * explain is refused (retryable, nothing sent) until the sync job decides
 * that number as the vendor's limit. A lower or equal write always goes.
 */
function assertQuantityWriteAllowed(offer: EbayResolvedPublishedOffer, guard: DropshipQuantityPreWriteFacts | null,
  request: AbsoluteInventoryPublicationRequest, at: Date): void {
  if (guard === null || offer.availableQuantity === null) return;
  const decision = decideQuantityPreWrite({ desiredQuantity: request.desiredQuantity, observed: { quantity: offer.availableQuantity, at },
    baseline: guard.baseline, salesAll: guard.salesAll, salesLedgerSince: guard.salesLedgerSince, listingLive: guard.listingLive });
  if (decision.kind === "allow") return;
  const context = { storeConnectionId: request.destination.dropshipStoreConnectionId, productVariantId: request.productVariantId,
    listingId: guard.listingId, desiredQuantity: request.desiredQuantity, observedQuantity: decision.observed,
    expectedLow: decision.expectedLow };
  // Expected while the vendor's lower number waits for the sync job's decision; the row retries on its own backoff.
  platformLogger.debug("dropship.ebay_inventory.quantity_write_deferred", { outcome: "deferred",
    error_code: MARKETPLACE_SYNC_CODES.quantityVendorChangePending, listing_id: guard.listingId,
    store_connection_id: context.storeConnectionId, product_variant_id: context.productVariantId,
    before: { observed_quantity: decision.observed }, after: { desired_quantity: request.desiredQuantity }, expected_low: decision.expectedLow });
  throw new InventoryPublicationNotSentError(MARKETPLACE_SYNC_CODES.quantityVendorChangePending,
    "eBay shows a lower quantity than Card Shellz's last one and the sales since explain; it is decided as the vendor's limit before this quantity is sent.",
    true, context);
}

function isQuantityGuardRefusal(error: unknown): boolean {
  return error instanceof InventoryPublicationNotSentError && error.code === MARKETPLACE_SYNC_CODES.quantityVendorChangePending;
}

/** No published offer yet (none, or only unpublished ones, or a 404 on the lookup) is expected while a push runs. */
function deferWhilePushInFlight(error: unknown, identity: DropshipInventoryListingIdentity, request: PublicationRequest): unknown {
  if (!identity.pushInFlight || !(error instanceof InventoryPublicationTransportError)) return error;
  const noPublishedOffer = error.code === "EBAY_INVENTORY_OFFER_AMBIGUOUS"
    || (error.code === "DROPSHIP_EBAY_INVENTORY_HTTP_ERROR" && error.context.status === 404 && error.context.operation === "offer_lookup");
  if (!noPublishedOffer) return error;
  return new InventoryPublicationNotSentError(DROPSHIP_EBAY_LISTING_PUSH_IN_FLIGHT,
    "A push of this Dropship listing is still creating or publishing its eBay offer; the quantity is sent after it finishes.",
    true, { ...identityContext(identity, request, null), deferredErrorCode: error.code }, { cause: error });
}

export function createEbayDropshipInventoryPublicationTransportAdapterFromEnv():
EbayDropshipInventoryPublicationTransportAdapter {
  const credentialRepository = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new EbayDropshipInventoryPublicationTransportAdapter(
    new PgDropshipInventoryPublicationDestinationReader(),
    RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(credentialRepository),
    credentialRepository,
    fetch,
    { now: () => new Date() },
    new PgDropshipInventoryListingIdentityReader(),
    new PgDropshipQuantityPreWriteGuardReader(),
  );
}

function inventoryItemPath(sku: string): string {
  return `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`;
}

function translateQuantityError(error: unknown): unknown {
  if (error instanceof EbayInventoryQuantityPreflightError) {
    const transport = error.cause instanceof InventoryPublicationTransportError ? error.cause : null;
    return new InventoryPublicationNotSentError(transport?.code ?? error.code, error.message,
      transport?.retryable ?? error.retryable, transport?.context, { cause: error });
  }
  if (error instanceof EbayInventoryQuantityError) {
    return new InventoryPublicationTransportError(error.code, error.message, error.retryable, undefined, { cause: error });
  }
  return error;
}

function exactEbayInventoryItemKey(
  request: AbsoluteInventoryPublicationRequest | AbsoluteInventoryReadRequest,
): string {
  const inventoryItemId = request.externalInventoryItemId.trim();
  if (!inventoryItemId) {
    throw configurationError(
      "DROPSHIP_EBAY_INVENTORY_ID_REQUIRED",
      "Dropship eBay inventory publication requires the exact provider inventory-item ID.",
    );
  }
  const externalSku = request.externalSku?.trim() || null;
  if (externalSku !== null && externalSku !== inventoryItemId) {
    throw configurationError(
      "DROPSHIP_EBAY_INVENTORY_IDENTITY_MISMATCH",
      "The eBay inventory-item ID must equal the external SKU recorded by eBay registration.",
      { externalInventoryItemId: inventoryItemId, externalSku },
    );
  }
  return inventoryItemId;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw configurationError(
      "DROPSHIP_INVENTORY_DESTINATION_INVALID",
      `${field} must be a positive safe integer.`,
    );
  }
  return parsed;
}

function nonblank(value: unknown, field: string): string {
  const parsed = String(value ?? "").trim();
  if (!parsed) {
    throw configurationError(
      "DROPSHIP_INVENTORY_DESTINATION_INVALID",
      `${field} is required.`,
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function translateDropshipError(error: unknown): unknown {
  if (!(error instanceof DropshipError)) return error;
  return new InventoryPublicationTransportError(
    error.code,
    error.message,
    error.context?.retryable === true,
    error.context ?? {},
    { cause: error },
  );
}

function configurationError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>> = {},
): InventoryPublicationTransportConfigurationError {
  return new InventoryPublicationTransportConfigurationError(code, message, context);
}
