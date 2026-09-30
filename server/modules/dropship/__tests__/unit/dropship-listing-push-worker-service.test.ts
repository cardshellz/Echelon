import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import { QuantityPublicationAdmissionError } from "../../../inventory-planning/domain/quantity-publication-admission";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import type { DropshipMarketplaceListingPushProvider } from "../../application/dropship-marketplace-listing-push-provider";
import {
  DropshipListingPushWorkerService,
  type DropshipListingIntentRefreshInput,
  type DropshipListingPushWorkerClaim,
  type DropshipListingPushWorkerEligibility,
  type DropshipListingPushWorkerItemRecord,
  type DropshipListingPushWorkerJobRecord,
  type DropshipListingPushWorkerRepository,
} from "../../application/dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingIntent, DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";

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

  it("blocks queued items when entitlement changes after the job is queued", async () => {
    repository.eligibility = {
      ...repository.eligibility,
      entitlementStatus: "lapsed",
    };

    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-005",
    });

    expect(marketplacePush.requests).toHaveLength(0);
    expect(result.job.status).toBe("failed");
    expect(result.summary).toEqual({
      total: 1,
      completed: 0,
      failed: 0,
      blocked: 1,
      skipped: 0,
    });
    expect(result.items[0]).toMatchObject({
      status: "blocked",
      errorCode: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
      errorMessage: "Dropship vendor entitlement no longer allows listing push.",
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
          failed: 0,
          blocked: 1,
          skipped: 0,
        },
        failedItems: [{
          itemId: 1,
          listingId: 100,
          productVariantId: 101,
          status: "blocked",
          errorCode: "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED",
          errorMessage: "Dropship vendor entitlement no longer allows listing push.",
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

  it("keeps the marketplace's own reason on a failed item, logs it, and names it in the vendor's notice", async () => {
    marketplacePush.error = new DropshipError(
      "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      "eBay listing push failed with HTTP 400: 25002 Invalid value for aspect (aspect: Brand)",
      { retryable: false, status: 400, endpoint: "PUT /sell/inventory/v1/inventory_item/SKU-101", providerErrors: [
        { errorId: 25002, message: "Invalid value for aspect", parameters: [{ name: "aspect", value: "Brand" }] },
        "not an entry",
      ] },
    );

    const result = await service.processJob({
      jobId: 30,
      workerId: "worker-1",
      idempotencyKey: "process-004",
    });

    expect(result.items[0]).toMatchObject({
      status: "failed",
      errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      errorMessage: "eBay listing push failed with HTTP 400: 25002 Invalid value for aspect (aspect: Brand)",
    });
    expect(repository.failInputs[0]?.providerErrors).toEqual([
      { errorId: 25002, message: "Invalid value for aspect", parameters: [{ name: "aspect", value: "Brand" }] },
    ]);
    expect(repository.failInputs[0]?.endpoint).toBe("PUT /sell/inventory/v1/inventory_item/SKU-101");
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_FAILED")).toMatchObject({
      context: {
        jobId: 30, itemId: 1, vendorId: 10, storeConnectionId: 22, listingId: 100, productVariantId: 101, platform: "shopify",
        errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", retryable: false, providerErrors: [{ errorId: 25002 }],
        endpoint: "PUT /sell/inventory/v1/inventory_item/SKU-101",
      },
    });
    expect(notificationSender.sent[0]?.message).toBe(
      "1 of 1 listing could not be sent to your store (job 30). First reason: eBay listing push failed with HTTP 400: 25002 Invalid value for aspect (aspect: Brand)",
    );
  });

  it("treats an unresolved prior stock attempt as an operator problem: not retryable, logged for a human, attempt kept for support", async () => {
    marketplacePush.error = new QuantityPublicationAdmissionError(
      "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED",
      "A prior provider quantity outcome requires reconciliation.",
      { attemptId: "482" },
    );

    const result = await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-005" });

    expect(result.items[0]).toMatchObject({ status: "failed", errorCode: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    expect(repository.failInputs[0]).toMatchObject({
      code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED",
      retryable: false,
      context: { attemptId: "482", operatorAction: true },
    });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toMatchObject({
      context: { jobId: 30, itemId: 1, errorCode: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", attemptId: "482" },
    });
  });

  it("lets a provider cooldown refusal be queued again", async () => {
    marketplacePush.error = new QuantityPublicationAdmissionError(
      "PUBLICATION_PROVIDER_COOLDOWN",
      "The provider retry window has not opened; no quantity request was sent.",
      { retryNotBefore: "2026-09-29T12:00:00.000Z" },
    );

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-006" });

    expect(repository.failInputs[0]).toMatchObject({
      code: "PUBLICATION_PROVIDER_COOLDOWN",
      retryable: true,
      context: { attemptId: null, operatorAction: false },
    });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toBeUndefined();
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

  describe("push-time refresh", () => {
    let refreshInputs: DropshipListingIntentRefreshInput[];

    function useJob(platform: "ebay" | "shopify", intent: Record<string, unknown>) {
      repository.job = { ...repository.job, platform };
      repository.config = { ...repository.config, platform };
      const queued = makeQueuedItem();
      repository.items = [{ ...queued, result: { listingIntent: { ...queued.result!.listingIntent as Record<string, unknown>,
        platform, ...intent } } }];
      refreshInputs = [];
      return new DropshipListingPushWorkerService({
        repository,
        marketplacePush,
        notificationSender,
        clock: { now: () => now },
        logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error: (event) => logs.push(event) },
        refreshListingIntent: async (input) => {
          refreshInputs.push(input);
          return { ...(repository.items[0].result!.listingIntent as DropshipMarketplaceListingIntent), marketplaceCategoryId: "261328", quantity: 7 };
        },
      });
    }

    it("hands the refresh the eBay category the item was queued with, and pushes what the refresh returns", async () => {
      const worker = useJob("ebay", { marketplaceCategoryId: "183438", marketplaceCategoryName: "Card Toploaders & Holders" });

      const result = await worker.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-ebay-1" });

      expect(refreshInputs).toEqual([{ jobId: 30, jobItemId: 1, vendorId: 10, storeConnectionId: 22, productVariantId: 101, queuedPriceCents: 1299,
        queuedMarketplaceCategory: { categoryId: "183438", categoryName: "Card Toploaders & Holders" } }]);
      expect(marketplacePush.requests[0].listingIntent).toMatchObject({ marketplaceCategoryId: "261328", quantity: 7 });
      expect(result.job.status).toBe("completed");
    });

    it("keeps the queued category number when its name is unusable", async () => {
      const worker = useJob("ebay", { marketplaceCategoryId: "183438", marketplaceCategoryName: "   " });

      await worker.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-ebay-2" });

      expect(refreshInputs[0].queuedMarketplaceCategory).toEqual({ categoryId: "183438", categoryName: null });
    });

    it.each([
      ["no category", { marketplaceCategoryId: null, marketplaceCategoryName: null }],
      ["an id that is not an eBay category number", { marketplaceCategoryId: "toploaders", marketplaceCategoryName: "Toploaders" }],
      ["a zero id", { marketplaceCategoryId: "0", marketplaceCategoryName: "Toploaders" }],
    ])("hands the refresh no queued category when the queued eBay intent has %s", async (_label, intent) => {
      const worker = useJob("ebay", intent);

      await worker.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-ebay-3" });

      expect(refreshInputs[0].queuedMarketplaceCategory).toBeNull();
    });

    it("never hands a queued eBay category to the refresh of a store that is not eBay", async () => {
      const worker = useJob("shopify", { marketplaceCategoryId: "183438", marketplaceCategoryName: "Card Toploaders & Holders" });

      await worker.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-shopify-1" });

      expect(refreshInputs[0].queuedMarketplaceCategory).toBeNull();
    });
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
  eligibility: DropshipListingPushWorkerEligibility = {
    vendorStatus: "active",
    entitlementStatus: "active",
    storeStatus: "connected",
    setupStatus: "ready",
    storeLaunchReady: true,
  };

  async claimJob(): Promise<DropshipListingPushWorkerClaim> {
    if (this.job.status !== "queued") {
      return {
        job: this.job,
        config: this.config,
        eligibility: this.eligibility,
        items: this.items,
        claimed: false,
      };
    }
    this.job = { ...this.job, status: "processing" };
    return {
      job: this.job,
      config: this.config,
      eligibility: this.eligibility,
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

  failInputs: Array<Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]> = [];

  async failItem(input: Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.failInputs.push(input);
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
