import { describe, expect, it, vi } from "vitest";
import type { PreparedChannelFulfillmentReceipt, ChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";
import type { ChannelFulfillmentIngressInput } from "../../channel-fulfillment-ingress";
import { createChannelFulfillmentIngressService, type ChannelFulfillmentInventoryRecorder } from "../../channel-fulfillment-ingress.service";

const now = new Date("2026-09-07T20:00:00.000Z");
const input: ChannelFulfillmentIngressInput = {
  sourceProvider: "shopify", sourceChannelId: 36, sourceOrderId: "101",
  sourceFulfillmentId: "201", sourceEventId: "event-201", eventKind: "created",
  source: "test:channel-runtime", rawPayload: {}, shippedAt: now,
  lineItems: [{ channelOrderLineId: "line-1", quantity: 2 }, { channelOrderLineId: "line-2", quantity: 1 }],
};

function harness() {
  const receipt: PreparedChannelFulfillmentReceipt = {
    receiptId: 91, omsOrderId: 11, terminalReplay: false, sourceEcho: false,
    physicalShipmentId: 701, materializationIdentity: null, legacyWmsShipmentIds: [501],
    inventoryItems: [
      { legacyWmsShipmentId: 501, legacyWmsShipmentItemId: 601, wmsOrderId: 40,
        wmsOrderItemId: 50, productVariantId: 30, warehouseLocationId: null, quantity: 2, deductFromOnHandOnly: false },
      { legacyWmsShipmentId: 501, legacyWmsShipmentItemId: 602, wmsOrderId: 40,
        wmsOrderItemId: 51, productVariantId: 31, warehouseLocationId: null, quantity: 1, deductFromOnHandOnly: false },
    ],
    cancellationCandidates: [], partialOverlapShipmentIds: [],
  };
  const repository: ChannelFulfillmentIngressRepository = {
    stageReceipt: vi.fn().mockResolvedValue({ receiptId: 91, processingStatus: "pending", physicalShipmentId: 701 }),
    claimReceipt: vi.fn().mockResolvedValue({ receiptId: 91, terminalReplay: false, terminalProcessingStatus: null,
      terminalReason: null, sourceEcho: false, physicalShipmentId: 701, leaseToken: "lease-1", attemptNumber: 1 }),
    prepareReceipt: vi.fn().mockResolvedValue(receipt), renewReceiptLease: vi.fn().mockResolvedValue(undefined),
    attachPhysicalShipment: vi.fn().mockResolvedValue(undefined), recordTrackingAmendment: vi.fn().mockResolvedValue(undefined),
    completeReceipt: vi.fn().mockResolvedValue(undefined), recordReviewException: vi.fn().mockResolvedValue(undefined),
    failReceiptAttempt: vi.fn().mockResolvedValue({ processingStatus: "pending", retryFailureCount: 1,
      nextRetryAt: new Date(now.getTime() + 120_000) }),
  };
  const authority = {
    recordPhysicalPackage: vi.fn(), projectPhysicalPackage: vi.fn().mockResolvedValue(undefined),
  };
  const inventory = { recordShipment: vi.fn<ChannelFulfillmentInventoryRecorder["recordShipment"]>().mockResolvedValue(undefined) };
  const dependencies = { repository, authority, inventory, cancelEngineShipment: vi.fn().mockResolvedValue(undefined),
    clock: { now: () => now }, createLeaseToken: () => "lease-1", logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  return { ...dependencies, receipt, service: createChannelFulfillmentIngressService(dependencies) };
}

describe("channel shipment runtime caller contract", () => {
  it("passes NULL bins to the authority-aware recorder after physical projection, without inventing or requiring a hint", async () => {
    const { service, inventory, authority } = harness();
    const events: string[] = [];
    authority.projectPhysicalPackage.mockImplementation(async () => { events.push("project"); });
    inventory.recordShipment.mockImplementation(async () => { events.push("record"); });
    await expect(service.process(input)).resolves.toMatchObject({ processingStatus: "processed", inventoryFailures: 0 });
    expect(events).toEqual(["project", "record", "record"]);
    expect(inventory.recordShipment.mock.calls.map(([command]) => ({
      bin: command.warehouseLocationId, source: command.shipmentItemId, line: command.orderItemId, quantity: command.qty,
    }))).toEqual([{ bin: null, source: 601, line: 50, quantity: 2 }, { bin: null, source: 602, line: 51, quantity: 1 }]);
  });

  it("reuses exact line commands after interruption between lines, allowing the recorder to replay the already-posted line", async () => {
    const { service, inventory, repository } = harness();
    // This unit models the recorder's idempotent contract; real receipt/journal
    // idempotency is proved separately in PostgreSQL dispatch tests.
    const posted = new Map<number, Parameters<ChannelFulfillmentInventoryRecorder["recordShipment"]>[0]>();
    inventory.recordShipment.mockImplementation(async (command) => {
      const prior = posted.get(command.shipmentItemId);
      if (prior) expect(command).toEqual(prior);
      else posted.set(command.shipmentItemId, structuredClone(command));
    });
    let interrupted = false;
    const transient = Object.assign(new Error("Temporary lease connection failure"), { code: "ECONNRESET" });
    vi.mocked(repository.renewReceiptLease).mockImplementation(async () => {
      if (!interrupted && posted.size === 1) { interrupted = true; throw transient; }
    });
    await expect(service.process(input)).rejects.toBe(transient);
    expect([...posted.keys()]).toEqual([601]);
    expect(repository.failReceiptAttempt).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "ECONNRESET" }));
    expect(repository.completeReceipt).not.toHaveBeenCalled();

    await expect(service.process(input)).resolves.toMatchObject({ processingStatus: "processed", inventoryFailures: 0 });
    expect(inventory.recordShipment.mock.calls.map(([command]) => command.shipmentItemId)).toEqual([601, 601, 602]);
    expect([...posted.keys()]).toEqual([601, 602]);
    expect(repository.completeReceipt).toHaveBeenCalledTimes(1);
  });

  it("routes an individual recorder failure to review and retains the exact failed source and cause", async () => {
    const { service, inventory, repository } = harness();
    inventory.recordShipment.mockImplementation(async (command) => {
      if (command.shipmentItemId === 602) throw Object.assign(new Error("Exact picked ownership is unavailable"), {
        code: "CLAIM_DISPATCH_PICKED_OWNER_MISSING",
      });
    });
    await expect(service.process(input)).resolves.toMatchObject({ processingStatus: "review", inventoryFailures: 1 });
    expect(repository.recordReviewException).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ legacyWmsShipmentItemId: 602, wmsOrderItemId: 51,
        causeCode: "CLAIM_DISPATCH_PICKED_OWNER_MISSING", warehouseLocationId: null }),
    }));
    expect(repository.completeReceipt).toHaveBeenCalledWith(expect.objectContaining({ processingStatus: "review" }));
    expect(repository.failReceiptAttempt).not.toHaveBeenCalled();
  });
});
