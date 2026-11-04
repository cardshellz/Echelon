import { describe, expect, it, vi } from "vitest";
import { ChannelListingReconciliationService } from "../../../marketplace-listings/application/channel-listing-reconciliation.service";

const activeInternal = { listingId: 10,productVariantId: 20,sku: "EXAMPLE",productActive: true,
  variantActive: true,productStatus: "active",salesEligibility: "internal_only" };

function harness() {
  const ports = {
    observe: vi.fn().mockResolvedValue({ inventoryItemExists: true,hasActiveOffer: true,availableQuantity: 5 }),
    markDeleted: vi.fn().mockResolvedValue(undefined),
    markEnded: vi.fn().mockResolvedValue(undefined),
    queueStockRepair: vi.fn().mockResolvedValue(undefined),
  };
  return { ports, service: new ChannelListingReconciliationService(ports) };
}

describe("shared listing status reconciliation", () => {
  it("queues a repair for an active internal-only member with positive observed stock", async () => {
    const { service,ports } = harness();
    await expect(service.reconcile(activeInternal)).resolves.toEqual({ status: "active",quantityDrift: true,availableQuantity: 5 });
    expect(ports.observe).toHaveBeenCalledExactlyOnceWith("EXAMPLE");
    expect(ports.queueStockRepair).toHaveBeenCalledExactlyOnceWith(20);
    expect(ports.markDeleted).not.toHaveBeenCalled();
    expect(ports.markEnded).not.toHaveBeenCalled();
  });
  it.each([{ variantActive: false },{ productActive: false },{ productStatus: "archived" },
    { variantActive: null },{ productVariantId: null }])("does not queue a stock repair from archived or incomplete evidence: %o", async changes => {
    const { service,ports } = harness();
    await expect(service.reconcile({ ...activeInternal,...changes })).resolves.toMatchObject({ status: "active",quantityDrift: false });
    expect(ports.queueStockRepair).not.toHaveBeenCalled();
  });
  it.each([null,0])("does not guess that %s observed quantity requires a repair", async availableQuantity => {
    const { service,ports } = harness();
    ports.observe.mockResolvedValue({ inventoryItemExists: true,hasActiveOffer: true,availableQuantity });
    await expect(service.reconcile(activeInternal)).resolves.toMatchObject({ status: "active",quantityDrift: false });
    expect(ports.queueStockRepair).not.toHaveBeenCalled();
  });
  it.each([
    { observation: { inventoryItemExists: false,hasActiveOffer: false,availableQuantity: null },status: "deleted",effect: "markDeleted" },
    { observation: { inventoryItemExists: true,hasActiveOffer: false,availableQuantity: null },status: "ended",effect: "markEnded" },
  ] as const)("records the exact provider status before any stock repair", async ({ observation,status,effect }) => {
    const { service,ports } = harness();
    ports.observe.mockResolvedValue(observation);
    await expect(service.reconcile(activeInternal)).resolves.toMatchObject({ status,quantityDrift: false });
    expect(ports[effect]).toHaveBeenCalledExactlyOnceWith(10);
    expect(ports.queueStockRepair).not.toHaveBeenCalled();
  });
  it("retains a read failure without writing any status or queue", async () => {
    const { service,ports } = harness();
    ports.observe.mockRejectedValue(new Error("provider unavailable"));
    await expect(service.reconcile(activeInternal)).rejects.toThrow("provider unavailable");
    expect(ports.markDeleted).not.toHaveBeenCalled();
    expect(ports.markEnded).not.toHaveBeenCalled();
    expect(ports.queueStockRepair).not.toHaveBeenCalled();
  });
  it.each([
    { inventoryItemExists: "yes",hasActiveOffer: true,availableQuantity: 5 },
    { inventoryItemExists: true,hasActiveOffer: true,availableQuantity: -1 },
    { inventoryItemExists: true,hasActiveOffer: true,availableQuantity: 1.5 },
    { inventoryItemExists: false,hasActiveOffer: true,availableQuantity: 5 },
  ])("rejects an invalid observation before any effect: %o", async observation => {
    const { service,ports } = harness();
    ports.observe.mockResolvedValue(observation);
    await expect(service.reconcile(activeInternal)).rejects.toThrow();
    expect(ports.markDeleted).not.toHaveBeenCalled();
    expect(ports.markEnded).not.toHaveBeenCalled();
    expect(ports.queueStockRepair).not.toHaveBeenCalled();
  });
});
