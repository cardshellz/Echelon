import { beforeEach, describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  calculateBasisPointsFeeCents,
  cartonizeDropshipItems,
  normalizeDropshipQuoteItems,
  type DropshipBoxCatalogEntry,
  type DropshipPackageProfile,
} from "../../domain/shipping-quote";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipShippingQuoteService,
  type CreateDropshipShippingQuoteSnapshotInput,
  type DropshipInsurancePoolPolicy,
  type DropshipShippingMarkupPolicy,
  type DropshipShippingQuoteRepository,
  type DropshipShippingQuoteSnapshotRecord,
  type DropshipShippingStoreContext,
} from "../../application/dropship-shipping-quote-service";
import type {
  DropshipCartonizationProvider,
  DropshipCartonizationRequest,
  DropshipCartonizationResult,
} from "../../application/dropship-cartonization-provider";
import type {
  DropshipShippingRateMatch,
  DropshipShippingRateProvider,
  DropshipShippingRateRequest,
  DropshipShippingRateResult,
  DropshipShippingZoneMatch,
} from "../../application/dropship-shipping-rate-provider";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
const now = new Date("2026-05-01T16:00:00.000Z");

describe("dropship shipping quote domain", () => {
  it("cartonizes profiles deterministically and calculates basis-point fees with integer math", () => {
    const packages = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 3 },
      ]),
      packageProfiles: [makePackageProfile({ productVariantId: 101, maxUnitsPerPackage: 2 })],
      boxes: [makeBox({ id: 2, code: "LARGE", lengthMm: 300 }), makeBox({ id: 1, code: "SMALL" })],
    });

    expect(packages.map((carton) => ({
      sequence: carton.packageSequence,
      quantity: carton.quantity,
      boxCode: carton.boxCode,
      weightGrams: carton.weightGrams,
    }))).toEqual([
      { sequence: 1, quantity: 2, boxCode: "SMALL", weightGrams: 220 },
      { sequence: 2, quantity: 1, boxCode: "SMALL", weightGrams: 120 },
    ]);
    expect(calculateBasisPointsFeeCents(999, { bps: 200 })).toBe(19);
  });

  it("blocks cartonization when a package profile is missing", () => {
    expect(() => cartonizeDropshipItems({
      items: [{ productVariantId: 999, quantity: 1 }],
      packageProfiles: [],
      boxes: [makeBox()],
    })).toThrow(DropshipError);
  });
});

describe("DropshipShippingQuoteService", () => {
  let repository: FakeShippingQuoteRepository;
  let cartonization: FakeCartonizationProvider;
  let rateProvider: FakeRateProvider;
  let logs: DropshipLogEvent[];
  let service: DropshipShippingQuoteService;

  beforeEach(() => {
    repository = new FakeShippingQuoteRepository();
    cartonization = new FakeCartonizationProvider();
    rateProvider = new FakeRateProvider();
    logs = [];
    service = new DropshipShippingQuoteService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      cartonization,
      rateProvider,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });
  });

  it("creates an audited quote snapshot with hidden internal fee breakdown", async () => {
    const result = await service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "us", region: "ny", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 2 }],
      idempotencyKey: "quote-001",
    });

    expect(result).toMatchObject({
      quoteSnapshotId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      packageCount: 1,
      totalShippingCents: 1122,
      currency: "USD",
      carrierServices: [{ carrier: "USPS", service: "Ground Advantage" }],
    });
    expect(result.internalBreakdown).toMatchObject({
      baseRateCents: 1000,
      markupCents: 100,
      insurancePoolCents: 22,
      dunnageCents: 0,
    });
    expect(repository.snapshots[0]?.quotePayload).toMatchObject({
      policies: {
        shippingMarkup: { source: "config", markupBps: 1000 },
        insurancePool: { source: "config", feeBps: 200 },
      },
      providers: {
        cartonization: { name: "fake_cartonization" },
        rates: { name: "fake_rates" },
      },
    });
    expect(repository.lastCreateInput?.actor).toEqual({ actorType: "vendor", actorId: "member-1" });
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_SHIPPING_QUOTE_CREATED" });
  });

  it("replays the same idempotency key only when the request hash matches", async () => {
    const input = {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-002",
    };

    const first = await service.quoteForMember("member-1", input);
    const second = await service.quoteForMember("member-1", input);

    expect(second.quoteSnapshotId).toBe(first.quoteSnapshotId);
    expect(second.idempotentReplay).toBe(true);

    await expect(service.quoteForMember("member-1", {
      ...input,
      warehouseId: 4,
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("blocks quotes when the store is not connected", async () => {
    repository.context = {
      ...repository.context,
      storeStatus: "needs_reauth",
    };

    await expect(service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-003",
    })).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_STORE_BLOCKED" });
  });

  it("blocks quotes when the active shipping markup policy is missing", async () => {
    repository.markupPolicy = null;

    await expect(service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-004",
    })).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_MARKUP_POLICY_REQUIRED" });
    expect(repository.snapshots).toHaveLength(0);
  });

  it("blocks quotes when the active insurance pool policy is missing", async () => {
    repository.insurancePolicy = null;

    await expect(service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-005",
    })).rejects.toMatchObject({ code: "DROPSHIP_SHIPPING_INSURANCE_POLICY_REQUIRED" });
    expect(repository.snapshots).toHaveLength(0);
  });
});

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

class FakeShippingQuoteRepository implements DropshipShippingQuoteRepository {
  context: DropshipShippingStoreContext = {
    vendorId: 10,
    vendorStatus: "active",
    entitlementStatus: "active",
    storeConnectionId: 22,
    storeStatus: "connected",
    platform: "shopify",
  };
  markupPolicy: DropshipShippingMarkupPolicy | null = {
    id: 7,
    source: "config",
    markupBps: 1000,
    fixedMarkupCents: 0,
    minMarkupCents: null,
    maxMarkupCents: null,
  };
  insurancePolicy: DropshipInsurancePoolPolicy | null = {
    id: 8,
    source: "config",
    feeBps: 200,
    minFeeCents: null,
    maxFeeCents: null,
  };
  snapshots: DropshipShippingQuoteSnapshotRecord[] = [];
  lastCreateInput: CreateDropshipShippingQuoteSnapshotInput | null = null;

  async findQuoteSnapshotByIdempotencyKey(input: {
    vendorId: number;
    idempotencyKey: string;
  }): Promise<DropshipShippingQuoteSnapshotRecord | null> {
    return this.snapshots.find((snapshot) =>
      snapshot.vendorId === input.vendorId && snapshot.idempotencyKey === input.idempotencyKey
    ) ?? null;
  }

  async loadStoreContext(): Promise<DropshipShippingStoreContext | null> {
    return this.context;
  }

  async getActiveShippingMarkupPolicy(): Promise<DropshipShippingMarkupPolicy | null> {
    return this.markupPolicy;
  }

  async getActiveInsurancePoolPolicy(): Promise<DropshipInsurancePoolPolicy | null> {
    return this.insurancePolicy;
  }

  async createQuoteSnapshot(
    input: CreateDropshipShippingQuoteSnapshotInput,
  ): Promise<DropshipShippingQuoteSnapshotRecord> {
    this.lastCreateInput = input;
    const existing = await this.findQuoteSnapshotByIdempotencyKey(input);
    if (existing) {
      return existing;
    }
    const snapshot: DropshipShippingQuoteSnapshotRecord = {
      quoteSnapshotId: this.snapshots.length + 1,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      warehouseId: input.warehouseId,
      rateTableId: input.rateTableId,
      destinationCountry: input.destination.country,
      destinationPostalCode: input.destination.postalCode,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      packageCount: input.packageCount,
      baseRateCents: input.baseRateCents,
      markupCents: input.markupCents,
      insurancePoolCents: input.insurancePoolCents,
      dunnageCents: input.dunnageCents,
      totalShippingCents: input.totalShippingCents,
      quotePayload: input.quotePayload,
      createdAt: input.createdAt,
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }
}

class FakeCartonizationProvider implements DropshipCartonizationProvider {
  packageProfiles: DropshipPackageProfile[] = [makePackageProfile({ productVariantId: 101 })];
  boxes: DropshipBoxCatalogEntry[] = [makeBox()];

  async cartonize(input: DropshipCartonizationRequest): Promise<DropshipCartonizationResult> {
    return {
      packages: cartonizeDropshipItems({
        items: input.items,
        packageProfiles: this.packageProfiles,
        boxes: this.boxes,
      }),
      engine: {
        name: "fake_cartonization",
        version: "test",
      },
      warnings: [],
    };
  }
}

class FakeRateProvider implements DropshipShippingRateProvider {
  zone: DropshipShippingZoneMatch = { zoneRuleId: 5, zone: "zone-1" };

  async quoteRates(input: DropshipShippingRateRequest): Promise<DropshipShippingRateResult> {
    const rates: DropshipShippingRateMatch[] = input.packages.map((carton) => ({
      packageSequence: carton.packageSequence,
      rateTableId: 33,
      carrier: "USPS",
      service: "Ground Advantage",
      currency: "USD",
      rateCents: 1000,
    }));
    return {
      zone: this.zone,
      rates,
      provider: {
        name: "fake_rates",
        version: "test",
      },
    };
  }
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePackageProfile(overrides: Partial<DropshipPackageProfile> = {}): DropshipPackageProfile {
  return {
    productVariantId: 101,
    weightGrams: 100,
    lengthMm: 100,
    widthMm: 75,
    heightMm: 20,
    shipAlone: false,
    defaultCarrier: null,
    defaultService: null,
    defaultBoxId: null,
    maxUnitsPerPackage: null,
    ...overrides,
  };
}

function makeBox(overrides: Partial<DropshipBoxCatalogEntry> = {}): DropshipBoxCatalogEntry {
  return {
    id: 1,
    code: "SMALL",
    name: "Small Mailer",
    lengthMm: 200,
    widthMm: 150,
    heightMm: 40,
    tareWeightGrams: 20,
    maxWeightGrams: 1000,
    isActive: true,
    ...overrides,
  };
}
