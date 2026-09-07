import { describe, expect, it, vi } from "vitest";
import type { ChannelFulfillmentIngressInput } from "../../channel-fulfillment-ingress";
import type { ChannelFulfillmentIngressRepository, IngressInventoryItem, PreparedChannelFulfillmentReceipt } from "../../channel-fulfillment-ingress.repository";
import { createChannelFulfillmentIngressService } from "../../channel-fulfillment-ingress.service";

const now = new Date("2026-09-07T20:00:00.000Z");
const input: ChannelFulfillmentIngressInput = {
  sourceProvider: "shopify", sourceChannelId: 36, sourceOrderId: "101", sourceFulfillmentId: "201",
  eventKind: "created", source: "test:canonical-echo", shippedAt: now,
  lineItems: [{ channelOrderLineId: "line-1", quantity: 2 }],
};
function source(id: number): IngressInventoryItem {
  return { legacyWmsShipmentId: 60, legacyWmsShipmentItemId: id, wmsOrderId: 40, wmsOrderItemId: 50,
    productVariantId: 30, warehouseLocationId: null, quantity: 1, deductFromOnHandOnly: false };
}
function setup(items: readonly IngressInventoryItem[], sourceEcho = true) {
  const prepared: PreparedChannelFulfillmentReceipt = {
    receiptId: 91, omsOrderId: 11, terminalReplay: false, sourceEcho,
    physicalShipmentId: 70, materializationIdentity: null, legacyWmsShipmentIds: [],
    inventoryItems: items, cancellationCandidates: [], partialOverlapShipmentIds: [],
  };
  const repository: ChannelFulfillmentIngressRepository = {
    stageReceipt: vi.fn(async () => ({ receiptId: 91, processingStatus: "pending", physicalShipmentId: 70 })),
    claimReceipt: vi.fn(async () => ({ receiptId: 91, terminalReplay: false, terminalProcessingStatus: null,
      terminalReason: null, sourceEcho: true, physicalShipmentId: 70, leaseToken: "lease-1", attemptNumber: 1 })),
    prepareReceipt: vi.fn(async () => prepared), renewReceiptLease: vi.fn(), attachPhysicalShipment: vi.fn(),
    recordTrackingAmendment: vi.fn(), completeReceipt: vi.fn(), recordReviewException: vi.fn(),
    failReceiptAttempt: vi.fn(async () => ({ processingStatus: "pending" as const, retryFailureCount: 1,
      nextRetryAt: new Date(now.getTime() + 120_000) })),
  };
  const recordShipment = vi.fn(async (_input: unknown) => undefined);
  const authority = { recordPhysicalPackage: vi.fn(), projectPhysicalPackage: vi.fn() };
  const cancelEngineShipment = vi.fn();
  const service = createChannelFulfillmentIngressService({ repository, authority, inventory: { recordShipment },
    cancelEngineShipment, clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  return { repository, service, recordShipment, authority, cancelEngineShipment };
}

describe("canonical shipment echo custody recovery", () => {
  it("checks every exact existing source before marking the echo ignored; creates no package or cancellation", async () => {
    const f = setup([source(61), source(62)]);
    await expect(f.service.process(input)).resolves.toMatchObject({ processingStatus: "ignored", inventoryFailures: 0 });
    expect(f.recordShipment.mock.calls.map(([row]) => (row as { shipmentItemId: number }).shipmentItemId)).toEqual([61, 62]);
    expect(f.recordShipment).toHaveBeenCalledWith(expect.objectContaining({ warehouseLocationId: null, qty: 1, shipmentId: "60" }));
    expect(f.authority.recordPhysicalPackage).not.toHaveBeenCalled();
    expect(f.cancelEngineShipment).not.toHaveBeenCalled();
    expect(vi.mocked(f.repository.completeReceipt).mock.invocationCallOrder[0])
      .toBeGreaterThan(f.recordShipment.mock.invocationCallOrder[1]);
  });

  it("retains successful lines and records durable review when any echo source fails", async () => {
    const f = setup([source(61), source(62), source(63)]);
    f.recordShipment.mockRejectedValueOnce(Object.assign(new Error("source custody missing"), { code: "CLAIM_DISPATCH_SOURCE_PICKED_MISSING" }));
    await expect(f.service.process(input)).resolves.toMatchObject({ processingStatus: "review", sourceEcho: true, inventoryFailures: 1 });
    expect(f.recordShipment).toHaveBeenCalledTimes(3);
    expect(f.repository.recordReviewException).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ causeCode: "CLAIM_DISPATCH_SOURCE_PICKED_MISSING", legacyWmsShipmentItemId: 61 }),
    }));
    expect(f.repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({ processingStatus: "review" }));
    expect(f.repository.completeReceipt).not.toHaveBeenCalledWith(expect.objectContaining({ processingStatus: "ignored" }));
  });

  it("preserves legacy echo behavior when preparation contains no canonical source work", async () => {
    const f = setup([]);
    await expect(f.service.process(input)).resolves.toMatchObject({ processingStatus: "ignored", sourceEcho: true });
    expect(f.recordShipment).not.toHaveBeenCalled();
  });

  it.each([true, false].flatMap(sourceEcho => ["40001", "40P01", "INVENTORY_PUBLICATION_TARGET_BUSY"]
    .map(code => ({ sourceEcho, code }))))("routes contention to durable retry, not manual review: %j", async ({ sourceEcho, code }) => {
    const f = setup([source(61), source(62), source(63)], sourceEcho);
    const contention = Object.assign(new Error("retry complete owning transaction"), { code });
    f.recordShipment.mockResolvedValueOnce(undefined).mockRejectedValueOnce(contention);
    await expect(f.service.process(input)).rejects.toBe(contention);
    expect(f.recordShipment).toHaveBeenCalledTimes(2);
    expect(f.repository.failReceiptAttempt).toHaveBeenCalledWith(expect.objectContaining({ errorCode: code, maxFailures: 5 }));
    expect(f.repository.completeReceipt).not.toHaveBeenCalled();
    expect(f.repository.recordReviewException).not.toHaveBeenCalled();
    // Simulate the existing durable queue claiming the receipt again. Source61
    // is resent unchanged for the idempotent owner; no source gets recreated.
    await expect(f.service.process(input)).resolves.toMatchObject({ processingStatus: sourceEcho ? "ignored" : "processed" });
    expect(f.recordShipment.mock.calls.map(([row]) => (row as { shipmentItemId: number }).shipmentItemId))
      .toEqual([61, 62, 61, 62, 63]);
  });
});
