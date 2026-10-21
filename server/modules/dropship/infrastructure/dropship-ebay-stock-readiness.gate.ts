import type { Pool } from "pg";
import { performance } from "node:perf_hooks";
import {
  dropshipEbayStockCommandKey,
  ensureDropshipEbayStockReady,
  readDropshipEbayStockAuthority,
  type DropshipEbayStockReadinessInput,
  type DropshipEbayStockReadinessResult,
} from "../../inventory-planning/quantity-publication";
import { MARKETPLACE_PROVIDER_IDENTITY_SCHEME } from "../../marketplace-listings/domain/listing-registration-plan";
import { DropshipError } from "../domain/errors";
import {
  STOCK_LINK_MAX_ATTEMPTS,
  STOCK_LINK_RETRY_BACKOFF_MS,
  classifyStockLinkBlockers,
  classifyStockLinkFailure,
  isManagedLiveIntent,
  stockLinkError,
  stockLinkRefusal,
  type StockLinkLogLevel,
  type StockLinkRefusal,
} from "../domain/stock-link-readiness";
import type {
  DropshipEbayStockReadinessPort,
  DropshipStockLinkBegin,
  DropshipStockLinkCredential,
  DropshipStockLinkResolvedOffers,
} from "../application/dropship-ebay-stock-readiness-port";
import type { DropshipMarketplaceListingPushRequest } from "../application/dropship-marketplace-listing-push-provider";
import type { DropshipLogEvent } from "../application/dropship-ports";

/** The only actor a listing push links stock as (inventory's allow-list). */
const LISTING_PUSH_STOCK_ACTOR = "system:dropship-listing-push";
/** Inventory bounds the audit-only requested_by at 100 characters. */
const REQUESTED_BY_MAX_LENGTH = 100;
const ACTION = "dropship.stock_link.ensure";

/** Structured JSON lines (root CLAUDE.md section 10): ERROR needs a human, WARN an
 * anomaly that recovers by itself, INFO a state change, DEBUG detail. */
export interface DropshipStockLinkLogger {
  debug(event: DropshipLogEvent): void;
  info(event: DropshipLogEvent): void;
  warn(event: DropshipLogEvent): void;
  error(event: DropshipLogEvent): void;
}

export function makeDropshipStockLinkLogger(): DropshipStockLinkLogger {
  const write = (level: StockLinkLogLevel, event: DropshipLogEvent) => {
    const line = JSON.stringify({ level, code: event.code, message: event.message, context: event.context ?? {} });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (level === "info") console.info(line);
    else console.debug(line);
  };
  return {
    debug: event => write("debug", event), info: event => write("info", event),
    warn: event => write("warn", event), error: event => write("error", event),
  };
}

export interface DropshipEbayStockReadinessGateDependencies {
  /** Published inventory read (quantity-publication.ts). Throws PUBLICATION_AUTHORITY_MISSING when unknown. */
  readAuthority(): Promise<"legacy" | "canonical">;
  /** Published inventory writer (quantity-publication.ts), bound to the pool. */
  ensure(input: DropshipEbayStockReadinessInput, options: { actor: string; now: Date; requestedBy?: string }): Promise<DropshipEbayStockReadinessResult>;
  /** Dropship-owned rows only: the listing, its job item and job, and the catalog variant's product. */
  database: Pick<Pool, "query">;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  logger: DropshipStockLinkLogger;
  maxAttempts?: number;
  backoffMs?: readonly number[];
}

interface OwnedListing {
  productId: number;
  requestedBy: string | null;
}

/**
 * Dropship's side of the automatic stock link (plan F2 2.8). It owns no inventory
 * table: the link itself is inventory-planning's ensureDropshipEbayStockReady,
 * reached only through the published quantity-publication interface.
 */
export class DropshipEbayStockReadinessGate implements DropshipEbayStockReadinessPort {
  private readonly maxAttempts: number;
  private readonly backoffMs: readonly number[];

  constructor(private readonly deps: DropshipEbayStockReadinessGateDependencies) {
    this.maxAttempts = deps.maxAttempts ?? STOCK_LINK_MAX_ATTEMPTS;
    this.backoffMs = deps.backoffMs ?? STOCK_LINK_RETRY_BACKOFF_MS;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.backoffMs.length < this.maxAttempts - 1
      || this.backoffMs.some(ms => !Number.isSafeInteger(ms) || ms < 0)) {
      throw new DropshipError("DROPSHIP_STOCK_LINK_RETRY_POLICY_INVALID", "The stock link retry policy is invalid.", { retryable: false });
    }
  }

  async begin(input: { request: DropshipMarketplaceListingPushRequest; credential: DropshipStockLinkCredential }): Promise<DropshipStockLinkBegin> {
    const correlation = this.correlation(input.request);
    const authority = await this.readAuthorityWithRetry(correlation);
    // Legacy authority: no new check of any kind, so legacy pushes keep today's codes.
    if (authority === "legacy") {
      this.log("debug", "not_applicable", correlation, { authority });
      return { authority, mustLink: false };
    }
    if (!isManagedLiveIntent(input.request.listingIntent)) {
      // Under canonical authority such a positive write is always refused at its
      // first admitted request (selection is never `publish` for these modes);
      // failing here is earlier, before any eBay call, and says why. A quantity
      // of 0 is still allowed (all-zero writes need no stock link).
      if (input.request.listingIntent.quantity > 0) {
        throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_MODE_NOT_MANAGED"), correlation, {
          listingMode: input.request.listingIntent.listingMode, inventoryMode: input.request.listingIntent.inventoryMode,
        });
      }
      this.log("debug", "not_managed_zero_quantity", correlation, { authority });
      return { authority, mustLink: false };
    }
    return { authority, mustLink: true };
  }

  async ensureLinked(input: {
    request: DropshipMarketplaceListingPushRequest;
    credential: DropshipStockLinkCredential;
    environment: "production" | "sandbox";
    sku: string;
    resolved: DropshipStockLinkResolvedOffers;
    linkStock?: boolean;
  }): Promise<void> {
    const { request } = input;
    const origin = { kind: "listing_push" as const, jobId: request.jobId, jobItemId: request.jobItemId, listingId: request.listingId };
    const correlation = { ...this.correlation(request), command_key: safeCommandKey(request.storeConnectionId, origin),
      external_offer_id: input.resolved.offers[0]?.existingOfferId ?? null };
    // Review TW-1: an automatic re-send never adopts a published eBay listing this
    // listing did not record. Every code the sweep re-queues is raised before the
    // earlier attempt published anything (the link refusals at this hook, a busy
    // scope at an admitted write before publish, and PUBLICATION_LISTING_TARGET_UNMAPPED
    // at the publish's own admission), so such a listing is not Card Shellz's: most
    // likely the vendor listed the SKU themselves after the failure, and an automatic
    // adoption days later would overwrite it (the account-check recovery's rule,
    // dropship-listing-push-ops.repository.ts). Refused before inventory is called
    // and before any eBay write; the vendor's own queue still adopts (plan R12).
    const publishedListingId = input.resolved.verifiedPublishedListingId;
    if (request.automaticRetry === true && publishedListingId !== null
      && publishedListingId !== (request.existingExternalListingId?.trim() || null)) {
      throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_RESEND_LISTING_FOUND", {
        inventoryCode: "DROPSHIP_STOCK_UNRECORDED_PUBLISHED_LISTING" }), correlation, {
        verifiedPublishedListingId: publishedListingId, existingExternalListingId: request.existingExternalListingId });
    }
    // An automatic re-queue of a push that needs no stock link: the check above was all.
    if (input.linkStock === false) {
      this.log("debug", "automatic_retry_checked", correlation, {});
      return;
    }
    // The connector accepted exactly this listing's one offer for this SKU, or
    // the request no longer describes what was discovered.
    const offer = input.resolved.offers.length === 1 ? input.resolved.offers[0]! : null;
    if (!offer || offer.variantId !== request.productVariantId || offer.sku !== input.sku
      || request.listingIntent.sku?.trim() !== input.sku) {
      throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_SKU_CHANGED", { inventoryCode: "DROPSHIP_STOCK_OFFER_SCOPE_MISMATCH" }),
        correlation, { offerCount: input.resolved.offers.length });
    }
    const owned = await this.readOwnedListing(request).catch((error: unknown) => { throw this.failureError(error, correlation, 1); });
    if (!owned) {
      throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_SKU_CHANGED", { inventoryCode: "DROPSHIP_STOCK_LISTING_OWNERSHIP_MISMATCH" }), correlation);
    }
    const linkCorrelation = { ...correlation, product_id: owned.productId };
    const accountId = verifiedAccountId(input.credential, request);
    if (!accountId) {
      // Checked before inventory is called: a store with no provider-verified
      // eBay user id cannot match any destination (the transport requires it too).
      throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED", { inventoryCode: "DROPSHIP_STOCK_ACCOUNT_UNVERIFIED" }), linkCorrelation);
    }
    const linkInput: DropshipEbayStockReadinessInput = {
      vendorId: request.vendorId, storeConnectionId: request.storeConnectionId, accountId,
      environment: input.environment, productId: owned.productId, purpose: "publish",
      variants: [{ productVariantId: request.productVariantId, sku: input.sku }], origin,
    };
    const requestedBy = owned.requestedBy?.trim().slice(0, REQUESTED_BY_MAX_LENGTH) || undefined;
    for (let attempt = 1; ; attempt += 1) {
      let result: DropshipEbayStockReadinessResult;
      try {
        result = await this.deps.ensure(linkInput, { actor: LISTING_PUSH_STOCK_ACTOR, now: this.deps.clock.now(), ...(requestedBy ? { requestedBy } : {}) });
      } catch (error) {
        const failure = classifyStockLinkFailure(error);
        if (failure.kind === "fatal") throw this.failureError(error, linkCorrelation, attempt);
        await this.retryOrGiveUp(attempt, failure.inventoryCode, linkCorrelation, error);
        continue;
      }
      if (result.status === "not_applicable") {
        // Authority moved to legacy after begin (a one-time activation window).
        this.log("debug", "not_applicable", linkCorrelation, { reason: result.reason, attempt });
        return;
      }
      if (result.status === "ready") {
        const fields = { attempt, publication_target_id: result.publicationTargetId, command_key: result.commandKey,
          fence_hold_ms: result.fenceHoldMs, before: { mappingActions: result.mappingActions },
          after: { linkedProductVariantIds: result.linkedProductVariantIds } };
        if (result.alreadyLinked) this.log("debug", "already_linked", linkCorrelation, fields);
        else this.log("info", "linked", linkCorrelation, fields);
        return;
      }
      const refusal = classifyStockLinkBlockers(result);
      const blockedCorrelation = { ...linkCorrelation, command_key: result.commandKey, publication_target_id: result.publicationTargetId };
      if (refusal.code === "DROPSHIP_STOCK_LINK_BUSY") {
        // A concurrency condition the in-fence review reported as a blocker.
        await this.retryOrGiveUp(attempt, refusal.inventoryCode, blockedCorrelation, null);
        continue;
      }
      throw this.refusalError(refusal, blockedCorrelation, { attempt });
    }
  }

  /**
   * The authority decides whether anything new runs at all, so a database blip
   * while reading it (a lost connection, the pool's connect timeout, a failover)
   * gets the same bounded in-process retry as the link (review CF-1); after the
   * last attempt the item fails DROPSHIP_STOCK_LINK_BUSY, retryable, and the push
   * sweep re-queues it. Nothing has been sent to eBay yet. An unknown or invalid
   * authority (PUBLICATION_AUTHORITY_MISSING) stays fatal at once.
   */
  private async readAuthorityWithRetry(correlation: Record<string, unknown>): Promise<"legacy" | "canonical"> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.deps.readAuthority();
      } catch (error) {
        const failure = classifyStockLinkFailure(error);
        if (failure.kind === "fatal") throw this.failureError(error, correlation, attempt);
        await this.retryOrGiveUp(attempt, failure.inventoryCode, correlation, error);
      }
    }
  }

  private async retryOrGiveUp(attempt: number, inventoryCode: string, correlation: Record<string, unknown>, cause: unknown): Promise<void> {
    if (attempt >= this.maxAttempts) {
      throw this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_LINK_BUSY", { inventoryCode }), correlation,
        { attempt, attempts: this.maxAttempts, cause: describeCause(cause) });
    }
    const waitMs = this.backoffMs[attempt - 1]!;
    this.log("debug", "retry", correlation, { attempt, error_code: "DROPSHIP_STOCK_LINK_BUSY", inventory_code: inventoryCode,
      wait_ms: waitMs, classification: "transient" });
    await this.deps.sleep(waitMs);
  }

  /** The listing, its job item and job must all still be this vendor's exact store variant. */
  private async readOwnedListing(request: DropshipMarketplaceListingPushRequest): Promise<OwnedListing | null> {
    const rows = (await this.deps.database.query<{ product_id: unknown; requested_by: unknown }>(
      `SELECT pv.product_id, j.requested_by
       FROM dropship.dropship_vendor_listings listing
       JOIN catalog.product_variants pv ON pv.id = listing.product_variant_id
       JOIN dropship.dropship_listing_push_job_items ji
         ON ji.id = $5 AND ji.listing_id = listing.id AND ji.product_variant_id = listing.product_variant_id
       JOIN dropship.dropship_listing_push_jobs j
         ON j.id = ji.job_id AND j.id = $6 AND j.vendor_id = listing.vendor_id AND j.store_connection_id = listing.store_connection_id
       WHERE listing.id = $1 AND listing.vendor_id = $2 AND listing.store_connection_id = $3
         AND listing.product_variant_id = $4 AND listing.platform = 'ebay'`,
      [request.listingId, request.vendorId, request.storeConnectionId, request.productVariantId, request.jobItemId, request.jobId],
    )).rows;
    const productId = Number(rows[0]?.product_id);
    if (rows.length !== 1 || !Number.isSafeInteger(productId) || productId <= 0) return null;
    const requestedBy = rows[0]!.requested_by;
    return { productId, requestedBy: typeof requestedBy === "string" ? requestedBy : null };
  }

  private refusalError(refusal: StockLinkRefusal, correlation: Record<string, unknown>, extra: Record<string, unknown> = {}): DropshipError {
    this.log(refusal.logLevel, refusal.classification === "transient" ? "gave_up" : "refused", correlation, {
      ...extra, error_code: refusal.code, inventory_code: refusal.inventoryCode, inventory_codes: refusal.inventoryCodes,
      classification: refusal.classification, retryable: refusal.retryable, needs_operator: refusal.needsOperator,
      target_count: refusal.targetCount, blocker_product_variant_id: refusal.productVariantId,
    });
    return stockLinkError(refusal, { ...pickContext(correlation), ...extra });
  }

  private failureError(error: unknown, correlation: Record<string, unknown>, attempt: number): DropshipError {
    const failure = classifyStockLinkFailure(error);
    if (failure.kind === "transient") {
      return this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_LINK_BUSY", { inventoryCode: failure.inventoryCode }), correlation,
        { attempt, cause: describeCause(error) });
    }
    return this.refusalError(stockLinkRefusal("DROPSHIP_STOCK_LINK_FAILED", { inventoryCode: failure.inventoryCode }), correlation,
      { attempt, cause: describeCause(error) });
  }

  private correlation(request: DropshipMarketplaceListingPushRequest): Record<string, unknown> {
    return { vendor_id: request.vendorId, store_connection_id: request.storeConnectionId, job_id: request.jobId,
      job_item_id: request.jobItemId, listing_id: request.listingId, product_variant_id: request.productVariantId };
  }

  private log(level: StockLinkLogLevel, outcome: string, correlation: Record<string, unknown>, fields: Record<string, unknown>): void {
    const event: DropshipLogEvent = {
      code: "DROPSHIP_STOCK_LINK_ENSURE",
      message: STOCK_LINK_LOG_MESSAGES[outcome] ?? "Dropship eBay stock link step.",
      context: { action: ACTION, outcome, error_code: null, inventory_code: null, fence_hold_ms: null,
        publication_target_id: null, ...correlation, ...fields },
    };
    this.deps.logger[level](event);
  }
}

const STOCK_LINK_LOG_MESSAGES: Record<string, string> = {
  not_applicable: "Inventory authority is legacy; the push needs no stock link.",
  not_managed_zero_quantity: "The store does not use Card Shellz-managed live quantity; a zero-quantity push needs no stock link.",
  already_linked: "The listing's eBay SKU already has its Card Shellz stock link.",
  linked: "The listing's eBay SKU was linked to Card Shellz stock before the first eBay write.",
  retry: "The stock link met concurrent inventory work; it is tried again shortly.",
  gave_up: "The stock link stayed busy after every in-process attempt; the push sweep re-queues the item automatically.",
  refused: "The stock link was refused; the push stops before any eBay offer, inventory-item or quantity write.",
  automatic_retry_checked: "An automatic re-queue of a push that needs no stock link adopts no unrecorded eBay listing.",
};

/** The fields a stored item context keeps (the full line is in the log). */
function pickContext(correlation: Record<string, unknown>): Record<string, unknown> {
  const keys = ["command_key", "publication_target_id", "product_id", "external_offer_id"] as const;
  return Object.fromEntries(keys.filter(key => correlation[key] !== undefined).map(key => [key, correlation[key]]));
}

function describeCause(error: unknown): Record<string, unknown> | null {
  if (!error) return null;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, code: typeof code === "string" ? code : null, message: error.message.slice(0, 500) };
  }
  return { name: "NonError", code: null, message: String(error).slice(0, 500) };
}

/** The store's provider-verified eBay user id, or null (the scheme every writer stores, migration 0609). */
function verifiedAccountId(credential: DropshipStockLinkCredential, request: DropshipMarketplaceListingPushRequest): string | null {
  const accountId = credential.externalAccountId?.trim();
  if (credential.vendorId !== request.vendorId || credential.storeConnectionId !== request.storeConnectionId
    || credential.platform !== "ebay" || !accountId
    || credential.externalAccountIdentityScheme !== MARKETPLACE_PROVIDER_IDENTITY_SCHEME || !credential.externalAccountVerifiedAt) return null;
  return accountId;
}

/** The command key only identifies log lines; an origin it cannot key is logged without one. */
function safeCommandKey(storeConnectionId: number, origin: { kind: "listing_push"; jobId: number; jobItemId: number; listingId: number }): string | null {
  try { return dropshipEbayStockCommandKey(storeConnectionId, origin); } catch { return null; }
}

export function createDropshipEbayStockReadinessGate(input: {
  pool: Pick<Pool, "connect" | "query">;
  clock?: { now(): Date };
  sleep?: (ms: number) => Promise<void>;
  logger?: DropshipStockLinkLogger;
}): DropshipEbayStockReadinessGate {
  return new DropshipEbayStockReadinessGate({
    readAuthority: () => readDropshipEbayStockAuthority(input.pool),
    ensure: (linkInput, options) => ensureDropshipEbayStockReady(input.pool, linkInput, { ...options, monotonicNow: () => performance.now() }),
    database: input.pool,
    clock: input.clock ?? { now: () => new Date() },
    sleep: input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    logger: input.logger ?? makeDropshipStockLinkLogger(),
  });
}

