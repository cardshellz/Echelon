import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
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
  type ProcessListingPushJobInput,
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

export interface DropshipListingPushWorkerServiceDependencies {
  repository: DropshipListingPushWorkerRepository;
  marketplacePush: DropshipMarketplaceListingPushProvider;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  logger: DropshipLogger;
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
      const pushResult = await this.deps.marketplacePush.pushListing({
        vendorId: claim.job.vendorId,
        storeConnectionId: claim.job.storeConnectionId,
        jobId: claim.job.jobId,
        jobItemId: item.itemId,
        listingId: item.listing!.listingId,
        productVariantId: item.productVariantId,
        platform: claim.job.platform,
        listingIntent: intent!,
        existingExternalListingId: item.listing!.externalListingId,
        existingExternalOfferId: item.listing!.externalOfferId,
        idempotencyKey: `${parsed.idempotencyKey}:${item.itemId}`,
      });
      assertValidPushResult(pushResult);
      await this.deps.repository.completeItem({
        job: claim.job,
        item,
        intent: intent!,
        pushResult,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
    } catch (error) {
      const classified = classifyListingPushError(error);
      await this.deps.repository.failItem({
        job: claim.job,
        item,
        code: classified.code,
        message: classified.message,
        retryable: classified.retryable,
        workerId: parsed.workerId,
        now: this.deps.clock.now(),
      });
    }
  }

  private async notifyFailedListingPushJob(result: DropshipListingPushWorkerResult): Promise<void> {
    if (result.summary.failed === 0 && result.summary.blocked === 0) {
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
      eventType: "dropship_listing_push_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship listing push failed",
      message: `Listing push job ${result.job.jobId} finished with ${result.summary.failed} failed item(s) and ${result.summary.blocked} blocked item(s).`,
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
      idempotencyKey: `listing-push:${result.job.jobId}:failed`,
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
}

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

function classifyListingPushError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DropshipError) {
    return {
      code: error.code,
      message: error.message,
      retryable: Boolean(error.context?.retryable),
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

function logDropshipListingPushWorkerEvent(
  level: "info" | "warn" | "error",
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
  console.info(payload);
}
