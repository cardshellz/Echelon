import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import type { DropshipMarketplaceListingPushProvider } from "../../application/dropship-marketplace-listing-push-provider";
import {
  DropshipListingPushWorkerService,
  type DropshipListingPushWorkerClaim,
  type DropshipListingPushWorkerItemRecord,
  type DropshipListingPushWorkerJobRecord,
  type DropshipListingPushWorkerRepository,
} from "../../application/dropship-listing-push-worker-service";
import type { DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";

const now = new Date("2026-05-01T19:00:00.000Z");

describe("DropshipListingPushWorkerService", () => {
  let repository: FakeListingPushWorkerRepository;
  let marketplacePush: FakeMarketplacePushProvider;
  let notificationSender: FakeNotificationSender;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPushWorkerService;

  beforeEach(() => {
    repository = new FakeListingPushWorkerRepository();
    marketplacePush = new FakeMarketplacePushProvider();
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = new DropshipListingPushWorkerService({
      repository,
      marketplacePush,
      notificationSender,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("pushes queued items and finalizes the job completed", async () => {
    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-001",
    });

    expect(marketplacePush.requests).toHaveLength(1);
    expect(marketplacePush.requests[0]).toMatchObject({
      vendorId: 10,
      storeConnectionId: 22,
      jobId: 30,
      jobItemId: 1,
      listingId: 100,
      productVariantId: 101,
      platform: "shopify",
      idempotencyKey: "process-001:1",
    });
    expect(result.job.status).toBe("completed");
    expect(result.summary).toEqual({
      total: 1,
      completed: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
    });
    expect(result.items[0]).toMatchObject({
      status: "completed",
      externalListingId: "external-listing-101",
    });
    expect(notificationSender.sent).toHaveLength(0);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_LISTING_PUSH_JOB_PROCESSED" });
  });

  it("blocks an item when preview hash drift is detected before external push", async () => {
    repository.items[0] = {
      ...repository.items[0],
      listing: {
        ...repository.items[0].listing!,
        lastPreviewHash: "changed-preview-hash",
      },
    };

    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-002",
    });

    expect(marketplacePush.requests).toHaveLength(0);
    expect(result.job.status).toBe("failed");
    expect(result.items[0]).toMatchObject({
      status: "blocked",
      errorCode: "DROPSHIP_LISTING_PREVIEW_DRIFT",
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_listing_push_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship listing push failed",
      idempotencyKey: "listing-push:30:failed",
      payload: {
        jobId: 30,
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        status: "failed",
        summary: {
          total: 1,
          completed: 0,
          failed: 0,
          blocked: 1,
          skipped: 0,
        },
        failedItems: [{
          itemId: 1,
          listingId: 100,
          productVariantId: 101,
          status: "blocked",
          errorCode: "DROPSHIP_LISTING_PREVIEW_DRIFT",
          errorMessage: "Listing preview hash no longer matches the vendor listing.",
          externalListingId: null,
        }],
        omittedFailureItemCount: 0,
      },
    });
  });

  it("marks provider failures without completing the job", async () => {
    marketplacePush.error = new DropshipError(
      "DROPSHIP_LISTING_PUSH_PROVIDER_NOT_CONFIGURED",
      "Provider missing.",
      { retryable: false },
    );

    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-003",
    });

    expect(result.job.status).toBe("failed");
    expect(result.items[0]).toMatchObject({
      status: "failed",
      errorCode: "DROPSHIP_LISTING_PUSH_PROVIDER_NOT_CONFIGURED",
      errorMessage: "Provider missing.",
    });
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_listing_push_failed",
      critical: true,
      channels: ["email", "in_app"],
      idempotencyKey: "listing-push:30:failed",
      payload: {
        jobId: 30,
        vendorId: 10,
        storeConnectionId: 22,
        platform: "shopify",
        status: "failed",
        summary: {
          total: 1,
          completed: 0,
          failed: 1,
          blocked: 0,
          skipped: 0,
        },
        failedItems: [{
          itemId: 1,
          listingId: 100,
          productVariantId: 101,
          status: "failed",
          errorCode: "DROPSHIP_LISTING_PUSH_PROVIDER_NOT_CONFIGURED",
          errorMessage: "Provider missing.",
          externalListingId: null,
        }],
        omittedFailureItemCount: 0,
      },
    });
  });

  it("does not fail the push worker when listing failure notification delivery fails", async () => {
    marketplacePush.error = new Error("marketplace unavailable");
    notificationSender.error = new Error("email unavailable");

    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-004",
    });

    expect(result.job.status).toBe("failed");
    expect(notificationSender.sent).toHaveLength(1);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_LISTING_PUSH_NOTIFICATION_FAILED",
        context: expect.objectContaining({
          jobId: 30,
          vendorId: 10,
          storeConnectionId: 22,
          failed: 1,
          blocked: 0,
          error: "email unavailable",
        }),
      }),
    ]));
  });
});

class FakeMarketplacePushProvider implements DropshipMarketplaceListingPushProvider {
  requests: Parameters<DropshipMarketplaceListingPushProvider["pushListing"]>[0][] = [];
  error: Error | null = null;

  async pushListing(input: Parameters<DropshipMarketplaceListingPushProvider["pushListing"]>[0]) {
    this.requests.push(input);
    if (this.error) {
      throw this.error;
    }
    return {
      status: input.existingExternalListingId ? "updated" as const : "created" as const,
      externalListingId: `external-listing-${input.productVariantId}`,
      externalOfferId: `external-offer-${input.productVariantId}`,
      rawResult: { accepted: true },
    };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];
  error: Error | null = null;

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

class FakeListingPushWorkerRepository implements DropshipListingPushWorkerRepository {
  job: DropshipListingPushWorkerJobRecord = {
    jobId: 30,
    vendorId: 10,
    storeConnectionId: 22,
    platform: "shopify",
    status: "queued",
    idempotencyKey: "push-job-001",
    requestHash: "request-hash",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  config: DropshipStoreListingConfig = {
    id: 7,
    storeConnectionId: 22,
    platform: "shopify",
    listingMode: "draft_first",
    inventoryMode: "managed_quantity_sync",
    priceMode: "vendor_defined",
    marketplaceConfig: {},
    requiredConfigKeys: [],
    requiredProductFields: [],
    isActive: true,
  };
  items: DropshipListingPushWorkerItemRecord[] = [makeQueuedItem()];

  async claimJob(): Promise<DropshipListingPushWorkerClaim> {
    if (this.job.status !== "queued") {
      return {
        job: this.job,
        config: this.config,
        items: this.items,
        claimed: false,
      };
    }
    this.job = { ...this.job, status: "processing" };
    return {
      job: this.job,
      config: this.config,
      items: this.items,
      claimed: true,
    };
  }

  async markItemProcessing(): Promise<boolean> {
    if (this.items[0].status !== "queued") {
      return false;
    }
    this.items[0] = { ...this.items[0], status: "processing" };
    return true;
  }

  async completeItem(input: Parameters<DropshipListingPushWorkerRepository["completeItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.items[0] = {
      ...this.items[0],
      status: "completed",
      externalListingId: input.pushResult.externalListingId,
      listing: this.items[0].listing ? {
        ...this.items[0].listing,
        status: input.intent.listingMode === "live" ? "active" : "paused",
        externalListingId: input.pushResult.externalListingId,
        externalOfferId: input.pushResult.externalOfferId,
      } : null,
    };
    return this.items[0];
  }

  async failItem(input: Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.items[0] = {
      ...this.items[0],
      status: "failed",
      errorCode: input.code,
      errorMessage: input.message,
    };
    return this.items[0];
  }

  async blockItem(input: Parameters<DropshipListingPushWorkerRepository["blockItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.items[0] = {
      ...this.items[0],
      status: "blocked",
      errorCode: input.code,
      errorMessage: input.message,
    };
    return this.items[0];
  }

  async finalizeJob() {
    const hasFailure = this.items.some((item) => item.status === "failed" || item.status === "blocked");
    this.job = {
      ...this.job,
      status: hasFailure ? "failed" : "completed",
      completedAt: now,
    };
    return {
      job: this.job,
      items: this.items,
      summary: {
        total: this.items.length,
        completed: this.items.filter((item) => item.status === "completed").length,
        failed: this.items.filter((item) => item.status === "failed").length,
        blocked: this.items.filter((item) => item.status === "blocked").length,
        skipped: 0,
      },
    };
  }
}

function makeQueuedItem(): DropshipListingPushWorkerItemRecord {
  return {
    itemId: 1,
    jobId: 30,
    listingId: 100,
    productVariantId: 101,
    status: "queued",
    previewHash: "preview-hash",
    externalListingId: null,
    errorCode: null,
    errorMessage: null,
    result: {
      listingIntent: {
        platform: "shopify",
        listingMode: "draft_first",
        inventoryMode: "managed_quantity_sync",
        priceMode: "vendor_defined",
        productVariantId: 101,
        sku: "SKU-101",
        title: "Toploader",
        description: "Rigid card protection.",
        category: "Protectors",
        brand: "Card Shellz",
        gtin: null,
        mpn: null,
        condition: "new",
        itemSpecifics: null,
        imageUrls: ["https://cdn.example.test/toploader.jpg"],
        priceCents: 1299,
        quantity: 4,
        marketplaceConfig: {},
      },
    },
    listing: {
      listingId: 100,
      productVariantId: 101,
      status: "queued",
      externalListingId: null,
      externalOfferId: null,
      lastPreviewHash: "preview-hash",
    },
  };
}
