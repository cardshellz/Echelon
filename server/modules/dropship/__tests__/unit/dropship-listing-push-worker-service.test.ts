import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import { stockLinkError, stockLinkRefusal } from "../../domain/stock-link-readiness";
import { QuantityPublicationAdmissionError } from "../../../inventory-planning/domain/quantity-publication-admission";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import type { DropshipMarketplaceListingPushProvider } from "../../application/dropship-marketplace-listing-push-provider";
import {
  DropshipListingPushWorkerService,
  classifyStockGateRefusal,
  type DropshipListingIntentRefreshInput,
  type DropshipListingPushWorkerClaim,
  type DropshipListingPushWorkerEligibility,
  type DropshipListingPushWorkerItemRecord,
  type DropshipListingPushWorkerJobRecord,
  type DropshipListingPushPauseOutcome,
  type DropshipListingPushWorkerRepository,
} from "../../application/dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingIntent, DropshipStoreListingConfig } from "../../application/dropship-marketplace-listing-provider";
import type { MarketplacePrePushInput, MarketplacePrePushResult } from "../../application/dropship-marketplace-sync-service";
import type { MarketplacePushGuard } from "../../domain/marketplace-sync-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../../domain/marketplace-sync-errors";

const now = new Date("2026-05-01T19:00:00.000Z");

describe("classifyStockGateRefusal", () => {
  it("names each stock-gate code's class from its throwing condition", () => {
    expect(classifyStockGateRefusal("PUBLICATION_PRIOR_OUTCOME_UNRESOLVED")).toBe("operator");
    for (const code of ["PUBLICATION_LISTING_TARGET_UNMAPPED", "PUBLICATION_LISTING_PLAN_OMITTED", "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED"]) {
      expect(classifyStockGateRefusal(code)).toBe("permanent");
    }
    for (const code of ["QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_SCOPE_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY",
      "PUBLICATION_PROVIDER_COOLDOWN", "QUANTITY_PUBLICATION_SUPPRESSED", "PUBLICATION_GLOBAL_STOP_ACTIVE",
      "PUBLICATION_AUTHORITY_CHANGED", "PUBLICATION_CANONICAL_LISTING_PLAN_CHANGED", "UNKNOWN_CODE"]) {
      expect(classifyStockGateRefusal(code)).toBe("transient");
    }
  });
});

describe("DropshipListingPushWorkerService", () => {
  let repository: FakeListingPushWorkerRepository;
  let marketplacePush: FakeMarketplacePushProvider;
  let notificationSender: FakeNotificationSender;
  let outlook: FakeAutomaticRequeueOutlook;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPushWorkerService;

  beforeEach(() => {
    repository = new FakeListingPushWorkerRepository();
    marketplacePush = new FakeMarketplacePushProvider();
    notificationSender = new FakeNotificationSender();
    outlook = new FakeAutomaticRequeueOutlook();
    logs = [];
    service = new DropshipListingPushWorkerService({
      repository,
      marketplacePush,
      notificationSender,
      automaticRequeueOutlook: outlook,
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
    // Review TW-7: the item is not marked for review (an admin retry does not re-drive it; the operator attests the
    // prior attempt), so the line says operator_action, not requires_review.
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toMatchObject({
      context: { jobId: 30, itemId: 1, errorCode: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", attemptId: "482", outcome: "operator_action" },
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

  // Stock-gate refusals a retry meets again until Card Shellz or the vendor
  // changes something are permanent in the dropship worker (F6): an ops retry
  // and the legacy catch-up requeue only retryable items.
  it.each([
    ["PUBLICATION_LISTING_TARGET_UNMAPPED", "Listing quantity requires one exact active canonical target/mapping; configure it before publishing.", true],
    ["PUBLICATION_LISTING_PLAN_OMITTED", "The current canonical plan did not authorize this exact listing; an older outbox quantity is not authority.", true],
    ["PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", "Provider-verified eBay store identity is required before publishing quantity.", false],
  ])("records %s as permanent (retryable false)", async (code, message, needsStockSetup) => {
    marketplacePush.error = new QuantityPublicationAdmissionError(code, message, { scope: { connectionId: 22 } });

    const result = await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-perm" });

    expect(result.items[0]).toMatchObject({ status: "failed", errorCode: code });
    expect(repository.failInputs[0]).toMatchObject({
      code,
      message,
      retryable: false,
      context: { attemptId: null, operatorAction: false, classification: "permanent" },
    });
    expect(Boolean(repository.failInputs[0]?.context?.requiresReview)).toBe(needsStockSetup);
    const setupLog = logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_STOCK_SETUP");
    if (needsStockSetup) {
      expect(setupLog).toMatchObject({
        context: { jobId: 30, itemId: 1, vendorId: 10, storeConnectionId: 22, listingId: 100, productVariantId: 101,
          errorCode: code, outcome: "requires_review", classification: "permanent" },
      });
    } else {
      expect(setupLog).toBeUndefined();
    }
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toBeUndefined();
  });

  // Review MC-3 (owner Q4: re-send only what failed "before this deploys"): an
  // UNMAPPED refusal this worker records carries the marker that keeps it out of the
  // one-time automatic re-send. Review V2-1: every other re-queue code it records
  // carries it too, and only such failures are re-queued; codes the re-queue does
  // not own never get it.
  it.each([
    ["PUBLICATION_LISTING_TARGET_UNMAPPED", true],
    ["PUBLICATION_LISTING_PLAN_OMITTED", false],
    ["PUBLICATION_SCOPE_BUSY", true],
    ["QUANTITY_PUBLICATION_DRAIN_BUSY", false],
  ] as const)("records %s with the automatic stock link marker: %s", async (code, marked) => {
    marketplacePush.error = new QuantityPublicationAdmissionError(code, "refused", { scope: { connectionId: 22 } });

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-marker" });

    expect(repository.failInputs[0]?.context?.recordedWithAutomaticStockLink).toBe(marked ? true : undefined);
  });

  it.each([
    ["DROPSHIP_STOCK_LINK_BUSY", true],
    ["DROPSHIP_STOCK_UPDATES_PAUSED", true],
    ["DROPSHIP_STOCK_DESTINATION_NOT_READY", false],
  ] as const)("records the stock link refusal %s with the automatic stock link marker: %s", async (code, marked) => {
    marketplacePush.error = stockLinkError(stockLinkRefusal(code, { inventoryCode: "STOCK_MAPPING_PROVIDER_BUSY" }));

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-marker-stock" });

    expect(repository.failInputs[0]?.context?.recordedWithAutomaticStockLink).toBe(marked ? true : undefined);
  });

  // Review TW-1: the run the stock link recovery queued (its marker's key is the item's last retry request) is
  // flagged, so the gate refuses to adopt an eBay listing the vendor listing never recorded; any other run is not.
  it.each([
    ["the automatic re-queue's own run", { automaticRequeue: { count: 1, resend: true, idempotencyKey: "auto-1" },
      lastRetryRequest: { idempotencyKey: "auto-1", actorType: "system", actorId: "system:dropship-stock-link-requeue" } }, true],
    ["an admin retry after an automatic re-queue", { automaticRequeue: { count: 1, resend: true, idempotencyKey: "auto-1" },
      lastRetryRequest: { idempotencyKey: "admin-2", actorType: "admin", actorId: "admin-7" } }, false],
    ["a marker another actor wrote", { automaticRequeue: { count: 1, idempotencyKey: "auto-1" },
      lastRetryRequest: { idempotencyKey: "auto-1", actorType: "system", actorId: "system:other" } }, false],
    ["a vendor's queued push", {}, false],
  ] as const)("flags %s as an automatic retry: %s", async (_name, extra, automatic) => {
    const queued = makeQueuedItem();
    repository.items = [{ ...queued, result: { ...queued.result, ...extra } }];

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-auto" });

    expect(marketplacePush.requests[0]?.automaticRetry).toBe(automatic ? true : undefined);
  });

  it.each([
    "QUANTITY_PUBLICATION_DRAIN_BUSY",
    "PUBLICATION_SCOPE_BUSY",
    "PUBLICATION_ADMISSION_CAPACITY_BUSY",
    "PUBLICATION_PROVIDER_COOLDOWN",
    "QUANTITY_PUBLICATION_SUPPRESSED",
    "PUBLICATION_GLOBAL_STOP_ACTIVE",
    "PUBLICATION_AUTHORITY_CHANGED",
    "PUBLICATION_CANONICAL_LISTING_PLAN_CHANGED",
    "PUBLICATION_LISTING_PLAN_MISSING",
    "SOME_FUTURE_STOCK_CODE",
  ])("keeps %s retryable: it clears by itself", async (code) => {
    marketplacePush.error = new QuantityPublicationAdmissionError(code, "Stock gate refused for now.");

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-transient" });

    expect(repository.failInputs[0]).toMatchObject({ code, retryable: true });
    // PUBLICATION_SCOPE_BUSY is the one the automatic re-queue owns, so it carries the marker (review V2-1).
    expect(repository.failInputs[0]?.context).toEqual({ attemptId: null, operatorAction: false,
      ...(code === "PUBLICATION_SCOPE_BUSY" ? { recordedWithAutomaticStockLink: true } : {}) });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_STOCK_SETUP")).toBeUndefined();
  });

  // Fix PR 2a-2 (plan F2 2.11): the automatic stock link's refusals.
  it.each([
    ["DROPSHIP_STOCK_DESTINATION_NOT_READY", stockLinkRefusal("DROPSHIP_STOCK_DESTINATION_NOT_READY", { inventoryCode: "STOCK_LISTING_TARGET_MISMATCH", targetCount: 0 })],
    ["DROPSHIP_STOCK_LINK_FAILED", stockLinkRefusal("DROPSHIP_STOCK_LINK_FAILED", { inventoryCode: "PUBLICATION_AUTHORITY_MISSING" })],
  ])("files %s as an operator problem: not retryable, marked for review, logged at ERROR", async (code, refusal) => {
    marketplacePush.error = stockLinkError(refusal, { command_key: "5e0f7f3c-2a4b-5c6d-8e9f-0a1b2c3d4e5f" });

    const result = await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-stock-operator" });

    expect(result.items[0]).toMatchObject({ status: "failed", errorCode: code, errorMessage: refusal.message });
    expect(repository.failInputs[0]).toMatchObject({ code, retryable: false, context: {
      inventoryCode: refusal.inventoryCode, operatorAction: true, targetCount: refusal.targetCount, classification: refusal.classification,
      commandKey: "5e0f7f3c-2a4b-5c6d-8e9f-0a1b2c3d4e5f", requiresReview: true } });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toMatchObject({
      message: "A listing push item is blocked until an operator resolves it.",
      context: { jobId: 30, itemId: 1, errorCode: code, inventoryCode: refusal.inventoryCode, outcome: "requires_review" } });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_STOCK_SETUP")).toBeUndefined();
    expect(notificationSender.sent[0]?.message).toBe(`1 of 1 listing could not be sent to your store (job 30). First reason: ${refusal.message}`);
  });

  // Review TW-3: the vendor's email for a code the push sweep re-queues by itself says so; while an automatic
  // re-queue is still to come no second email is sent; once they are over, the final reason gets one more email.
  describe("failure email around the automatic re-queue", () => {
    const busy = () => stockLinkError(stockLinkRefusal("DROPSHIP_STOCK_LINK_BUSY", { inventoryCode: "STOCK_MAPPING_PROVIDER_BUSY" }));
    const afterRequeues = (count: number, lastCode = "DROPSHIP_STOCK_LINK_BUSY") => {
      const queued = makeQueuedItem();
      repository.items = [{ ...queued, result: { ...queued.result,
        automaticRequeue: { count, lastCode, idempotencyKey: `auto-${count}`, resend: false },
        lastRetryRequest: { idempotencyKey: `auto-${count}`, actorType: "system", actorId: "system:dropship-stock-link-requeue" } } }];
    };

    it("tells the vendor a busy stock link is tried again automatically", async () => {
      marketplacePush.error = busy();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-1" });
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({ idempotencyKey: "listing-push:30:failed",
        message: "1 of 1 listing could not be sent to your store (job 30). First reason: Card Shellz stock for this item was being updated at the same moment. Card Shellz will try it again automatically." });
      // Asked with the sweep's own guards, once the job is final (review V2-2).
      expect(outlook.calls).toEqual([30]);
    });

    // Review V2-2: the sweep's store, vendor or listing guards exclude the item (for example an unverified store
    // whose authority read was busy), so no automatic retry is coming: the email does not promise one.
    it("does not promise an automatic retry the sweep's guards exclude", async () => {
      outlook.pending = [];
      marketplacePush.error = busy();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-guards" });
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({ idempotencyKey: "listing-push:30:failed",
        message: "1 of 1 listing could not be sent to your store (job 30). First reason: Card Shellz stock for this item was being updated at the same moment." });
    });

    it("sends the final email when the guards exclude an item that was already re-queued", async () => {
      afterRequeues(1);
      outlook.pending = [];
      marketplacePush.error = busy();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-guards-2" });
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({ idempotencyKey: "listing-push:30:failed:after-automatic-retry",
        message: "1 of 1 listing could not be sent to your store (job 30). First reason: Card Shellz stock for this item was being updated at the same moment." });
    });

    it("promises nothing, and logs a WARN, when the pending items cannot be read", async () => {
      outlook.error = new Error("connection reset");
      marketplacePush.error = busy();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-outlook-failed" });
      expect(notificationSender.sent[0]?.message).toBe(
        "1 of 1 listing could not be sent to your store (job 30). First reason: Card Shellz stock for this item was being updated at the same moment.");
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_AUTOMATIC_REQUEUE_OUTLOOK_FAILED")).toMatchObject({
        context: { jobId: 30, itemIds: [1], outcome: "no_automatic_retry_promised", error: "connection reset" } });
    });

    it("reads nothing when no failed item can be re-queued (a code it does not own, or the cap reached)", async () => {
      marketplacePush.error = stockLinkError(stockLinkRefusal("DROPSHIP_STOCK_DESTINATION_NOT_READY", { inventoryCode: "STOCK_LISTING_TARGET_MISMATCH" }));
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-no-read" });
      expect(outlook.calls).toEqual([]);
    });

    it("sends nothing more while another automatic re-queue is still to come", async () => {
      afterRequeues(1);
      marketplacePush.error = busy();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-2" });
      expect(notificationSender.sent).toEqual([]);
    });

    it.each([
      ["a code that is not re-queued", 1, () => stockLinkError(stockLinkRefusal("DROPSHIP_STOCK_DESTINATION_NOT_READY",
        { inventoryCode: "STOCK_LISTING_TARGET_MISMATCH" })), "Card Shellz hasn't turned on stock updates for your eBay store yet."],
      ["the last allowed re-queue", 3, busy, "Card Shellz stock for this item was being updated at the same moment."],
    ] as const)("emails the final reason once after the automatic re-queues: %s", async (_name, count, error, reason) => {
      afterRequeues(count);
      marketplacePush.error = error();
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-email-3" });
      // Neither can be re-queued again, so the repository is not even asked (review V2-2).
      expect(outlook.calls).toEqual([]);
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({ idempotencyKey: "listing-push:30:failed:after-automatic-retry",
        message: `1 of 1 listing could not be sent to your store (job 30). First reason: ${reason}` });
    });

    // Rebase of PR A onto Fix PR 2a: a publish run's chunk job sends no email of its own (its run sends one when it
    // finishes), and the sweep never re-queues it (stockLinkCandidateSql: run_id null), so neither of 2a's emails
    // (the first failure's, the one after the automatic retries) is sent for it and the pending items are not read.
    it.each([["its first failure", null], ["after an automatic re-queue", 1]] as const)(
      "sends a publish run's chunk job no per-job email for a code the sweep re-queues: %s", async (_name, count) => {
        if (count !== null) afterRequeues(count);
        repository.job = { ...repository.job, runId: 4 };
        marketplacePush.error = busy();
        await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: `process-run-email-${count}` });
        expect(repository.failInputs[0]).toMatchObject({ code: "DROPSHIP_STOCK_LINK_BUSY", retryable: true });
        expect(notificationSender.sent).toEqual([]);
        expect(outlook.calls).toEqual([]);
      });

    // Rebase of PR A onto Fix PR 2a: the stock link's bounded in-process retries run inside the one item being sent
    // (gate and provider, per pushListing call). A stop that lands meanwhile cancels the chunk's queued items; the next
    // one is cancelled at its start (markItemProcessing reads the run), so only the item already being sent finishes.
    it("lets a stop that lands during one chunk item's in-process stock link retries cancel the next item at its start", async () => {
      const second = { ...makeQueuedItem(), itemId: 2, listingId: 200, productVariantId: 102,
        listing: { ...makeQueuedItem().listing!, listingId: 200, productVariantId: 102 } };
      repository.items = [makeQueuedItem(), second];
      repository.job = { ...repository.job, runId: 4 };
      marketplacePush.beforeAnswer = async () => { repository.runStopRequested = true; };
      marketplacePush.errors = [busy()];
      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-run-stop" });
      expect(marketplacePush.requests.map((request) => request.jobItemId)).toEqual([1]);
      expect(repository.items.map((item) => [item.itemId, item.status])).toEqual([[1, "failed"], [2, "cancelled"]]);
      expect(repository.markInputs.map((input) => input.itemId)).toEqual([1, 2]);
      expect(repository.finalizeCalls).toBe(1);
      expect(notificationSender.sent).toEqual([]);
    });
  });

  it.each(["DROPSHIP_STOCK_LINK_BUSY", "DROPSHIP_STOCK_UPDATES_PAUSED"] as const)(
    "keeps %s retryable for the automatic re-queue, with no ERROR line", async (code) => {
      marketplacePush.error = stockLinkError(stockLinkRefusal(code, { inventoryCode: "STOCK_MAPPING_PROVIDER_BUSY" }));

      await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-stock-transient" });

      expect(repository.failInputs[0]).toMatchObject({ code, retryable: true,
        context: { operatorAction: false, classification: "transient", inventoryCode: "STOCK_MAPPING_PROVIDER_BUSY" } });
      expect(repository.failInputs[0]?.context).not.toHaveProperty("requiresReview");
      expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toBeUndefined();
    });

  it("files a vendor-fixable stock link refusal as permanent with no operator line", async () => {
    marketplacePush.error = stockLinkError(stockLinkRefusal("DROPSHIP_STOCK_SKU_CHANGED", { inventoryCode: "STOCK_LISTING_SOURCE_CHANGED" }));

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-stock-vendor" });

    expect(repository.failInputs[0]).toMatchObject({ code: "DROPSHIP_STOCK_SKU_CHANGED", retryable: false,
      context: { operatorAction: false, classification: "permanent" } });
    expect(repository.failInputs[0]?.context).not.toHaveProperty("requiresReview");
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_NEEDS_OPERATOR")).toBeUndefined();
  });

  it("leaves other DropshipErrors' stored context unchanged", async () => {
    marketplacePush.error = new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay listing push failed with HTTP 500.", { retryable: true });

    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-other" });

    expect(repository.failInputs[0]).toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", retryable: true });
    expect(repository.failInputs[0]?.context).toBeUndefined();
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

describe("DropshipListingPushWorkerService pauses, breakers and runs (step 1 plan S2-5, §4.5)", () => {
  let repository: FakeListingPushWorkerRepository;
  let marketplacePush: FakeMarketplacePushProvider;
  let notificationSender: FakeNotificationSender;
  let logs: DropshipLogEvent[];
  let service: DropshipListingPushWorkerService;
  const httpError = (status: number, method: string) => new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
    `eBay listing push failed with HTTP ${status}.`, { retryable: status === 429 || status >= 500, status, method, endpoint: `${method} /sell/x` });

  beforeEach(() => {
    repository = new FakeListingPushWorkerRepository();
    repository.items = [makeQueuedItem(), { ...makeQueuedItem(), itemId: 2, listingId: 200, productVariantId: 102,
      listing: { ...makeQueuedItem().listing!, listingId: 200, productVariantId: 102 } }];
    marketplacePush = new FakeMarketplacePushProvider();
    notificationSender = new FakeNotificationSender();
    logs = [];
    service = new DropshipListingPushWorkerService({
      repository, marketplacePush, notificationSender, clock: { now: () => now },
      logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
  });

  it("pauses on a 429, even on a write: the item and job go back, the job is not finalized, nothing more is sent", async () => {
    marketplacePush.errors = [httpError(429, "PUT")];
    const result = await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-101" });
    expect(repository.pauseInputs).toHaveLength(1);
    expect(repository.pauseInputs[0]).toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", reason: "rate_limited", item: { itemId: 1 } });
    expect(repository.finalizeCalls).toBe(0);
    expect(marketplacePush.requests).toHaveLength(1);
    expect(repository.failInputs).toEqual([]);
    expect(result.job.status).toBe("queued");
    expect(notificationSender.sent).toEqual([]);
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_PAUSED")?.context).toMatchObject({
      jobId: 30, itemId: 1, reason: "rate_limited", jobConsecutivePauses: 1, nextAttemptAt: new Date(now.getTime() + 60_000).toISOString() });
  });

  it("a pausable answer for an item whose run was stopped cancels it and finalizes the job, never failing it (review MC4)", async () => {
    repository.runStopped = true;
    marketplacePush.errors = [httpError(429, "PUT")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-mc4" });
    expect(repository.pauseInputs).toHaveLength(1);
    expect(repository.items[0].status).toBe("cancelled");
    expect(repository.failInputs).toEqual([]);
    // The job carries on to its finalize instead of waiting for a backoff (the second item is the fake's queued one).
    expect(repository.finalizeCalls).toBe(1);
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_CANCELLED_AFTER_STOP")?.context).toMatchObject({ jobId: 30, itemId: 1 });
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_PAUSED")).toBeUndefined();
  });

  it("pauses on a 5xx from a read, and fails a 5xx from a write retryable as before", async () => {
    marketplacePush.errors = [httpError(503, "GET")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-102" });
    expect(repository.pauseInputs).toHaveLength(1);
    expect(repository.pauseInputs[0].reason).toBe("read_unavailable");

    const write = new FakeListingPushWorkerRepository();
    marketplacePush.errors = [httpError(503, "POST")];
    const writer = new DropshipListingPushWorkerService({ repository: write, marketplacePush, notificationSender, clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    const result = await writer.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-103" });
    expect(write.pauseInputs).toEqual([]);
    expect(write.failInputs[0]).toMatchObject({ code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", retryable: true });
    expect(result.job.status).toBe("failed");
  });

  it("starts each item with the job's heartbeat (markItemProcessing) before anything is sent", async () => {
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-104" });
    expect(repository.markInputs).toEqual([{ jobId: 30, itemId: 1, workerId: "worker-1", now }, { jobId: 30, itemId: 2, workerId: "worker-1", now }]);
    expect(marketplacePush.requests.map((request) => request.jobItemId)).toEqual([1, 2]);
  });

  it("fails an item retryable once it has paused five times, and goes on to the next", async () => {
    repository.items[0] = { ...repository.items[0], result: { ...repository.items[0].result, transientPauses: 5 } };
    marketplacePush.errors = [httpError(429, "GET")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-105" });
    expect(repository.pauseInputs).toEqual([]);
    expect(repository.failInputs[0]).toMatchObject({ item: { itemId: 1 }, retryable: true });
    expect(repository.items.map((item) => item.status)).toEqual(["failed", "completed"]);
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_ITEM_PAUSE_LIMIT")).toBeDefined();
  });

  it("trips the job breaker on a pausable error after six pauses in a row, then finalizes", async () => {
    repository.job = { ...repository.job, consecutivePauseCount: 6, runId: 4 };
    marketplacePush.errors = [httpError(429, "PUT")];
    const result = await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-106" });
    expect(repository.tripInputs).toHaveLength(1);
    expect(repository.tripInputs[0]).toMatchObject({ code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE",
      message: "eBay wasn't answering, so this size wasn't sent. Publish again later.", job: { runId: 4 } });
    expect(marketplacePush.requests).toHaveLength(1);
    expect(repository.finalizeCalls).toBe(1);
    expect(result.items.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_JOB_BREAKER_TRIPPED")?.context).toMatchObject({ failedItems: 2, runStopped: true });
    // A run's chunk sends no email of its own.
    expect(notificationSender.sent).toEqual([]);
  });

  it("a completed item ends the job's run of pauses: the next pausable error pauses instead of tripping", async () => {
    repository.job = { ...repository.job, consecutivePauseCount: 6 };
    marketplacePush.errors = [null, httpError(429, "PUT")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-107" });
    expect(repository.tripInputs).toEqual([]);
    expect(repository.pauseInputs).toHaveLength(1);
    expect(repository.pauseInputs[0].item.itemId).toBe(2);
  });

  it("an item eBay refused with a definite answer (a 400) ends the job's run of pauses too, in the same write (review round 2 MC4)", async () => {
    repository.job = { ...repository.job, consecutivePauseCount: 6 };
    marketplacePush.errors = [httpError(400, "PUT"), httpError(429, "PUT")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-107b" });
    expect(repository.failInputs).toHaveLength(1);
    expect(repository.failInputs[0]).toMatchObject({ item: { itemId: 1 }, retryable: false, endsPauseRun: true });
    expect(repository.tripInputs).toEqual([]);
    expect(repository.pauseInputs).toHaveLength(1);
    expect(repository.pauseInputs[0].item.itemId).toBe(2);
  });

  it("a write eBay answered 5xx, or a failure that never reached eBay, does not end the run of pauses", async () => {
    repository.job = { ...repository.job, consecutivePauseCount: 6 };
    marketplacePush.errors = [httpError(503, "POST"), httpError(429, "PUT")];
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-107c" });
    expect(repository.failInputs[0]).toMatchObject({ item: { itemId: 1 }, retryable: true, endsPauseRun: false });
    expect(repository.tripInputs).toHaveLength(1);
  });

  it("blocks a size no longer selected at push time, for good, as not selected", async () => {
    const refreshing = new DropshipListingPushWorkerService({
      repository, marketplacePush, notificationSender, clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      refreshListingIntent: async (input) => {
        if (input.productVariantId === 101) {
          throw new DropshipError("DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED", "Current listing rules do not authorize this queued publication.",
            { productVariantId: 101, blockers: ["selection:missing_vendor_include_rule"], retryable: true });
        }
        return repository.items[1].result!.listingIntent as never;
      },
    });
    await refreshing.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-108" });
    expect(repository.blockInputs).toHaveLength(1);
    expect(repository.blockInputs[0]).toMatchObject({ code: "DROPSHIP_LISTING_NOT_SELECTED",
      message: "This size is no longer chosen to sell, so it wasn't sent.", item: { itemId: 1 } });
    expect(repository.failInputs).toEqual([]);
    expect(marketplacePush.requests.map((request) => request.jobItemId)).toEqual([2]);
  });

  it("keeps other blocked refreshes on today's retryable failure path", async () => {
    const refreshing = new DropshipListingPushWorkerService({
      repository, marketplacePush, notificationSender, clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      refreshListingIntent: async () => {
        throw new DropshipError("DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED", "Current listing rules do not authorize this queued publication.",
          { blockers: ["content:missing_title"], retryable: true });
      },
    });
    await refreshing.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-109" });
    expect(repository.blockInputs).toEqual([]);
    expect(repository.failInputs.map((input) => [input.code, input.retryable])).toEqual([
      ["DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED", true], ["DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED", true]]);
  });

  it("a run's chunk job sends no per-job email; any other job still does", async () => {
    repository.job = { ...repository.job, runId: 4 };
    marketplacePush.error = new DropshipError("DROPSHIP_LISTING_PUSH_PROVIDER_NOT_CONFIGURED", "Provider missing.", { retryable: false });
    await service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "process-110" });
    expect(repository.failInputs).toHaveLength(2);
    expect(notificationSender.sent).toEqual([]);
  });
});

describe("DropshipListingPushWorkerService: eBay sync-back's push-time rule (plan v4 §5)", () => {
  const guard: MarketplacePushGuard = { offerId: "OFFER-1", listingId: "110000000002", priceCents: 1400, currency: "USD",
    fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1", bestOfferTermsHash: null, offerDescriptionHash: "d".repeat(64),
    availableQuantity: 10 };
  const passthrough = { bestOfferTerms: null, title: "Vendor's own title", description: null,
    carriedFingerprints: { title: "c".repeat(64), description: null } };
  const sent = { priceCents: 1400, currency: "USD", sku: "SKU-101", fulfillmentPolicyId: "F-9", returnPolicyId: "R-1", paymentPolicyId: "P-1",
    titleHash: "a".repeat(64), descriptionHash: "b".repeat(64) };

  function setup(options: { preRead?: MarketplacePrePushResult | Error; platform?: "ebay" | "shopify"; offerId?: string | null;
    result?: Record<string, unknown>; wired?: boolean } = {}) {
    const repository = new FakeListingPushWorkerRepository();
    const platform = options.platform ?? "ebay";
    repository.job = { ...repository.job, platform };
    repository.config = { ...repository.config, platform };
    const item = makeQueuedItem();
    repository.items = [{ ...item, result: { ...item.result, ...options.result, listingIntent: { ...parseIntent(item.result), platform } },
      listing: { ...item.listing!, status: "active", externalListingId: "110000000001",
        externalOfferId: options.offerId === undefined ? "OFFER-1" : options.offerId } }];
    const marketplacePush = new FakeMarketplacePushProvider();
    const notificationSender = new FakeNotificationSender();
    const order: string[] = [];
    const preReads: MarketplacePrePushInput[] = [];
    const attempts: Array<{ listingId: number; jobId: number; jobItemId: number; sent: unknown }> = [];
    const logs: DropshipLogEvent[] = [];
    const preRead = options.preRead ?? { externalListingId: "110000000002", externalOfferId: "OFFER-1", guard, passthrough,
      liveFulfillmentPolicyId: "F-9" };
    const service = new DropshipListingPushWorkerService({
      repository, marketplacePush, notificationSender,
      refreshListingIntent: async (input) => { order.push("refresh"); return { ...parseIntent(repository.items[0].result), priceCents: 1400,
        productVariantId: input.productVariantId }; },
      ...(options.wired === false ? {} : { marketplaceSync: {
        async syncListingBeforePush(input) { order.push("pre_read"); preReads.push(input); if (preRead instanceof Error) throw preRead; return preRead; },
        async recordPushAttempt(input) { attempts.push(input); },
      } }),
      clock: { now: () => now },
      logger: { info: (event) => logs.push(event), warn: (event) => logs.push(event), error: (event) => logs.push(event) },
    });
    marketplacePush.beforeAnswer = async () => { order.push("push"); };
    return { service, repository, marketplacePush, notificationSender, order, preReads, attempts, logs };
  }

  it("reads eBay before the refresh, then pushes to the ids it answers with its guard and passthrough, recording the attempt", async () => {
    const f = setup({ result: { relistAllowed: true } });
    await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-001" });

    expect(f.order).toEqual(["pre_read", "refresh", "push"]);
    expect(f.preReads).toEqual([{ vendorId: 10, storeConnectionId: 22, listingId: 100, productVariantId: 101, jobId: 30, jobItemId: 1,
      relistAllowed: true }]);
    const request = f.marketplacePush.requests[0]!;
    // SB6: a relist eBay made under a new item number is pushed to that number.
    expect(request).toMatchObject({ existingExternalListingId: "110000000002", existingExternalOfferId: "OFFER-1", listingIntent: { priceCents: 1400 },
      marketplaceSync: { guard, passthrough, liveFulfillmentPolicyId: "F-9" } });
    await request.marketplaceSync!.beforeFirstWrite(sent);
    expect(f.attempts).toEqual([{ listingId: 100, jobId: 30, jobItemId: 1, sent }]);
    expect(f.repository.items[0]).toMatchObject({ status: "completed" });
  });

  it.each([
    ["a first push (no saved offer id)", { offerId: null }],
    ["a listing on another marketplace", { platform: "shopify" as const }],
    ["a worker without sync-back wired", { wired: false }],
  ])("reads nothing for %s and pushes exactly as before", async (_name, options) => {
    const f = setup(options);
    await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-002" });
    expect(f.preReads).toEqual([]);
    expect(f.marketplacePush.requests[0]).not.toHaveProperty("marketplaceSync");
    expect(f.marketplacePush.requests[0]).toMatchObject({ existingExternalListingId: "110000000001" });
  });

  it("never relists a listing the vendor ended: the item is skipped quietly, nothing is refreshed or sent, and no email goes", async () => {
    const f = setup({ preRead: marketplaceSyncError(MARKETPLACE_SYNC_CODES.endedOnEbay, "ended", "permanent") });
    const result = await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-003" });

    expect(f.order).toEqual(["pre_read"]);
    expect(f.marketplacePush.requests).toEqual([]);
    expect(f.repository.skipInputs).toEqual([expect.objectContaining({ code: "DROPSHIP_LISTING_ENDED_ON_EBAY", workerId: "worker-1" })]);
    expect(f.repository.failInputs).toEqual([]);
    expect(f.repository.items[0]!.status).toBe("cancelled");
    expect(result.job.status).toBe("completed");
    expect(f.notificationSender.sent).toEqual([]);
    expect(f.logs).toContainEqual(expect.objectContaining({ code: "DROPSHIP_LISTING_ENDED_ON_EBAY",
      context: expect.objectContaining({ outcome: "skipped", listingId: 100 }) }));
  });

  it.each([
    [MARKETPLACE_SYNC_CODES.quantityPending, "pre_read"],
    [MARKETPLACE_SYNC_CODES.adoptionRetry, "pre_read"],
    [MARKETPLACE_SYNC_CODES.changedDuringPush, "push"],
  ])("pauses the item with nothing written when %s", async (code, where) => {
    const refusal = marketplaceSyncError(code, "wait", "transient");
    const f = setup(where === "pre_read" ? { preRead: refusal } : {});
    if (where === "push") f.marketplacePush.errors = [refusal];
    const result = await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-004" });

    expect(f.repository.pauseInputs).toEqual([expect.objectContaining({ code, reason: "marketplace_sync" })]);
    expect(f.repository.failInputs).toEqual([]);
    expect(f.repository.items[0]!.status).toBe("queued");
    expect(result.job.status).toBe("queued");
    if (where === "pre_read") expect(f.marketplacePush.requests).toEqual([]);
  });

  // Review OR-4 (owner rules 1 and 7): a lower eBay number waiting for the order poll is no failure and no notice.
  it.each([
    ["the item's pause limit", { transientPauses: 5 }, 0],
    ["the job's pause breaker", {}, 6],
  ])("stops the item quietly when a lower number still waits for the order poll at %s: no failure, no email, no breaker",
    async (_name, result, jobPauses) => {
      const f = setup({ preRead: marketplaceSyncError(MARKETPLACE_SYNC_CODES.quantityPending, "wait", "transient"), result });
      f.repository.job = { ...f.repository.job, consecutivePauseCount: jobPauses };
      const outcome = await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-006" });

      expect(f.marketplacePush.requests).toEqual([]);
      expect(f.repository.skipInputs).toEqual([expect.objectContaining({ code: "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING",
        message: "This size was not sent this time: eBay's newest orders were still loading, so its quantity could not be checked yet.",
        workerId: "worker-1" })]);
      expect(f.repository.failInputs).toEqual([]);
      expect(f.repository.tripInputs).toEqual([]);
      expect(f.repository.items[0]!.status).toBe("cancelled");
      expect(outcome.job.status).toBe("completed");
      expect(f.notificationSender.sent).toEqual([]);
      expect(f.logs).toContainEqual(expect.objectContaining({ code: "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING",
        context: expect.objectContaining({ outcome: "skipped", listingId: 100 }) }));
    });

  it("fails, never retried as is, a listing the pre-read cannot prove is Card Shellz's", async () => {
    const f = setup({ preRead: marketplaceSyncError(MARKETPLACE_SYNC_CODES.identityUnproven, "not ours", "permanent") });
    await f.service.processJob({ jobId: 30, workerId: "worker-1", idempotencyKey: "sync-push-005" });
    expect(f.marketplacePush.requests).toEqual([]);
    expect(f.repository.failInputs).toEqual([expect.objectContaining({ code: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN", retryable: false })]);
  });
});

function parseIntent(result: Record<string, unknown> | null): DropshipMarketplaceListingIntent {
  return (result as { listingIntent: DropshipMarketplaceListingIntent }).listingIntent;
}

class FakeMarketplacePushProvider implements DropshipMarketplaceListingPushProvider {
  requests: Parameters<DropshipMarketplaceListingPushProvider["pushListing"]>[0][] = [];
  error: Error | null = null;
  errors: Array<Error | null> = [];
  /** Runs while the push is in flight, before it answers (where the real provider waits out its bounded retries). */
  beforeAnswer: (() => Promise<void>) | null = null;

  async pushListing(input: Parameters<DropshipMarketplaceListingPushProvider["pushListing"]>[0]) {
    this.requests.push(input);
    if (this.beforeAnswer) await this.beforeAnswer();
    const next = this.errors.shift();
    if (next) throw next;
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

/** Answers which failed items the sweep will re-queue: by default every item it is asked about (review V2-2). */
class FakeAutomaticRequeueOutlook {
  calls: number[] = [];
  pending: number[] | null = null;
  error: Error | null = null;

  async pendingItemIds(jobId: number): Promise<readonly number[]> {
    this.calls.push(jobId);
    if (this.error) throw this.error;
    return this.pending ?? [1];
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

  markInputs: Array<{ jobId: number; itemId: number; workerId: string; now: Date }> = [];

  /** The vendor stopped this job's publish run (cancel_requested_at): as the real repository, a run item starting after it is cancelled. */
  runStopRequested = false;

  async markItemProcessing(input: { jobId: number; itemId: number; workerId: string; now: Date }): Promise<boolean> {
    this.markInputs.push(input);
    const index = this.items.findIndex((item) => item.itemId === input.itemId);
    if (this.items[index].status !== "queued") {
      return false;
    }
    if (this.job.runId && this.runStopRequested) {
      this.items[index] = { ...this.items[index], status: "cancelled" };
      return false;
    }
    this.items[index] = { ...this.items[index], status: "processing" };
    return true;
  }

  async completeItem(input: Parameters<DropshipListingPushWorkerRepository["completeItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    const index = this.items.findIndex((item) => item.itemId === input.item.itemId);
    this.job = { ...this.job, consecutivePauseCount: 0 };
    this.items[index] = {
      ...this.items[index],
      status: "completed",
      externalListingId: input.pushResult.externalListingId,
      listing: this.items[index].listing ? {
        ...this.items[index].listing!,
        status: input.intent.listingMode === "live" ? "active" : "paused",
        externalListingId: input.pushResult.externalListingId,
        externalOfferId: input.pushResult.externalOfferId,
      } : null,
    };
    return this.items[index];
  }

  failInputs: Array<Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]> = [];

  async failItem(input: Parameters<DropshipListingPushWorkerRepository["failItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.failInputs.push(input);
    // As the real repository (markItemTerminalFailure): the outcome goes to result.push, context included, and a
    // definite eBay answer ends the job's run of pauses in the same write (review round 2 MC4).
    if (input.endsPauseRun) this.job = { ...this.job, consecutivePauseCount: 0 };
    const index = this.items.findIndex((item) => item.itemId === input.item.itemId);
    this.items[index] = {
      ...this.items[index],
      status: "failed",
      errorCode: input.code,
      errorMessage: input.message,
      result: { ...this.items[index].result, push: { status: "failed", errorCode: input.code, errorMessage: input.message,
        retryable: input.retryable, ...(input.context ? { context: input.context } : {}) } },
    };
    return this.items[index];
  }

  async blockItem(input: Parameters<DropshipListingPushWorkerRepository["blockItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.blockInputs.push(input);
    const index = this.items.findIndex((item) => item.itemId === input.item.itemId);
    this.items[index] = {
      ...this.items[index],
      status: "blocked",
      errorCode: input.code,
      errorMessage: input.message,
    };
    return this.items[index];
  }

  skipInputs: Array<Parameters<DropshipListingPushWorkerRepository["skipItem"]>[0]> = [];

  async skipItem(input: Parameters<DropshipListingPushWorkerRepository["skipItem"]>[0]): Promise<DropshipListingPushWorkerItemRecord> {
    this.skipInputs.push(input);
    const index = this.items.findIndex((item) => item.itemId === input.item.itemId);
    this.items[index] = { ...this.items[index], status: "cancelled", errorCode: input.code, errorMessage: input.message };
    return this.items[index];
  }

  pauseInputs: Array<Parameters<DropshipListingPushWorkerRepository["pauseItem"]>[0]> = [];
  tripInputs: Array<Parameters<DropshipListingPushWorkerRepository["tripJobBreaker"]>[0]> = [];
  finalizeCalls = 0;
  blockInputs: Array<Parameters<DropshipListingPushWorkerRepository["blockItem"]>[0]> = [];

  /** The item's run was stopped while it was sent: the repository cancels it instead of queueing it again (review MC4). */
  runStopped = false;

  async pauseItem(input: Parameters<DropshipListingPushWorkerRepository["pauseItem"]>[0]): Promise<DropshipListingPushPauseOutcome> {
    this.pauseInputs.push(input);
    const index = this.items.findIndex((item) => item.itemId === input.item.itemId);
    if (this.runStopped) {
      this.items[index] = { ...this.items[index], status: "cancelled" };
      return { outcome: "stopped" };
    }
    const pauses = Number((this.items[index].result as { transientPauses?: number } | null)?.transientPauses ?? 0) + 1;
    this.items[index] = { ...this.items[index], status: "queued", result: { ...this.items[index].result, transientPauses: pauses } };
    const consecutivePauseCount = (this.job.consecutivePauseCount ?? 0) + 1;
    this.job = { ...this.job, status: "queued", consecutivePauseCount };
    return { outcome: "paused", job: this.job, consecutivePauseCount, nextAttemptAt: new Date(now.getTime() + 60_000) };
  }

  async tripJobBreaker(input: Parameters<DropshipListingPushWorkerRepository["tripJobBreaker"]>[0]) {
    this.tripInputs.push(input);
    const failedItemIds: number[] = [];
    this.items = this.items.map((item) => {
      if (item.status !== "queued" && item.status !== "processing") return item;
      failedItemIds.push(item.itemId);
      return { ...item, status: "failed", errorCode: input.code, errorMessage: input.message };
    });
    return { failedItemIds, runStopped: Boolean(input.job.runId) };
  }

  async finalizeJob() {
    this.finalizeCalls += 1;
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
