import { beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  claimVariantAvailabilitySyncs: vi.fn(),
  enqueueVariantAvailabilitySync: vi.fn(),
  loadVariantAvailabilityContext: vi.fn(),
  markVariantAvailabilityDelegated: vi.fn(),
  markVariantAvailabilityNotApplicable: vi.fn(),
  markVariantAvailabilityFailed: vi.fn(),
  markVariantAvailabilitySynced: vi.fn(),
  retainVariantAvailabilityAcknowledgement: vi.fn(),
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
  requestKind: "stock_repair" as const,
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
  mappingSnapshot: { productId: 10, catalogSku: "ARM-ENV-SGL-C700", feed: { id: 798,
    productId: "298148438778", variantId: "136412217011", inventoryItemId: null, sku: "ARM-ENV-SGL-C700" }, listing: null },
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
  const inventoryPublication = {
    publishVariantAvailability: vi.fn(async (
      _input: unknown,
      legacyPublisher: () => Promise<unknown>,
    ) => ({ authority: "legacy" as const, legacyResult: await legacyPublisher() })),
  };
  const service = createVariantAvailabilitySyncService({
    dbPool: {} as never,
    allocationEngine,
    adapterRegistry: adapterRegistry as never,
    inventoryPublication: inventoryPublication as never,
  });
  return { service, pushInventory, allocationEngine, adapterRegistry, inventoryPublication };
}

describe("variant availability sync service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([CLAIM]);
    repository.loadVariantAvailabilityContext.mockResolvedValue(CONTEXT);
    repository.markVariantAvailabilitySynced.mockResolvedValue("synced");
    repository.retainVariantAvailabilityAcknowledgement.mockResolvedValue("needs_review");
    repository.markVariantAvailabilityDelegated.mockResolvedValue(true);
    repository.markVariantAvailabilityNotApplicable.mockResolvedValue(true);
    repository.markVariantAvailabilityFailed.mockResolvedValue("retryable");
    repository.supersedeAvailabilityClaim.mockResolvedValue("superseded");
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
      requestKind: "stock_repair",
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
      needsReview: 0,
    });
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).toHaveBeenCalledWith(67, [{
      variantId: 67,
      sku: "ARM-ENV-SGL-C700",
      externalVariantId: "136412217011",
      externalInventoryItemId: null,
      allocatedQty: 0,
    }], undefined, expect.any(Function));
    expect(repository.markVariantAvailabilitySynced).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      expect.objectContaining({ quantity: 0, feedActive: false }),
      CONTEXT.mappingSnapshot,
    );
  });

  it("reports a changed link after acknowledgement as needing review, not as a completed sync", async () => {
    repository.markVariantAvailabilitySynced.mockResolvedValue("needs_review");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { service } = createHarness();
      await expect(service.processDue()).resolves.toEqual({ claimed: 1,synced: 0,retried: 0,superseded: 0,needsReview: 1 });
      expect(repository.markVariantAvailabilityFailed).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        code: "VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_REVIEW",productVariantId: 67,
      }));
    } finally { log.mockRestore(); }
  });
  it("retains an acknowledged provider result when its local projection fails", async () => {
    repository.markVariantAvailabilitySynced.mockRejectedValue(new Error("projection unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { service } = createHarness();
      await expect(service.processDue()).resolves.toEqual({ claimed: 1,synced: 0,retried: 0,superseded: 0,needsReview: 1 });
      expect(repository.retainVariantAvailabilityAcknowledgement).toHaveBeenCalledWith(expect.anything(),CLAIM,
        expect.objectContaining({ quantity: 0 }),CONTEXT.mappingSnapshot);
      expect(repository.markVariantAvailabilityFailed).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
  it("does not mark an acknowledged result retryable if its recovery receipt also fails", async () => {
    repository.markVariantAvailabilitySynced.mockRejectedValue(new Error("projection unavailable"));
    repository.retainVariantAvailabilityAcknowledgement.mockRejectedValue(new Error("database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { service } = createHarness();
      await expect(service.processDue()).rejects.toThrow("database unavailable");
      expect(repository.markVariantAvailabilityFailed).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("recalculates and restores current allocation on reactivation", async () => {
    const activeClaim = { ...CLAIM, desiredActive: true, revision: 4, requestKind: "catalog_activation" as const };
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
      needsReview: 0,
    });
    expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(
      10,
      "variant_availability_reactivation",
      [67],
    );
    expect(pushInventory).toHaveBeenCalledWith(
      67,
      [expect.objectContaining({ allocatedQty: 31 })],
      undefined,
      expect.any(Function),
    );
    expect(repository.markVariantAvailabilitySynced).toHaveBeenCalledWith(
      expect.anything(),
      activeClaim,
      expect.objectContaining({ quantity: 31, feedActive: true }),
      CONTEXT.mappingSnapshot,
    );
  });

  it("holds an archived legacy zero instead of treating it as an explicit stock repair", async () => {
    const legacyClaim = { ...CLAIM, requestKind: null };
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([legacyClaim]);
    repository.supersedeAvailabilityClaim.mockResolvedValue("needs_review");
    const { service, inventoryPublication, pushInventory } = createHarness();

    await expect(service.processDue()).resolves.toMatchObject({ claimed: 1, superseded: 0, needsReview: 1 });
    expect(repository.supersedeAvailabilityClaim).toHaveBeenCalledWith(expect.anything(), legacyClaim, false);
    expect(inventoryPublication.publishVariantAvailability).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
  });

  it("holds an activation if its parent product was archived", async () => {
    const activeClaim = { ...CLAIM, desiredActive: true, requestKind: "catalog_activation" as const };
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([activeClaim]);
    repository.loadVariantAvailabilityContext.mockResolvedValue({ ...CONTEXT, catalogVariantActive: true,
      catalogProductActive: false, catalogProductStatus: "archived" });
    const { service, inventoryPublication } = createHarness();

    await expect(service.processDue()).resolves.toMatchObject({ claimed: 1, superseded: 1 });
    expect(repository.supersedeAvailabilityClaim).toHaveBeenCalledWith(expect.anything(), activeClaim, false);
    expect(inventoryPublication.publishVariantAvailability).not.toHaveBeenCalled();
  });

  it("hands inactive variant zeroing to the canonical outbox without a direct provider write", async () => {
    const { service, pushInventory, allocationEngine, inventoryPublication } = createHarness();
    inventoryPublication.publishVariantAvailability.mockResolvedValue({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "9",
        activationRunId: "44",
        dryRun: false,
        productId: 10,
        rows: [{ productVariantId: 67, desiredQuantity: "0" }],
        enqueuedRows: 1,
        coalescedRows: 0,
        enqueuedPublicationKeys: ["5:67"],
        coalescedPublicationKeys: [],
      },
    });

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
      needsReview: 0,
    });
    expect(inventoryPublication.publishVariantAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 10,
        productVariantId: 67,
        channelId: 67,
        desiredActive: false,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(repository.markVariantAvailabilityDelegated).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
    );
    expect(repository.markVariantAvailabilitySynced).not.toHaveBeenCalled();
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
  });

  it("keeps the trigger retryable when canonical outbox handoff fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { service, inventoryPublication, pushInventory } = createHarness();
    inventoryPublication.publishVariantAvailability.mockRejectedValue(
      new Error("canonical outbox unavailable"),
    );

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 0,
      retried: 1,
      superseded: 0,
      needsReview: 0,
    });
    expect(repository.markVariantAvailabilityFailed).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      expect.objectContaining({ message: "canonical outbox unavailable" }),
    );
    expect(repository.markVariantAvailabilityDelegated).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("does not acknowledge a replaced trigger revision after canonical handoff", async () => {
    const { service, inventoryPublication, pushInventory } = createHarness();
    inventoryPublication.publishVariantAvailability.mockResolvedValue({
      authority: "canonical",
      publication: {
        authority: "canonical",
        authorityRevision: "9",
        activationRunId: "44",
        dryRun: false,
        productId: 10,
        rows: [{ productVariantId: 67, desiredQuantity: "0" }],
        enqueuedRows: 1,
        coalescedRows: 0,
        enqueuedPublicationKeys: ["5:67"],
        coalescedPublicationKeys: [],
      },
    });
    repository.markVariantAvailabilityDelegated.mockResolvedValue(false);

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 0,
      retried: 0,
      superseded: 1,
      needsReview: 0,
    });
    expect(repository.markVariantAvailabilitySynced).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
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
      needsReview: 0,
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
    const activationClaim = { ...CLAIM, desiredActive: true, requestKind: "catalog_activation" as const };
    repository.claimVariantAvailabilitySyncs.mockResolvedValue([activationClaim]);
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,
      catalogVariantActive: true,
      catalogSalesEligibility: "internal_only",
    });
    const { service, pushInventory, allocationEngine } = createHarness();

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      synced: 1,
      retried: 0,
      superseded: 0,
      needsReview: 0,
    });
    expect(repository.markVariantAvailabilityNotApplicable).toHaveBeenCalledWith(
      expect.anything(),
      activationClaim,
    );
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
    expect(repository.markVariantAvailabilitySynced).not.toHaveBeenCalled();
  });

  it("routes an explicit internal-only stock repair for an active variant through the inventory owner", async () => {
    repository.loadVariantAvailabilityContext.mockResolvedValue({
      ...CONTEXT,catalogVariantActive: true,catalogSalesEligibility: "internal_only",
    });
    const { service,pushInventory,allocationEngine,inventoryPublication } = createHarness();
    await expect(service.processDue()).resolves.toEqual({ claimed: 1,synced: 1,retried: 0,superseded: 0,needsReview: 0 });
    expect(repository.supersedeAvailabilityClaim).not.toHaveBeenCalled();
    expect(repository.markVariantAvailabilityNotApplicable).not.toHaveBeenCalled();
    expect(inventoryPublication.publishVariantAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 10,productVariantId: 67,channelId: 67,desiredActive: false }),expect.any(Function),expect.any(Function));
    expect(pushInventory).toHaveBeenCalledWith(67,[expect.objectContaining({ variantId: 67,allocatedQty: 0 })],undefined,expect.any(Function));
    expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
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
      needsReview: 0,
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
      needsReview: 0,
    });
    expect(repository.markVariantAvailabilityFailed).toHaveBeenCalledWith(
      expect.anything(),
      CLAIM,
      expect.objectContaining({ message: "eBay unavailable" }),
    );
    errorSpy.mockRestore();
  });
});
