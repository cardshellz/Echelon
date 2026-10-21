import { DropshipError } from "../domain/errors";
import { STOCK_LINK_ERROR_SOURCE } from "../domain/stock-link-readiness";
import {
  STOCK_LINK_AWARE_FAILURE_FIELD,
  automaticRequeueCountOf,
  isAutomaticRequeueCode,
  isAutomaticStockLinkRequeueRun,
  mayRequeueAutomatically,
} from "../domain/listing-push-automatic-requeue";
import { QuantityPublicationAdmissionError } from "../../inventory-planning/domain/quantity-publication-admission";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type {
  DropshipMarketplaceListingIntent,
  DropshipStoreListingConfig,
} from "./dropship-marketplace-listing-provider";
import type {
  DropshipMarketplaceListingPushProvider,
  DropshipMarketplaceListingPushResult,
} from "./dropship-marketplace-listing-push-provider";
import {
  processListingPushJobInputSchema,
  queuedEbayCategorySchema,
  type ProcessListingPushJobInput,
  type QueuedEbayCategory,
} from "./dropship-use-case-dtos";

const MAX_LISTING_PUSH_NOTIFICATION_ITEMS = 25;

export interface DropshipListingPushWorkerJobRecord {
  jobId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipStoreListingConfig["platform"];
  status: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface DropshipListingPushWorkerEligibility {
  vendorStatus: string;
  entitlementStatus: string;
  storeStatus: string;
  setupStatus: string;
  storeLaunchReady: boolean;
}

export interface DropshipListingPushWorkerItemRecord {
  itemId: number;
  jobId: number;
  listingId: number | null;
  productVariantId: number;
  status: string;
  previewHash: string | null;
  externalListingId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  listing: {
    listingId: number;
    productVariantId: number;
    status: string;
    externalListingId: string | null;
    externalOfferId: string | null;
    lastPreviewHash: string | null;
  } | null;
}

export interface DropshipListingPushWorkerClaim {
  job: DropshipListingPushWorkerJobRecord;
  config: DropshipStoreListingConfig;
  eligibility: DropshipListingPushWorkerEligibility;
  items: DropshipListingPushWorkerItemRecord[];
  claimed: boolean;
}

export interface DropshipListingPushWorkerSummary {
  total: number;
  completed: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface DropshipListingPushWorkerResult {
  job: DropshipListingPushWorkerJobRecord;
  items: DropshipListingPushWorkerItemRecord[];
  summary: DropshipListingPushWorkerSummary;
}

export interface DropshipListingPushWorkerRepository {
  claimJob(input: {
    jobId: number;
    workerId: string;
    idempotencyKey: string;
    now: Date;
    staleProcessingMinutes?: number;
  }): Promise<DropshipListingPushWorkerClaim>;
  markItemProcessing(input: {
    jobId: number;
    itemId: number;
    now: Date;
  }): Promise<boolean>;
  completeItem(input: {
    job: DropshipListingPushWorkerJobRecord;
    item: DropshipListingPushWorkerItemRecord;
    intent: DropshipMarketplaceListingIntent;
    pushResult: DropshipMarketplaceListingPushResult;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerItemRecord>;
  failItem(input: {
    job: DropshipListingPushWorkerJobRecord;
    item: DropshipListingPushWorkerItemRecord;
    code: string;
    message: string;
    retryable: boolean;
    /** The marketplace's own error entries, bounded by the provider; kept on the item for support. */
    providerErrors?: ReadonlyArray<Record<string, unknown>>;
    /** The marketplace call that refused ("PUT /sell/inventory/v1/inventory_item/SKU"), when the provider names it. */
    endpoint?: string | null;
    /** What a refusing gate named (an attempt id, whether an operator must act); kept on the item for support. */
    context?: Record<string, unknown>;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerItemRecord>;
  blockItem(input: {
    job: DropshipListingPushWorkerJobRecord;
    item: DropshipListingPushWorkerItemRecord;
    code: string;
    message: string;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerItemRecord>;
  finalizeJob(input: {
    jobId: number;
    workerId: string;
    now: Date;
  }): Promise<DropshipListingPushWorkerResult>;
}

/** What the worker hands the push-time refresh for one queued item. */
export interface DropshipListingIntentRefreshInput {
  jobId: number;
  jobItemId: number;
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  /** The price the queued intent carried. */
  queuedPriceCents: number;
  /** The eBay category the queued intent carried; null when it had none the refresh may keep. */
  queuedMarketplaceCategory: QueuedEbayCategory | null;
}

export interface DropshipListingPushWorkerServiceDependencies {
  /**
   * Rebuilds the listing intent at push time. `queuedPriceCents` is the price
   * the queued intent carried, so the refresh can refuse to publish a rule
   * price that changed since the vendor queued it when the cost change policy
   * waits for the vendor's review (C5). `queuedMarketplaceCategory` is the eBay
   * category the queued intent carried: the push publishes the category the
   * rules name now, and keeps this one only when they name none, so a changed
   * category never fails a push.
   */
  refreshListingIntent?: (input: DropshipListingIntentRefreshInput) => Promise<DropshipMarketplaceListingIntent>;
  repository: DropshipListingPushWorkerRepository;
  marketplacePush: DropshipMarketplaceListingPushProvider;
  notificationSender?: DropshipNotificationSender;
  /**
   * Which failed items of a finalized job the push sweep will queue again by itself
   * (review V2-2: the ops repository's readAutomaticRequeuePendingItemIds, every guard
   * of its selection but the wait). The failure email promises an automatic retry
   * only for those. Absent: no item is promised one.
   */
  automaticRequeueOutlook?: DropshipAutomaticRequeueOutlook;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface DropshipAutomaticRequeueOutlook {
  pendingItemIds(jobId: number): Promise<readonly number[]>;
}

export class DropshipListingPushWorkerService {
  constructor(private readonly deps: DropshipListingPushWorkerServiceDependencies) {}

  async processJob(input: unknown): Promise<DropshipListingPushWorkerResult> {
    const parsed = processListingPushJobInputSchema.parse(input);
    const now = this.deps.clock.now();
    const claim = await this.deps.repository.claimJob({
      jobId: parsed.jobId,
      workerId: parsed.workerId,
      idempotencyKey: parsed.idempotencyKey,
      now,
      staleProcessingMinutes: parsed.staleProcessingMinutes,
    });

    if (!claim.claimed) {
      return {
        job: claim.job,
        items: claim.items,
        summary: summarizeWorkerItems(claim.items),
      };
    }

    for (const item of claim.items) {
      if (item.status !== "queued") {
        continue;
      }
      await this.processItem(parsed, claim, item);
    }

    const finalized = await this.deps.repository.finalizeJob({
      jobId: parsed.jobId,
      workerId: parsed.workerId,
      now: this.deps.clock.now(),
    });

    this.deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_JOB_PROCESSED",
      message: "Dropship listing push job processed.",
      context: {
        jobId: finalized.job.jobId,
        vendorId: finalized.job.vendorId,
        storeConnectionId: finalized.job.storeConnectionId,
        status: finalized.job.status,
        summary: finalized.summary,
      },
    });

    await this.notifyFailedListingPushJob(finalized);

    return finalized;
  }

  private async processItem(
    parsed: ProcessListingPushJobInput,
    claim: DropshipListingPushWorkerClaim,
    item: DropshipListingPushWorkerItemRecord,
  ): Promise<void> {
    const eligibilityBlocker = validateClaimEligibility(claim);
    if (eligibilityBlocker) {
      await this.deps.repository.blockItem({
        job: claim.job,
        item,
        code: eligibilityBlocker.code,
        message: eligibilityBlocker.message,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
      return;
    }

    const intent = parseListingIntent(item.result);
    const readinessBlocker = validateWorkerItemReadiness(claim, item, intent);
    if (readinessBlocker) {
      await this.deps.repository.blockItem({
        job: claim.job,
        item,
        code: readinessBlocker.code,
        message: readinessBlocker.message,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
      return;
    }

    const marked = await this.deps.repository.markItemProcessing({
      jobId: claim.job.jobId,
      itemId: item.itemId,
      now: this.deps.clock.now(),
    });
    if (!marked) {
      return;
    }

    try {
      // Persisted job intent identifies work, not a quantity snapshot to replay later.
      const currentIntent = this.deps.refreshListingIntent ? await this.deps.refreshListingIntent({
        jobId: claim.job.jobId, jobItemId: item.itemId,
        vendorId: claim.job.vendorId, storeConnectionId: claim.job.storeConnectionId, productVariantId: item.productVariantId,
        queuedPriceCents: intent!.priceCents,
        queuedMarketplaceCategory: queuedMarketplaceCategory(intent!),
      }) : intent!;
      const pushResult = await this.deps.marketplacePush.pushListing({
        vendorId: claim.job.vendorId,
        storeConnectionId: claim.job.storeConnectionId,
        jobId: claim.job.jobId,
        jobItemId: item.itemId,
        listingId: item.listing!.listingId,
        productVariantId: item.productVariantId,
        platform: claim.job.platform,
        listingIntent: currentIntent,
        existingExternalListingId: item.listing!.externalListingId,
        existingExternalOfferId: item.listing!.externalOfferId,
        idempotencyKey: `${parsed.idempotencyKey}:${item.itemId}`,
        // The stock link re-queue's own run never adopts an unrecorded published eBay listing (review TW-1).
        ...(isAutomaticStockLinkRequeueRun(item.result) ? { automaticRetry: true } : {}),
      });
      assertValidPushResult(pushResult);
      await this.deps.repository.completeItem({
        job: claim.job,
        item,
        intent: currentIntent,
        pushResult,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
    } catch (error) {
      const classified = classifyListingPushError(error);
      if (classified.needsOperator) {
        // ERROR: an operator has to act before this listing can move again (attest
        // a prior stock attempt, or fix the store's stock destination, the SKU's
        // link or the stock setup); the vendor cannot fix it and a re-queue is
        // refused the same way.
        this.deps.logger.error({
          code: "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR",
          message: "A listing push item is blocked until an operator resolves it.",
          context: {
            jobId: claim.job.jobId,
            itemId: item.itemId,
            vendorId: claim.job.vendorId,
            storeConnectionId: claim.job.storeConnectionId,
            listingId: item.listingId,
            productVariantId: item.productVariantId,
            platform: claim.job.platform,
            errorCode: classified.code,
            errorMessage: classified.message,
            attemptId: classified.context?.attemptId ?? null,
            inventoryCode: classified.context?.inventoryCode ?? null,
            classification: classified.context?.classification ?? null,
            targetCount: classified.context?.targetCount ?? null,
            // What the stored item says (review TW-7): a stock link operator refusal is
            // marked for review; an unresolved prior attempt is attested by an operator,
            // not re-driven by a retry, so it is not.
            outcome: classified.context?.requiresReview === true ? "requires_review" : "operator_action",
          },
        });
      }
      if (classified.needsStockSetup) {
        // ERROR: Card Shellz has to finish stock setup (mapping or plan) for
        // this listing; the vendor cannot fix it and a re-queue is refused the
        // same way. The item carries requiresReview in its stored context.
        this.deps.logger.error({
          code: "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_STOCK_SETUP",
          message: "A listing push item is refused until Card Shellz finishes stock setup for the listing.",
          context: {
            jobId: claim.job.jobId,
            itemId: item.itemId,
            vendorId: claim.job.vendorId,
            storeConnectionId: claim.job.storeConnectionId,
            listingId: item.listingId,
            productVariantId: item.productVariantId,
            platform: claim.job.platform,
            errorCode: classified.code,
            errorMessage: classified.message,
            outcome: "requires_review",
            classification: "permanent",
          },
        });
      }
      // The vendor is told by notification; this line is for the operator
      // reading the log for one job, with the marketplace's reason attached.
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_PUSH_ITEM_FAILED",
        message: "A listing push item failed at the marketplace.",
        context: {
          jobId: claim.job.jobId,
          itemId: item.itemId,
          vendorId: claim.job.vendorId,
          storeConnectionId: claim.job.storeConnectionId,
          listingId: item.listingId,
          productVariantId: item.productVariantId,
          platform: claim.job.platform,
          errorCode: classified.code,
          errorMessage: classified.message,
          retryable: classified.retryable,
          endpoint: classified.endpoint,
          providerErrors: classified.providerErrors,
        },
      });
      await this.deps.repository.failItem({
        job: claim.job,
        item,
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
        context: classified.context,
        providerErrors: classified.providerErrors,
        endpoint: classified.endpoint,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
    }
  }

  private async notifyFailedListingPushJob(result: DropshipListingPushWorkerResult): Promise<void> {
    if (result.summary.failed === 0 && result.summary.blocked === 0) {
      return;
    }
    // One email for the job's first failure (it says when the push sweep re-queues an
    // item by itself), and, after automatic re-queues, one more for the final outcome
    // (review TW-3). Nothing while another automatic re-queue is still to come; which
    // items get one is read from the database, with the sweep's own guards (review V2-2).
    const failedAll = result.items.filter((item) => item.status === "failed" || item.status === "blocked");
    const afterAutomaticRetry = failedAll.some((item) => automaticRequeueCountOf(item.result) > 0);
    const pendingAutomaticRequeue = await this.pendingAutomaticRequeueItemIds(result, failedAll);
    if (afterAutomaticRetry && failedAll.some((item) => pendingAutomaticRequeue.has(item.itemId))) {
      return;
    }

    const failedItems = result.items
      .filter((item) => item.status === "failed" || item.status === "blocked")
      .slice(0, MAX_LISTING_PUSH_NOTIFICATION_ITEMS)
      .map((item) => ({
        itemId: item.itemId,
        listingId: item.listingId,
        productVariantId: item.productVariantId,
        status: item.status,
        errorCode: item.errorCode,
        errorMessage: item.errorMessage,
        externalListingId: item.externalListingId,
      }));

    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.job.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.LISTING_PUSH_FAILED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship listing push failed",
      message: describeFailedListingPushJob(result, pendingAutomaticRequeue),
      payload: {
        jobId: result.job.jobId,
        vendorId: result.job.vendorId,
        storeConnectionId: result.job.storeConnectionId,
        platform: result.job.platform,
        status: result.job.status,
        summary: result.summary,
        failedItems,
        omittedFailureItemCount: Math.max(
          0,
          result.summary.failed + result.summary.blocked - failedItems.length,
        ),
      },
      idempotencyKey: afterAutomaticRetry
        ? `listing-push:${result.job.jobId}:failed:after-automatic-retry`
        : `listing-push:${result.job.jobId}:failed`,
    }, {
      code: "DROPSHIP_LISTING_PUSH_NOTIFICATION_FAILED",
      message: "Dropship listing push failure notification failed after the job was finalized.",
      context: {
        jobId: result.job.jobId,
        vendorId: result.job.vendorId,
        storeConnectionId: result.job.storeConnectionId,
        failed: result.summary.failed,
        blocked: result.summary.blocked,
      },
    });
  }

  /**
   * The failed items the push sweep will queue again by itself (review V2-2). The
   * item-level conditions are checked first (mayRequeueAutomatically), so a job with
   * none of them reads nothing; the rest (store, vendor and listing guards) come
   * from the repository. A read failure promises nothing: it is logged (WARN, the
   * email is a side channel) and the email is sent without the automatic sentence,
   * which is never untrue.
   */
  private async pendingAutomaticRequeueItemIds(
    result: DropshipListingPushWorkerResult,
    failed: readonly DropshipListingPushWorkerItemRecord[],
  ): Promise<ReadonlySet<number>> {
    const candidates = failed.filter(mayRequeueAutomatically);
    if (candidates.length === 0 || !this.deps.automaticRequeueOutlook) return EMPTY_ITEM_IDS;
    try {
      const pending = new Set(await this.deps.automaticRequeueOutlook.pendingItemIds(result.job.jobId));
      return new Set(candidates.filter((item) => pending.has(item.itemId)).map((item) => item.itemId));
    } catch (error) {
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_OUTLOOK_FAILED",
        message: "Could not read which failed listing push items are queued again automatically; the failure email promises no automatic retry.",
        context: {
          jobId: result.job.jobId,
          vendorId: result.job.vendorId,
          storeConnectionId: result.job.storeConnectionId,
          itemIds: candidates.map((item) => item.itemId),
          outcome: "no_automatic_retry_promised",
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return EMPTY_ITEM_IDS;
    }
  }
}

const EMPTY_ITEM_IDS: ReadonlySet<number> = new Set();

export function summarizeWorkerItems(
  items: readonly DropshipListingPushWorkerItemRecord[],
): DropshipListingPushWorkerSummary {
  return {
    total: items.length,
    completed: items.filter((item) => item.status === "completed").length,
    failed: items.filter((item) => item.status === "failed").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    skipped: items.filter((item) => !["completed", "failed", "blocked"].includes(item.status)).length,
  };
}

export function makeDropshipListingPushWorkerLogger(): DropshipLogger {
  return {
    debug: (event) => logDropshipListingPushWorkerEvent("debug", event),
    info: (event) => logDropshipListingPushWorkerEvent("info", event),
    warn: (event) => logDropshipListingPushWorkerEvent("warn", event),
    error: (event) => logDropshipListingPushWorkerEvent("error", event),
  };
}

export const systemDropshipListingPushWorkerClock: DropshipClock = {
  now: () => new Date(),
};

function validateWorkerItemReadiness(
  claim: DropshipListingPushWorkerClaim,
  item: DropshipListingPushWorkerItemRecord,
  intent: DropshipMarketplaceListingIntent | null,
): { code: string; message: string } | null {
  if (!item.listing) {
    return {
      code: "DROPSHIP_LISTING_RECORD_REQUIRED",
      message: "Listing push item does not have a vendor listing record.",
    };
  }
  if (!intent) {
    return {
      code: "DROPSHIP_LISTING_INTENT_REQUIRED",
      message: "Listing push item does not have a stored listing intent.",
    };
  }
  if (claim.config.platform !== claim.job.platform || intent.platform !== claim.job.platform) {
    return {
      code: "DROPSHIP_LISTING_PLATFORM_DRIFT",
      message: "Listing platform no longer matches the store connection.",
    };
  }
  if (!claim.config.isActive) {
    return {
      code: "DROPSHIP_LISTING_CONFIG_INACTIVE",
      message: "Store listing configuration is inactive.",
    };
  }
  if (claim.config.listingMode !== intent.listingMode) {
    return {
      code: "DROPSHIP_LISTING_CONFIG_DRIFT",
      message: "Store listing configuration changed after preview.",
    };
  }
  if (item.previewHash !== item.listing.lastPreviewHash) {
    return {
      code: "DROPSHIP_LISTING_PREVIEW_DRIFT",
      message: "Listing preview hash no longer matches the vendor listing.",
    };
  }
  return null;
}

function validateClaimEligibility(
  claim: DropshipListingPushWorkerClaim,
): { code: string; message: string } | null {
  if (claim.eligibility.vendorStatus !== "active") {
    return {
      code: "DROPSHIP_LISTING_VENDOR_BLOCKED",
      message: "Dropship vendor status no longer allows listing push.",
    };
  }
  if (claim.eligibility.entitlementStatus !== "active") {
    return {
      code: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
      message: "Dropship vendor entitlement no longer allows listing push.",
    };
  }
  if (!claim.eligibility.storeLaunchReady) {
    return {
      code: "DROPSHIP_LISTING_STORE_BLOCKED",
      message: "Dropship store connection is no longer launch-ready for listing push.",
    };
  }
  return null;
}

/**
 * The eBay category a queued eBay intent carried, for the refresh to keep when
 * the rules now name none. The stored intent is JSON, so it is checked again: an
 * id that is not an eBay category number is not kept. The name is display only,
 * so an unusable name is dropped rather than losing the category.
 */
function queuedMarketplaceCategory(intent: DropshipMarketplaceListingIntent): QueuedEbayCategory | null {
  if (intent.platform !== "ebay") return null;
  const categoryId = queuedEbayCategorySchema.shape.categoryId.safeParse(intent.marketplaceCategoryId);
  if (!categoryId.success) return null;
  const categoryName = queuedEbayCategorySchema.shape.categoryName.safeParse(intent.marketplaceCategoryName ?? null);
  return { categoryId: categoryId.data, categoryName: categoryName.success ? categoryName.data : null };
}

function parseListingIntent(result: Record<string, unknown> | null): DropshipMarketplaceListingIntent | null {
  const intent = result?.listingIntent;
  if (!intent || typeof intent !== "object") {
    return null;
  }
  return intent as DropshipMarketplaceListingIntent;
}

function assertValidPushResult(result: DropshipMarketplaceListingPushResult): void {
  if (!result.externalListingId?.trim()) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_EXTERNAL_ID_REQUIRED",
      "Marketplace listing push did not return an external listing id.",
    );
  }
}

/**
 * The notice names the first marketplace reason so the vendor can act on the
 * email alone; the portal shows every item. It says the item is tried again
 * automatically only when the push sweep will do so (`pendingAutomaticRequeue`,
 * read with the sweep's guards, review V2-2).
 */
export function describeFailedListingPushJob(
  result: DropshipListingPushWorkerResult,
  pendingAutomaticRequeue: ReadonlySet<number> = EMPTY_ITEM_IDS,
): string {
  const failed = result.summary.failed + result.summary.blocked;
  const lead = `${failed} of ${result.summary.total} listing${result.summary.total === 1 ? "" : "s"} could not be sent to your store (job ${result.job.jobId}).`;
  const first = result.items.find((item) => (item.status === "failed" || item.status === "blocked") && item.errorMessage);
  if (!first) return lead;
  const retry = pendingAutomaticRequeue.has(first.itemId) ? ` ${AUTOMATIC_RETRY_EMAIL_SENTENCE}` : "";
  return `${lead} First reason: ${first.errorMessage}${retry}`;
}

/** Added to the first reason when the push sweep queues that item again by itself (review TW-3). */
const AUTOMATIC_RETRY_EMAIL_SENTENCE = "Card Shellz will try it again automatically.";

/**
 * Stock-gate refusals that only a human clears: an earlier eBay quantity
 * attempt with no proven outcome is resolved by operator attestation on the
 * Inventory cutover page, never by queueing the listing again.
 */
const OPERATOR_RESOLVED_ADMISSION_CODES: ReadonlySet<string> = new Set(["PUBLICATION_PRIOR_OUTCOME_UNRESOLVED"]);

/**
 * Stock-gate refusals (QuantityPublicationAdmissionError) that the same push
 * meets again on every retry until something outside the push changes, so
 * they are permanent here: retryable false, never requeued by an ops retry
 * or a catch-up. The shared error keeps `retryable = true` for its other
 * owners (channels); this is the dropship worker's own classification.
 * - PUBLICATION_LISTING_TARGET_UNMAPPED: no single exact active canonical
 *   stock target/mapping for this listing's eBay SKU
 *   (inventory-planning canonical-quantity-publication-member.reader.ts);
 *   Card Shellz has to set up stock mapping for the listing.
 * - PUBLICATION_LISTING_PLAN_OMITTED: the current canonical stock plan does
 *   not include this exact listing (quantity-publication-runtime.ts
 *   planCanonicalListingQuantityInsideTransaction).
 * - PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED: the store has no verified eBay
 *   account id (quantity-publication-runtime.ts
 *   createDropshipEbayQuantityRequestAdmission); only reconnecting clears it.
 * Every other stock-gate code stays retryable: the busy, cooldown, suppressed
 * and changed-plan refusals clear by themselves
 * (quantity-publication-admission.repository.ts execute).
 */
const PERMANENT_ADMISSION_CODES: ReadonlySet<string> = new Set([
  "PUBLICATION_LISTING_TARGET_UNMAPPED",
  "PUBLICATION_LISTING_PLAN_OMITTED",
  "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED",
]);

/** Of the permanent refusals, those Card Shellz (not the vendor) must fix: logged at ERROR and marked for review. */
const CARD_SHELLZ_SETUP_ADMISSION_CODES: ReadonlySet<string> = new Set([
  "PUBLICATION_LISTING_TARGET_UNMAPPED",
  "PUBLICATION_LISTING_PLAN_OMITTED",
]);

export type DropshipStockGateRefusalClass = "transient" | "permanent" | "operator";

/** How the dropship worker treats a stock-gate refusal's code. Pure. */
export function classifyStockGateRefusal(code: string): DropshipStockGateRefusalClass {
  if (OPERATOR_RESOLVED_ADMISSION_CODES.has(code)) return "operator";
  if (PERMANENT_ADMISSION_CODES.has(code)) return "permanent";
  return "transient";
}

function classifyListingPushError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  providerErrors?: ReadonlyArray<Record<string, unknown>>;
  endpoint?: string | null;
  /** Kept on the item for support: which gate refused and what it named. */
  context?: Record<string, unknown>;
  /** True when a re-queue cannot help and an operator must act first. */
  needsOperator?: boolean;
  /** True when Card Shellz must finish stock setup for the listing; the item is marked requires_review. */
  needsStockSetup?: boolean;
} {
  if (error instanceof QuantityPublicationAdmissionError) {
    // The stock gate's own code is the useful fact; it carries no endpoint or
    // provider error. Most of its refusals come before the quantity request,
    // but some come after eBay answered it (PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN
    // from the bulk quantity response, PUBLICATION_COMPLETION_CONFLICT and
    // PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN in the admission's completion),
    // so eBay may already show the new quantity.
    const refusal = classifyStockGateRefusal(error.code);
    const needsOperator = refusal === "operator";
    const needsStockSetup = CARD_SHELLZ_SETUP_ADMISSION_CODES.has(error.code);
    const attemptId = typeof error.context.attemptId === "string" ? error.context.attemptId : null;
    return {
      code: error.code,
      message: error.message,
      retryable: refusal === "transient",
      context: {
        attemptId,
        operatorAction: needsOperator,
        ...(refusal === "permanent" ? { classification: "permanent" } : {}),
        ...(needsStockSetup ? { requiresReview: true } : {}),
        // This worker links stock before a managed live push's first write. Every
        // re-queue code it records says so: an UNMAPPED refusal it records is not one
        // owner decision Q4 re-sends (review MC-3), and only a PUBLICATION_SCOPE_BUSY
        // it records is re-queued automatically (review V2-1).
        ...(isAutomaticRequeueCode(error.code) ? { [STOCK_LINK_AWARE_FAILURE_FIELD]: true } : {}),
      },
      needsOperator,
      needsStockSetup,
    };
  }
  if (error instanceof DropshipError) {
    const endpoint = error.context?.endpoint;
    const needsOperator = error.context?.needsOperator === true;
    const retryable = Boolean(error.context?.retryable);
    return {
      code: error.code,
      message: error.message,
      retryable,
      providerErrors: providerErrorEntries(error.context?.providerErrors),
      endpoint: typeof endpoint === "string" && endpoint.length > 0 ? endpoint : null,
      // The stock link's refusals (domain/stock-link-readiness stockLinkError)
      // keep the inventory code behind them for support. An operator-only
      // refusal is marked for review, so once it is fixed an admin's retry can
      // re-drive it (requeueRetryableFailedItems).
      ...(error.context?.source === STOCK_LINK_ERROR_SOURCE ? {
        context: {
          inventoryCode: typeof error.context.inventoryCode === "string" ? error.context.inventoryCode : null,
          operatorAction: needsOperator,
          targetCount: typeof error.context.targetCount === "number" ? error.context.targetCount : null,
          classification: typeof error.context.classification === "string" ? error.context.classification : null,
          ...(typeof error.context.command_key === "string" ? { commandKey: error.context.command_key } : {}),
          ...(needsOperator && !retryable ? { requiresReview: true } : {}),
          // Recorded by the worker that links stock first: the automatic re-queue owns it (review V2-1).
          ...(isAutomaticRequeueCode(error.code) ? { [STOCK_LINK_AWARE_FAILURE_FIELD]: true } : {}),
        },
      } : {}),
      needsOperator,
    };
  }
  if (error instanceof Error) {
    return {
      code: "DROPSHIP_LISTING_PUSH_FAILED",
      message: error.message,
      retryable: true,
    };
  }
  return {
    code: "DROPSHIP_LISTING_PUSH_FAILED",
    message: "Dropship listing push failed.",
    retryable: true,
  };
}

/** Only plain objects from the provider are kept; anything else is not stored. */
function providerErrorEntries(value: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is Record<string, unknown> =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry));
  return entries.length > 0 ? entries : undefined;
}

function logDropshipListingPushWorkerEvent(
  level: "debug" | "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  if (level === "debug") {
    console.debug(payload);
    return;
  }
  console.info(payload);
}
