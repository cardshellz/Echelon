import { describe, expect, it } from "vitest";
import {
  DropshipOrderAcceptanceService,
  DropshipOrderAcceptanceWorkflowService,
  deriveShippingQuoteIdempotencyKey,
  type DropshipCanonicalAcceptanceFulfillment,
  type DropshipInventoryRuntimeAuthorityGate,
  type DropshipLogEvent,
  type DropshipOrderAcceptanceInput,
  type DropshipOrderAcceptanceRepository,
  type DropshipOrderAcceptanceResult,
  type DropshipOrderAcceptanceWorkflowContext,
  type DropshipOrderAcceptanceWorkflowRepository,
  type DropshipOmsFulfillmentSync,
  type DropshipShippingQuoteResult,
} from "../../application";
import type { NormalizedDropshipOrderPayload } from "../../application/dropship-order-intake-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-03T16:00:00.000Z");

describe("DropshipOrderAcceptanceWorkflowService", () => {
  it.each(["Canada", " ca ", "UK", "United Kingdom"])("canonicalizes %s before quoting", async country => {
    const repository = new FakeWorkflowRepository();
    repository.context.normalizedPayload.shipTo!.country = country;
    const shippingQuoteService = new FakeShippingQuoteService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository, shippingQuoteService, acceptanceService: new FakeAcceptanceService(), logger: noopLogger,
    });
    await service.acceptOrderForMember("member-1", { intakeId: 7, idempotencyKey: "accept-order-007" });
    expect(shippingQuoteService.lastInput).toMatchObject({ destination: { country: country.trim().toLowerCase().startsWith("ca") ? "CA" : "GB" } });
    expect(repository.context.normalizedPayload.shipTo!.country).toBe(country);
  });

  it.each(["XX", "Atlantis", "constructor"])("rejects %s before quote and acceptance effects", async country => {
    const repository = new FakeWorkflowRepository();
    repository.context.normalizedPayload.shipTo!.country = country;
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository, shippingQuoteService, acceptanceService, logger: noopLogger,
    });
    await expect(service.acceptOrderForMember("member-1", { intakeId: 7, idempotencyKey: "accept-order-007" }))
      .rejects.toMatchObject({ code: "DROPSHIP_ORDER_SHIP_TO_COUNTRY_INVALID", context: { retryable: false } });
    expect(shippingQuoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
  });

  it("quotes shipping from the order payload and accepts with the vendor actor", async () => {
    const repository = new FakeWorkflowRepository();
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService,
      logger: captureLogger(logs),
    });

    const result = await service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    });

    expect(repository.lastInput).toEqual({ vendorId: 10, intakeId: 7 });
    expect(shippingQuoteService.lastInput).toEqual({
      vendorId: 10,
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", region: "NY", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 2 }],
      idempotencyKey: deriveShippingQuoteIdempotencyKey("accept-order-007"),
    });
    expect(acceptanceService.lastInput).toEqual({
      intakeId: 7,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 44,
      idempotencyKey: "accept-order-007",
      actor: { actorType: "vendor", actorId: "member-1" },
    });
    expect(result.acceptance.outcome).toBe("accepted");
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ORDER_ACCEPTANCE_WORKFLOW_COMPLETED",
        context: expect.objectContaining({
          intakeId: 7,
          vendorId: 10,
          storeConnectionId: 22,
          quoteSnapshotId: 44,
        }),
      }),
    ]));
  });

  it("syncs vendor-accepted dropship OMS orders into WMS", async () => {
    const fulfillmentSync = new FakeFulfillmentSync(9901);
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository: new FakeWorkflowRepository(),
      shippingQuoteService: new FakeShippingQuoteService(),
      acceptanceService: new FakeAcceptanceService(),
      fulfillmentSync,
      logger: captureLogger(logs),
    });

    const result = await service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    });

    expect(result.acceptance.outcome).toBe("accepted");
    expect(fulfillmentSync.calls).toEqual([9001]);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DROPSHIP_ACCEPTED_ORDER_WMS_SYNCED",
        context: expect.objectContaining({
          intakeId: 7,
          omsOrderId: 9001,
          wmsOrderId: 9901,
          source: "vendor_acceptance",
        }),
      }),
    ]));
  });

  it("runs prepare -> canonical claim -> finalize before normal WMS operational promotion", async () => {
    const events: string[] = [];
    const acceptanceRepository = new SequencedCanonicalAcceptanceRepository(events);
    const fulfillment = new SequencedCanonicalFulfillment(events);
    const acceptanceService = new DropshipOrderAcceptanceService({
      repository: acceptanceRepository,
      inventoryAuthority: new CanonicalInventoryAuthority(),
      canonicalFulfillment: fulfillment,
      clock: { now: () => now },
      logger: noopLogger,
    });
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository: new FakeWorkflowRepository(),
      shippingQuoteService: new FakeShippingQuoteService(),
      acceptanceService,
      fulfillmentSync: fulfillment,
      logger: noopLogger,
    });

    const result = await service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    });

    expect(result.acceptance.outcome).toBe("accepted");
    expect(events).toEqual([
      "prepare:7",
      "canonical_claim:9001:3",
      "claim_recorded:9001:9901",
      "finalize:7",
      "normal_wms_sync:9001",
    ]);
  });

  it("requires a default warehouse before quote or acceptance side effects", async () => {
    const repository = new FakeWorkflowRepository();
    repository.context = {
      ...repository.context,
      defaultWarehouseId: null,
    };
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService,
      logger: noopLogger,
    });

    await expect(service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_DEFAULT_WAREHOUSE_REQUIRED" });
    expect(shippingQuoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
  });

  it("requires every order line to resolve to an internal product variant before quoting", async () => {
    const repository = new FakeWorkflowRepository();
    repository.context = {
      ...repository.context,
      normalizedPayload: {
        ...repository.context.normalizedPayload,
        lines: [{ quantity: 1, sku: "SKU-101" }],
      },
    };
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService,
      logger: noopLogger,
    });

    await expect(service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_LINE_VARIANT_REQUIRED" });
    expect(shippingQuoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
  });

  it("requires the complete ship-to address before creating a quote snapshot", async () => {
    const repository = new FakeWorkflowRepository();
    repository.context = {
      ...repository.context,
      normalizedPayload: {
        ...repository.context.normalizedPayload,
        shipTo: {
          ...repository.context.normalizedPayload.shipTo,
          city: undefined,
        },
      },
    };
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService,
      logger: noopLogger,
    });

    await expect(service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007",
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_SHIP_TO_REQUIRED" });
    expect(shippingQuoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toBeNull();
  });

  // A vendor may press Accept on a failed, held or processing order, which
  // acceptance may already have staged with its own quote; each click sends a
  // new key, so pricing a new quote would have the stage refuse the order.
  it("replays the staged quote when acceptance already staged the intake", async () => {
    const repository = new FakeWorkflowRepository();
    repository.context = { ...repository.context, stagedShippingQuoteSnapshotId: 3652 };
    const shippingQuoteService = new FakeShippingQuoteService();
    const acceptanceService = new FakeAcceptanceService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService,
      logger: noopLogger,
    });

    const result = await service.acceptOrderForMember("member-1", {
      intakeId: 7,
      idempotencyKey: "accept-order-007-second-click",
    });

    expect(shippingQuoteService.replayInputs).toEqual([{ vendorId: 10, storeConnectionId: 22, quoteSnapshotId: 3652 }]);
    expect(shippingQuoteService.lastInput).toBeNull();
    expect(acceptanceService.lastInput).toMatchObject({ intakeId: 7, shippingQuoteSnapshotId: 3652 });
    expect(result.quote).toMatchObject({ quoteSnapshotId: 3652, idempotentReplay: true });
  });

  it("does not need the store's default warehouse to replay a staged quote", async () => {
    const repository = new FakeWorkflowRepository();
    repository.context = { ...repository.context, defaultWarehouseId: null, stagedShippingQuoteSnapshotId: 3652 };
    const shippingQuoteService = new FakeShippingQuoteService();
    const service = new DropshipOrderAcceptanceWorkflowService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      shippingQuoteService,
      acceptanceService: new FakeAcceptanceService(),
      logger: noopLogger,
    });

    await service.acceptOrderForMember("member-1", { intakeId: 7, idempotencyKey: "accept-order-007" });

    expect(shippingQuoteService.replayInputs).toHaveLength(1);
  });

  it("keeps derived quote idempotency keys inside the accepted length range", () => {
    const longKey = "accept-order-" + "x".repeat(220);

    expect(deriveShippingQuoteIdempotencyKey(longKey)).toHaveLength(87);
  });
});

class FakeWorkflowRepository implements DropshipOrderAcceptanceWorkflowRepository {
  context: DropshipOrderAcceptanceWorkflowContext = {
    intakeId: 7,
    vendorId: 10,
    storeConnectionId: 22,
    defaultWarehouseId: 3,
    normalizedPayload: makeNormalizedPayload(),
    stagedShippingQuoteSnapshotId: null,
  };
  lastInput: { vendorId: number; intakeId: number } | null = null;

  async loadOrderAcceptanceContext(input: {
    vendorId: number;
    intakeId: number;
  }): Promise<DropshipOrderAcceptanceWorkflowContext | null> {
    this.lastInput = input;
    return this.context;
  }
}

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

class FakeShippingQuoteService {
  lastInput: unknown = null;
  replayInputs: unknown[] = [];

  async replayQuoteSnapshot(input: { quoteSnapshotId: number }): Promise<DropshipShippingQuoteResult> {
    this.replayInputs.push(input);
    return { ...this.quoteResult(), quoteSnapshotId: input.quoteSnapshotId, idempotentReplay: true };
  }

  async quote(input: unknown): Promise<DropshipShippingQuoteResult> {
    this.lastInput = input;
    return this.quoteResult();
  }

  private quoteResult(): DropshipShippingQuoteResult {
    return {
      quoteSnapshotId: 44,
      idempotentReplay: false,
      vendorId: 10,
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", region: "NY", postalCode: "10001" },
      packageCount: 1,
      totalShippingCents: 1122,
      currency: "USD",
      carrierServices: [{ carrier: "USPS", service: "Ground Advantage" }],
      internalBreakdown: {
        baseRateCents: 1000,
        markupCents: 100,
        insurancePoolCents: 22,
        dunnageCents: 0,
        rateTableId: 33,
        requestHash: "quote-hash",
      },
    };
  }
}

class FakeAcceptanceService {
  lastInput: unknown = null;

  async acceptOrder(input: unknown): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    return {
      outcome: "accepted",
      intakeId: 7,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 44,
      omsOrderId: 9001,
      walletLedgerEntryId: 3001,
      economicsSnapshotId: 7001,
      totalDebitCents: 2722,
      currency: "USD",
      paymentHoldExpiresAt: null,
      paymentHoldReason: null,
      idempotentReplay: false,
    };
  }
}

class FakeFulfillmentSync implements DropshipOmsFulfillmentSync {
  calls: number[] = [];

  constructor(private readonly result: number | null) {}

  async syncOmsOrderToWms(omsOrderId: number): Promise<number | null> {
    this.calls.push(omsOrderId);
    return this.result;
  }
}

class CanonicalInventoryAuthority implements DropshipInventoryRuntimeAuthorityGate {
  async execute<T>(work: (authority: "legacy" | "canonical") => Promise<T>): Promise<T> {
    return work("canonical");
  }
}

class SequencedCanonicalAcceptanceRepository implements DropshipOrderAcceptanceRepository {
  constructor(private readonly events: string[]) {}

  async acceptOrder(): Promise<DropshipOrderAcceptanceResult> {
    throw new Error("legacy acceptance must not run under canonical authority");
  }

  async prepareCanonicalOrder(input: DropshipOrderAcceptanceInput) {
    this.events.push(`prepare:${input.intakeId}`);
    return {
      outcome: "prepared" as const,
      intakeId: input.intakeId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
      warehouseId: 3,
      omsOrderId: 9001,
      idempotentReplay: false,
    };
  }

  async markCanonicalInventoryClaimed(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
  }): Promise<void> {
    this.events.push(`claim_recorded:${input.omsOrderId}:${input.wmsOrderId}`);
  }

  async finalizeCanonicalOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    this.events.push(`finalize:${input.intakeId}`);
    return {
      outcome: "accepted",
      intakeId: input.intakeId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
      omsOrderId: 9001,
      walletLedgerEntryId: 3001,
      economicsSnapshotId: 7001,
      totalDebitCents: 2722,
      currency: "USD",
      paymentHoldExpiresAt: null,
      paymentHoldReason: null,
      idempotentReplay: false,
    };
  }

  async markCanonicalInventoryClaimReleased(): Promise<void> {
    throw new Error("successful canonical acceptance must not release its claim");
  }
}

class SequencedCanonicalFulfillment
implements DropshipCanonicalAcceptanceFulfillment, DropshipOmsFulfillmentSync {
  constructor(private readonly events: string[]) {}

  async stageOmsOrderAndClaimInventory(input: {
    omsOrderId: number;
    expectedWarehouseId: number;
  }): Promise<{ wmsOrderId: number; warehouseId: number; inventoryClaimId: string | null }> {
    this.events.push(`canonical_claim:${input.omsOrderId}:${input.expectedWarehouseId}`);
    return { wmsOrderId: 9901, warehouseId: input.expectedWarehouseId, inventoryClaimId: "7001" };
  }

  async releaseStagedInventoryClaim(): Promise<void> {
    throw new Error("successful canonical acceptance must not release its claim");
  }

  async syncOmsOrderToWms(omsOrderId: number): Promise<number> {
    this.events.push(`normal_wms_sync:${omsOrderId}`);
    return 9901;
  }
}

function makeNormalizedPayload(): NormalizedDropshipOrderPayload {
  return {
    lines: [{
      externalLineItemId: "line-1",
      productVariantId: 101,
      quantity: 2,
      unitRetailPriceCents: 1000,
      title: "Test SKU",
    }],
    shipTo: {
      name: "Vendor Customer",
      address1: "1 Main St",
      city: "New York",
      region: "NY",
      postalCode: "10001",
      country: "US",
    },
    orderedAt: now.toISOString(),
    marketplaceStatus: "paid",
  };
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.com",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    standingReason: null,
    pausedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function captureLogger(events: DropshipLogEvent[]) {
  return {
    info: (event: DropshipLogEvent) => events.push(event),
    warn: (event: DropshipLogEvent) => events.push(event),
    error: (event: DropshipLogEvent) => events.push(event),
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
