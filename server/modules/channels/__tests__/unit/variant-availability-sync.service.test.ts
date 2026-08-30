import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  claimVariantAvailabilitySyncs: vi.fn(),
  enqueueVariantAvailabilitySync: vi.fn(),
  loadVariantAvailabilityContext: vi.fn(),
  markVariantAvailabilityNotApplicable: vi.fn(),
  markVariantAvailabilityFailed: vi.fn(),
  markVariantAvailabilitySynced: vi.fn(),
  supersedeAvailabilityClaim: vi.fn(),
}));

vi.mock("../../variant-availability-sync.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../variant-availability-sync.repository")>()),
  ...repository,
}));

import {
  createVariantAvailabilitySyncService,
  queueVariantAvailabilityRepair,
} from "../../variant-availability-sync.service";

const CLAIM = {
  channelId: 67,
  productVariantId: 67,
  desiredActive: false,
  revision: 3,
  attemptCount: 1,
  leaseToken: "00000000-0000-4000-8000-000000000001",
};

const CONTEXT = {
  channelId: 67,
  channelName: "eBay",
  channelProvider: "ebay",
  channelStatus: "active",
  channelSyncEnabled: true,
  channelSyncMode: "live",
  productId: 10,
  productVariantId: 67,
  catalogSku: "ARM-ENV-SGL-C700",
  catalogVariantActive: false,
  catalogRequiresShipping: true,
  catalogTrackInventory: true,
  catalogSalesEligibility: "sellable" as const,
  variantExcluded: false,
  catalogProductActive: true,
  catalogProductStatus: "active",
  productExcluded: false,
  productOverrideIsListed: 1,
  variantOverrideIsListed: 1,
  feedId: 798,
  listingId: null,
  externalProductId: "298148438778",
  externalVariantId: "136412217011",
  externalInventoryItemId: null,
  externalSku: "ARM-ENV-SGL-C700",
  previousQuantity: 226,
};

function createHarness() {
  const pushInventory = vi.fn().mockResolvedValue([{
    variantId: 67,
    pushedQty: 0,
    status: "success",
  }]);
  const allocationEngine = {
    allocateProduct: vi.fn().mockResolvedValue({ allocations: [] }),
  };
  const adapterRegistry = {
    getOrThrow: vi.fn(() => ({ pushInventory })),
  };
  const service = createVariantAvailabilitySyncService({
    dbPool: {} as never,
    allocationEngine,
    adapterRegistry: adapterRegistry as never,
  });
  return { service, pushInventory, allocationEngine, adapterRegistry };
}

describe("variant availability sync service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([CLAIM]);
    repository.loadVariantAvailabilityContext.mockResolvedValue(CONTEXT);
    repository.markVariantAvailabilitySynced.mockResolvedValue(true);
    repository.markVariantAvailabilityNotApplicable.mockResolvedValue(true);
    repository.markVariantAvailabilityFailed.mockResolvedValue("retryable");
    repository.supersedeAvailabilityClaim.mockResolvedValue(undefined);
  });

  it("routes reconciliation repairs through the owning repository", async () => {
    const dbPool = {} as never;

    await expect(queueVariantAvailabilityRepair({
      channelId: 67,
      productVariantId: 438,
    }, { dbPool })).resolves.toBeUndefined();

    expect(repository.enqueueVariantAvailabilitySync).toHaveBeenCalledWith(dbPool, {
      channelId: 67,
      productVariantId: 438,
      desiredActive: false,
    });
  });

  it("rejects invalid repair identifiers before calling the repository", async () => {
    await expect(queueVariantAvailabilityRepair({
      channelId: 67,
      productVariantId: -1,
    }, { dbPool: {} as never })).rejects.toThrow("productVariantId must be a positive safe integer");

    expect(repository.enqueueVariantAvailabilitySync).not.toHaveBeenCalled();
  });

  it("pushes only the inactive variant to zero and does not calculate ATP", async () => {
    const { service, pushInventory, allocationEngine } = createHarness();

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
    });
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).toHaveBeenCalledWith(67, [{
      variantId: 67,
      sku: "ARM-ENV-SGL-C700",
      externalVariantId: "136412217011",
      externalInventoryItemId: null,
      allocatedQty: 0,
    }]);
    expect(repository.markVariantAvailabilitySynced).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      expect.objectContaining({ quantity: 0, feedActive: false }),
    );
  });

  it("recalculates and restores current allocation on reactivation", async () => {
    const activeClaim = { ...CLAIM, desiredActive: true, revision: 4 };
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([activeClaim]);
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,
      catalogVariantActive: true,
    });
    const { service, pushInventory, allocationEngine } = createHarness();
    allocationEngine.allocateProduct.mockResolvedValue({
      allocations: [{ channelId: 67, productVariantId: 67, allocatedUnits: 31 }],
    });

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
    });
    expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(
      10,
      "variant_availability_reactivation",
    );
    expect(pushInventory).toHaveBeenCalledWith(
      67,
      [expect.objectContaining({ allocatedQty: 31 })],
    );
    expect(repository.markVariantAvailabilitySynced).toHaveBeenCalledWith(
      expect.anything(),
      activeClaim,
      expect.objectContaining({ quantity: 31, feedActive: true }),
    );
  });

  it("completes digital availability work without publishing a quantity", async () => {
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,
      catalogRequiresShipping: false,
      catalogTrackInventory: false,
    });
    const { service, pushInventory, allocationEngine } = createHarness();

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
    });
    expect(repository.markVariantAvailabilityNotApplicable).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
    );
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
    expect(repository.markVariantAvailabilitySynced).not.toHaveBeenCalled();
  });

  it("completes internal-only availability work without publishing a quantity", async () => {
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,
      catalogSalesEligibility: "internal_only",
    });
    const { service, pushInventory, allocationEngine } = createHarness();

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
    });
    expect(repository.markVariantAvailabilityNotApplicable).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
    );
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
    expect(repository.markVariantAvailabilitySynced).not.toHaveBeenCalled();
  });

  it("supersedes a stale claim before calling eBay", async () => {
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,
      catalogVariantActive: true,
    });
    const { service, pushInventory } = createHarness();

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 0,
      retried: 0,
      superseded: 1,
    });
    expect(repository.supersedeAvailabilityClaim).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      true,
    );
    expect(pushInventory).not.toHaveBeenCalled();
  });

  it("retries indefinitely when the adapter rejects the zero push", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { service, pushInventory } = createHarness();
    pushInventory.mockResolvedValue([{
      variantId: 67,
      pushedQty: 0,
      status: "error",
      error: "eBay unavailable",
    }]);

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 0,
      retried: 1,
      superseded: 0,
    });
    expect(repository.markVariantAvailabilityFailed).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      expect.objectContaining({ message: "eBay unavailable" }),
    );
    errorSpy.mockRestore();
  });
});
