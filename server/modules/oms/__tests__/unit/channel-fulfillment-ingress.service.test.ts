import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  ChannelFulfillmentIngressRepository,
  PreparedChannelFulfillmentReceipt,
} from "../../channel-fulfillment-ingress.repository";
import {
  ChannelFulfillmentIngressError,
  normalizeChannelFulfillmentIngress,
  type ChannelFulfillmentIngressInput,
} from "../../channel-fulfillment-ingress";
import {
  createChannelFulfillmentIngressService,
} from "../../channel-fulfillment-ingress.service";

const NOW = new Date("2026-07-22T15:00:00.000Z");

function input(overrides: Partial<ChannelFulfillmentIngressInput> = {}): ChannelFulfillmentIngressInput {
  return {
    sourceProvider: "shopify",
    sourceChannelId: 36,
    sourceOrderId: "12140180865183",
    sourceFulfillmentId: "6312306376863",
    sourceEventId: "webhook-1",
    sourceInboxId: 70825,
    eventKind: "created",
    source: "shopify_fulfillments_create",
    trackingNumber: "1ZTEST",
    carrier: "UPS",
    trackingUrl: "https://example.test/track/1ZTEST",
    shippedAt: NOW,
    correlationId: "corr-1",
    causationId: "webhook-1",
    rawPayload: { id: 6312306376863 },
    lineItems: [
      { channelOrderLineId: "gid://shopify/LineItem/1", quantity: 2 },
      { channelOrderLineId: "gid://shopify/LineItem/2", quantity: 1 },
    ],
    ...overrides,
  };
}

function prepared(
  overrides: Partial<PreparedChannelFulfillmentReceipt> = {},
): PreparedChannelFulfillmentReceipt {
  return {
    receiptId: 91,
    omsOrderId: 101,
    terminalReplay: false,
    sourceEcho: false,
    physicalShipmentId: null,
    materializationIdentity: Object.freeze({
      shippingProvider: "shopify",
      providerPhysicalShipmentId: "6312306376863",
      providerOrderId: "12140180865183",
      providerOrderKey: "12140180865183",
      trackingNumber: "1ZTEST",
      carrier: "UPS",
      trackingUrl: "https://example.test/track/1ZTEST",
      serviceCode: null,
      shippedAt: NOW,
    }),
    legacyWmsShipmentIds: Object.freeze([501]),
    inventoryItems: Object.freeze([{
      legacyWmsShipmentId: 501,
      legacyWmsShipmentItemId: 601,
      wmsOrderId: 201,
      wmsOrderItemId: 301,
      productVariantId: 401,
      warehouseLocationId: 501,
      quantity: 2,
      deductFromOnHandOnly: false,
    }]),
    cancellationCandidates: Object.freeze([{
      wmsShipmentId: 502,
      engine: "shipstation",
      engineOrderRef: "755802673",
      engineShipmentRef: null,
    }]),
    partialOverlapShipmentIds: Object.freeze([]),
    ...overrides,
  };
}

function repositoryMock(
  receipt: PreparedChannelFulfillmentReceipt = prepared(),
): ChannelFulfillmentIngressRepository {
  return {
    stageReceipt: vi.fn().mockResolvedValue({
      receiptId: receipt.receiptId,
      processingStatus: "pending",
      physicalShipmentId: receipt.physicalShipmentId,
    }),
    claimReceipt: vi.fn().mockResolvedValue({
      receiptId: receipt.receiptId,
      terminalReplay: receipt.terminalReplay,
      terminalProcessingStatus: receipt.terminalReplay
        ? (receipt.sourceEcho ? "ignored" : "processed")
        : null,
      terminalReason: null,
      sourceEcho: receipt.sourceEcho,
      physicalShipmentId: receipt.physicalShipmentId,
      leaseToken: "lease-1",
      attemptNumber: 1,
    }),
    prepareReceipt: vi.fn().mockResolvedValue(receipt),
    renewReceiptLease: vi.fn().mockResolvedValue(undefined),
    attachPhysicalShipment: vi.fn().mockResolvedValue(undefined),
    recordTrackingAmendment: vi.fn().mockResolvedValue(undefined),
    completeReceipt: vi.fn().mockResolvedValue(undefined),
    failReceiptAttempt: vi.fn().mockResolvedValue({
      processingStatus: "pending",
      retryFailureCount: 1,
      nextRetryAt: new Date("2026-07-22T15:02:00.000Z"),
    }),
    recordReviewException: vi.fn().mockResolvedValue(undefined),
  };
}

function dependencies(repository: ChannelFulfillmentIngressRepository) {
  return {
    repository,
    authority: {
      recordPhysicalPackage: vi.fn().mockResolvedValue({
        materialized: {
          physicalShipmentId: 701,
          shippingEngineOrderId: 801,
          channelCommands: [],
          customerFulfillmentItemCount: 1,
          nonCustomerItemCount: 0,
        },
        dispatch: {
          claimed: 0,
          succeeded: 0,
          ignored: 0,
          retryScheduled: 0,
          reviewRequired: 0,
          deadLettered: 0,
        },
      }),
      projectPhysicalPackage: vi.fn().mockResolvedValue(undefined),
    },
    inventory: { recordShipment: vi.fn().mockResolvedValue(undefined) },
    cancelEngineShipment: vi.fn().mockResolvedValue(undefined),
    clock: { now: () => NOW },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("channel fulfillment ingress", () => {
  it("resolves WMS lineage through the exact OMS-line foreign key", () => {
    const repositorySource = readFileSync(
      resolve(__dirname, "../../channel-fulfillment-ingress.repository.ts"),
      "utf8",
    );

    expect(repositorySource).toMatch(
      /JOIN wms\.order_items oi\s+ON oi\.oms_order_line_id = ol\.id/,
    );
    expect(repositorySource).not.toContain(
      "ON w.oms_fulfillment_order_id = oo.id::text",
    );
    expect(repositorySource).not.toMatch(
      /LEFT JOIN wms\.(?:orders|order_items)[\s\S]*FOR UPDATE OF ol, w, oi/,
    );
  });

  it("normalizes duplicate provider lines into one deterministic exact allocation", () => {
    const normalized = normalizeChannelFulfillmentIngress(input({
      lineItems: [
        { channelOrderLineId: "line-2", sourceFulfillmentLineId: "f-2", quantity: 1 },
        { channelOrderLineId: "line-1", sourceFulfillmentLineId: "f-1", quantity: 2 },
        { channelOrderLineId: "line-1", sourceFulfillmentLineId: "f-1", quantity: 3 },
      ],
    }));

    expect(normalized.lineItems).toEqual([
      { channelOrderLineId: "line-1", sourceFulfillmentLineId: "f-1", quantity: 5 },
      { channelOrderLineId: "line-2", sourceFulfillmentLineId: "f-2", quantity: 1 },
    ]);
    expect(normalized.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("materializes one canonical package, posts exact inventory, projects, and cancels superseded engine work", async () => {
    const repository = repositoryMock();
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(deps.authority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [501],
        shippingProvider: "shopify",
        providerPhysicalShipmentId: "6312306376863",
        providerOrderId: "12140180865183",
        suppressChannelProviders: ["shopify"],
      }),
      { executeImmediately: false },
    );
    expect(deps.inventory.recordShipment).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 201,
      orderItemId: 301,
      shipmentId: "501",
      shipmentItemId: 601,
      qty: 2,
    }));
    expect(deps.cancelEngineShipment).toHaveBeenCalledWith(
      expect.objectContaining({ wmsShipmentId: 502, engineOrderRef: "755802673" }),
      NOW,
    );
    expect(deps.authority.projectPhysicalPackage).toHaveBeenCalledWith(701);
    expect(repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 91,
      leaseToken: "lease-1",
      processingStatus: "processed",
      physicalShipmentId: 701,
      completedAt: NOW,
    }));
    expect(result).toMatchObject({
      processingStatus: "processed",
      physicalShipmentId: 701,
      sourceEcho: false,
      replayed: false,
    });
  });

  it("classifies a callback for our own provider command as an echo without reposting inventory", async () => {
    const repository = repositoryMock(prepared({
      sourceEcho: true,
      physicalShipmentId: 701,
      materializationIdentity: null,
      legacyWmsShipmentIds: Object.freeze([]),
      inventoryItems: Object.freeze([]),
      cancellationCandidates: Object.freeze([]),
    }));
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(deps.authority.recordPhysicalPackage).not.toHaveBeenCalled();
    expect(deps.inventory.recordShipment).not.toHaveBeenCalled();
    expect(deps.cancelEngineShipment).not.toHaveBeenCalled();
    expect(repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 91,
      leaseToken: "lease-1",
      processingStatus: "ignored",
      physicalShipmentId: 701,
      completedAt: NOW,
    }));
    expect(result).toMatchObject({ processingStatus: "ignored", sourceEcho: true });
  });

  it("adopts the existing shipping-provider package identity for a channel acknowledgement", async () => {
    const repository = repositoryMock(prepared({
      sourceEcho: true,
      materializationIdentity: Object.freeze({
        shippingProvider: "shipstation",
        providerPhysicalShipmentId: "442326748",
        providerOrderId: "755417850",
        providerOrderKey: "echelon-wms-shp-4641",
        trackingNumber: "1ZOWNEDBYSHIPSTATION",
        carrier: "UPS",
        trackingUrl: "https://example.test/shipstation/1ZOWNEDBYSHIPSTATION",
        serviceCode: "ups_ground",
        shippedAt: new Date("2026-07-22T14:50:00.000Z"),
      }),
      legacyWmsShipmentIds: Object.freeze([4641]),
      inventoryItems: Object.freeze([]),
      cancellationCandidates: Object.freeze([]),
    }));
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input({
      trackingNumber: "1ZOWNEDBYSHIPSTATION",
      carrier: "UPS\u00ae",
    }));

    expect(deps.authority.recordPhysicalPackage).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyWmsShipmentIds: [4641],
        shippingProvider: "shipstation",
        providerPhysicalShipmentId: "442326748",
        providerOrderId: "755417850",
        providerOrderKey: "echelon-wms-shp-4641",
        trackingNumber: "1ZOWNEDBYSHIPSTATION",
        carrier: "UPS",
        trackingUrl: "https://example.test/shipstation/1ZOWNEDBYSHIPSTATION",
        serviceCode: "ups_ground",
        shippedAt: new Date("2026-07-22T14:50:00.000Z"),
        suppressChannelProviders: ["shopify"],
      }),
      { executeImmediately: false },
    );
    expect(deps.inventory.recordShipment).not.toHaveBeenCalled();
    expect(deps.cancelEngineShipment).not.toHaveBeenCalled();
    expect(repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      processingStatus: "ignored",
      physicalShipmentId: 701,
      metadata: { sourceEcho: true },
    }));
    expect(result).toMatchObject({
      processingStatus: "ignored",
      physicalShipmentId: 701,
      sourceEcho: true,
    });
  });

  it("returns terminal receipts without repeating any side effect", async () => {
    const repository = repositoryMock(prepared({
      terminalReplay: true,
      physicalShipmentId: 701,
      materializationIdentity: null,
      legacyWmsShipmentIds: Object.freeze([]),
      inventoryItems: Object.freeze([]),
      cancellationCandidates: Object.freeze([]),
    }));
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(deps.authority.recordPhysicalPackage).not.toHaveBeenCalled();
    expect(deps.inventory.recordShipment).not.toHaveBeenCalled();
    expect(repository.attachPhysicalShipment).not.toHaveBeenCalled();
    expect(repository.completeReceipt).not.toHaveBeenCalled();
    expect(result.replayed).toBe(true);
  });

  it("preserves the physical fact but routes inventory failure to durable review", async () => {
    const repository = repositoryMock();
    const deps = dependencies(repository);
    deps.inventory.recordShipment.mockRejectedValue(new Error("negative inventory guard"));
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(deps.authority.projectPhysicalPackage).toHaveBeenCalledWith(701);
    expect(repository.recordReviewException).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 91,
      rule: "inventory_record_failed",
    }));
    expect(repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      processingStatus: "review",
      physicalShipmentId: 701,
      errorCode: "INVENTORY_RECORD_FAILED",
    }));
    expect(result).toMatchObject({ processingStatus: "review", inventoryFailures: 1 });
  });

  it("retains deterministic lineage failures for operator review", async () => {
    const repository = repositoryMock();
    vi.mocked(repository.prepareReceipt).mockRejectedValue(new ChannelFulfillmentIngressError(
      "CHANNEL_LINE_NOT_FOUND",
      "line is missing",
      { channelOrderLineId: "line-404" },
    ));
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(repository.recordReviewException).toHaveBeenCalledWith(expect.objectContaining({
      rule: "channel_line_not_found",
      details: { channelOrderLineId: "line-404" },
    }));
    expect(result.processingStatus).toBe("review");
  });

  it("persists infrastructure failures as retryable before the durable queue retries them", async () => {
    const repository = repositoryMock();
    vi.mocked(repository.prepareReceipt).mockRejectedValue(Object.assign(
      new Error("connection reset"),
      { code: "ECONNRESET" },
    ));
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    await expect(service.process(input())).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(repository.failReceiptAttempt).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 91,
      leaseToken: "lease-1",
      errorCode: "ECONNRESET",
      errorMessage: "connection reset",
      maxFailures: 5,
    }));
    expect(repository.completeReceipt).not.toHaveBeenCalled();
    expect(repository.recordReviewException).not.toHaveBeenCalled();
  });

  it("routes exhausted transient retries to durable review without throwing", async () => {
    const repository = repositoryMock();
    vi.mocked(repository.prepareReceipt).mockRejectedValue(Object.assign(
      new Error("database unavailable"),
      { code: "ECONNRESET" },
    ));
    vi.mocked(repository.failReceiptAttempt).mockResolvedValue({
      processingStatus: "review",
      retryFailureCount: 5,
      nextRetryAt: null,
    });
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(repository.recordReviewException).toHaveBeenCalledWith(expect.objectContaining({
      receiptId: 91,
      rule: "channel_fulfillment_transient_retry_exhausted",
      details: expect.objectContaining({
        originalErrorCode: "ECONNRESET",
        retryFailureCount: 5,
      }),
    }));
    expect(result).toMatchObject({
      processingStatus: "review",
      physicalShipmentId: null,
    });
  });

  it("returns a terminal review receipt without repeating side effects", async () => {
    const repository = repositoryMock(prepared({
      terminalReplay: true,
      physicalShipmentId: null,
      materializationIdentity: null,
      legacyWmsShipmentIds: Object.freeze([]),
      inventoryItems: Object.freeze([]),
      cancellationCandidates: Object.freeze([]),
    }));
    vi.mocked(repository.claimReceipt).mockResolvedValue({
      receiptId: 91,
      terminalReplay: true,
      terminalProcessingStatus: "review",
      terminalReason: null,
      sourceEcho: false,
      physicalShipmentId: null,
      leaseToken: null,
      attemptNumber: 5,
    });
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(result).toMatchObject({
      processingStatus: "review",
      replayed: true,
    });
    expect(repository.prepareReceipt).not.toHaveBeenCalled();
    expect(repository.failReceiptAttempt).not.toHaveBeenCalled();
  });

  it("records a review exception when repeated lease expiry exhausts recovery", async () => {
    const repository = repositoryMock();
    vi.mocked(repository.claimReceipt).mockResolvedValue({
      receiptId: 91,
      terminalReplay: true,
      terminalProcessingStatus: "review",
      terminalReason: "lease_retry_exhausted",
      sourceEcho: false,
      physicalShipmentId: null,
      leaseToken: null,
      attemptNumber: 5,
    });
    const deps = dependencies(repository);
    const service = createChannelFulfillmentIngressService(deps);

    const result = await service.process(input());

    expect(repository.recordReviewException).toHaveBeenCalledWith({
      receiptId: 91,
      rule: "channel_fulfillment_lease_retry_exhausted",
      summary: "Channel fulfillment receipt exhausted recovery after repeated lease expiry",
      details: { attemptNumber: 5 },
    });
    expect(result).toMatchObject({
      processingStatus: "review",
      replayed: true,
    });
  });
});
