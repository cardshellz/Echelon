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
  DropshipShippingShadowComparator,
} from "../../application/dropship-shipping-shadow-comparison";
import type {
  DropshipSharedShippingQuoteProvider,
  DropshipSharedShippingQuoteRequest,
  DropshipSharedShippingQuoteResult,
} from "../../application/dropship-shared-shipping-quote";
import type {
  DropshipShippingCutoverPolicy,
} from "../../application/dropship-shipping-cutover-policy";
import {
  CutoverDropshipShippingPricingProvider,
} from "../../application/dropship-shipping-pricing-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";
const now = new Date("2026-05-01T16:00:00.000Z");

describe("dropship shipping quote domain", () => {
  it("derives carton count from physical placement without a max-units setting", () => {
    const { packages, warnings } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 3 },
      ]),
      packageProfiles: [makePackageProfile({
        productVariantId: 101,
        lengthMm: 60,
        widthMm: 60,
        heightMm: 60,
      })],
      boxes: [makeBox({
        id: 1,
        code: "CUBE",
        lengthMm: 100,
        widthMm: 100,
        heightMm: 100,
      })],
    });

    expect(warnings).toEqual([]);
    expect(packages.map((carton) => ({
      sequence: carton.packageSequence,
      quantity: carton.quantity,
      boxCode: carton.boxCode,
      weightGrams: carton.weightGrams,
    }))).toEqual([
      { sequence: 1, quantity: 1, boxCode: "CUBE", weightGrams: 120 },
      { sequence: 2, quantity: 1, boxCode: "CUBE", weightGrams: 120 },
      { sequence: 3, quantity: 1, boxCode: "CUBE", weightGrams: 120 },
    ]);
    expect(calculateBasisPointsFeeCents(999, { bps: 200 })).toBe(19);
  });

  it("co-packs compatible SKUs from the same order", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
        { productVariantId: 102, quantity: 1 },
      ]),
      packageProfiles: [
        makePackageProfile({
          productVariantId: 101,
          lengthMm: 40,
          widthMm: 40,
          heightMm: 40,
        }),
        makePackageProfile({
          productVariantId: 102,
          lengthMm: 40,
          widthMm: 40,
          heightMm: 40,
        }),
      ],
      boxes: [makeBox({
        lengthMm: 100,
        widthMm: 50,
        heightMm: 50,
      })],
    });

    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({
      productVariantId: null,
      quantity: 2,
      items: [
        { productVariantId: 101, quantity: 1 },
        { productVariantId: 102, quantity: 1 },
      ],
    });
    expect(packages[0].placements).toHaveLength(2);
  });

  it("keeps SKUs with different requested services in separate packing batches", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
        { productVariantId: 102, quantity: 1 },
      ]),
      packageProfiles: [
        makePackageProfile({
          productVariantId: 101,
          defaultCarrier: "USPS",
          defaultService: "Ground Advantage",
        }),
        makePackageProfile({
          productVariantId: 102,
          defaultCarrier: "UPS",
          defaultService: "Ground",
        }),
      ],
      boxes: [makeBox()],
    });

    expect(packages).toHaveLength(2);
    expect(packages.map((carton) => [
      carton.productVariantId,
      carton.requestedCarrier,
      carton.requestedService,
    ])).toEqual([
      [101, "USPS", "Ground Advantage"],
      [102, "UPS", "Ground"],
    ]);
  });

  it("keeps catalog shipping groups in separate cartons", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
        { productVariantId: 102, quantity: 1 },
      ]),
      packageProfiles: [
        makePackageProfile({
          productVariantId: 101,
          shippingGroupCode: "protection",
        }),
        makePackageProfile({
          productVariantId: 102,
          shippingGroupCode: "storage_boxes",
        }),
      ],
      boxes: [makeBox({
        lengthMm: 500,
        widthMm: 500,
        heightMm: 500,
      })],
    });

    expect(packages).toHaveLength(2);
    expect(packages.map((carton) => carton.productVariantId).sort()).toEqual([101, 102]);
  });

  it("keeps ship-alone quantities in one carton per unit", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 2 },
      ]),
      packageProfiles: [makePackageProfile({ shipsInOwnContainer: true })],
      boxes: [makeBox()],
    });

    expect(packages).toHaveLength(2);
    expect(packages.every((carton) => carton.quantity === 1)).toBe(true);
  });

  it("degrades to a weight-only package with a warning when no box fits", () => {
    const { packages, warnings } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
      ]),
      packageProfiles: [makePackageProfile({
        productVariantId: 101,
        lengthMm: 2000,
        widthMm: 20,
        heightMm: 20,
      })],
      boxes: [makeBox({
        lengthMm: 200,
        widthMm: 200,
        heightMm: 200,
      })],
    });

    expect(packages).toEqual([expect.objectContaining({
      packageSequence: 1,
      productVariantId: 101,
      quantity: 1,
      boxId: null,
      boxCode: null,
      weightGrams: 100,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    })]);
    expect(warnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
      reason: "no_box_fits",
      productVariantIds: [101],
    })]);
  });

  it("degrades to a weight-only package with a warning when dims are missing", () => {
    const { packages, warnings } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 2 },
      ]),
      packageProfiles: [makePackageProfile({
        productVariantId: 101,
        weightGrams: 150,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      })],
      boxes: [makeBox()],
    });

    expect(packages).toEqual([expect.objectContaining({
      boxId: null,
      boxCode: null,
      weightGrams: 300,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    })]);
    expect(warnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
      reason: "missing_dims",
      productVariantIds: [101],
    })]);
  });

  it("degrades to weight-only packages with a warning when no boxes are configured", () => {
    const { packages, warnings } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
      ]),
      packageProfiles: [makePackageProfile({ productVariantId: 101 })],
      boxes: [],
    });

    expect(packages).toEqual([expect.objectContaining({
      boxId: null,
      boxCode: null,
      weightGrams: 100,
    })]);
    expect(warnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
      reason: "no_boxes_configured",
      productVariantIds: [101],
    })]);
  });

  it("uses item rotation when the carton requires it", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 1 },
      ]),
      packageProfiles: [makePackageProfile({
        productVariantId: 101,
        lengthMm: 90,
        widthMm: 40,
        heightMm: 30,
      })],
      boxes: [makeBox({
        code: "ROTATED",
        lengthMm: 40,
        widthMm: 30,
        heightMm: 90,
      })],
    });

    expect(packages).toHaveLength(1);
    expect(packages[0].boxCode).toBe("ROTATED");
  });

  it("splits packages at the automatic 50 lb handling ceiling", () => {
    const { packages } = cartonizeDropshipItems({
      items: normalizeDropshipQuoteItems([
        { productVariantId: 101, quantity: 2 },
      ]),
      packageProfiles: [makePackageProfile({
        productVariantId: 101,
        weightGrams: 12000,
      })],
      boxes: [makeBox({
        lengthMm: 1000,
        widthMm: 1000,
        heightMm: 1000,
        maxWeightGrams: null,
      })],
    });

    expect(packages).toHaveLength(2);
    expect(packages.every((carton) => carton.weightGrams <= 22679)).toBe(true);
  });

  it("still throws when canonical catalog weight is missing", () => {
    let thrown: unknown;
    try {
      cartonizeDropshipItems({
        items: [{ productVariantId: 999, quantity: 1 }],
        packageProfiles: [],
        boxes: [makeBox()],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DropshipError);
    expect(thrown).toMatchObject({ code: "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED" });
  });

  it("still throws when the catalog weight is non-positive", () => {
    let thrown: unknown;
    try {
      cartonizeDropshipItems({
        items: [{ productVariantId: 101, quantity: 1 }],
        packageProfiles: [makePackageProfile({ productVariantId: 101, weightGrams: null })],
        boxes: [makeBox()],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DropshipError);
    expect(thrown).toMatchObject({ code: "DROPSHIP_CATALOG_PACKAGE_DATA_REQUIRED" });
  });
});

describe("DropshipShippingQuoteService", () => {
  let repository: FakeShippingQuoteRepository;
  let cartonization: FakeCartonizationProvider;
  let rateProvider: FakeRateProvider;
  let shadowComparison: FakeShadowComparison;
  let logs: DropshipLogEvent[];
  let service: DropshipShippingQuoteService;

  beforeEach(() => {
    repository = new FakeShippingQuoteRepository();
    cartonization = new FakeCartonizationProvider();
    rateProvider = new FakeRateProvider();
    shadowComparison = new FakeShadowComparison();
    logs = [];
    const logger = {
      info: (event: DropshipLogEvent) => logs.push(event),
      warn: (event: DropshipLogEvent) => logs.push(event),
      error: (event: DropshipLogEvent) => logs.push(event),
    };
    service = new DropshipShippingQuoteService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      cartonization,
      pricingProvider: new CutoverDropshipShippingPricingProvider({
        cutoverPolicy: legacyCutoverPolicy(),
        legacyRateProvider: rateProvider,
        sharedQuoteProvider: new FakeSharedQuoteProvider(sharedQuote(800)),
        logger,
      }),
      shadowComparison,
      clock: { now: () => now },
      logger,
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
      version: 2,
      policies: {
        shippingMarkup: { source: "config", markupBps: 1000 },
        insurancePool: { source: "config", feeBps: 200 },
      },
      providers: {
        cartonization: { name: "fake_cartonization" },
        rates: { name: "fake_rates" },
      },
      packages: [{
        items: [{ productVariantId: 101, quantity: 2 }],
        placements: expect.any(Array),
      }],
    });
    expect(repository.lastCreateInput?.actor).toEqual({ actorType: "vendor", actorId: "member-1" });
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_SHIPPING_QUOTE_CREATED" });
    expect(shadowComparison.snapshots).toHaveLength(1);
  });

  it("quotes and persists packaging warnings when variant dims are missing", async () => {
    cartonization.packageProfiles = [makePackageProfile({
      productVariantId: 101,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    })];

    const result = await service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-packaging-warning",
    });

    // Quote succeeds (no exception) and prices from the weight-only package.
    expect(result.totalShippingCents).toBe(1122);
    expect(result.packageCount).toBe(1);

    // Structured warning persisted on the snapshot row and in the payload.
    expect(repository.lastCreateInput?.warnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
      reason: "missing_dims",
      productVariantIds: [101],
    })]);
    expect(repository.snapshots[0]?.warnings).toEqual([expect.objectContaining({
      code: "PACKAGING_DATA_INCOMPLETE",
    })]);
    expect(repository.snapshots[0]?.quotePayload).toMatchObject({
      warnings: {
        packaging: [expect.objectContaining({ code: "PACKAGING_DATA_INCOMPLETE" })],
      },
      packages: [expect.objectContaining({
        boxId: null,
        dimensionsMm: null,
      })],
    });
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
    expect(shadowComparison.snapshots).toHaveLength(2);

    await expect(service.quoteForMember("member-1", {
      ...input,
      warehouseId: 4,
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("creates one shipment-scoped shared snapshot and preserves it across rollback", async () => {
    const sharedProvider = new FakeSharedQuoteProvider(sharedQuote(800));
    const logger = {
      info: (event: DropshipLogEvent) => logs.push(event),
      warn: (event: DropshipLogEvent) => logs.push(event),
      error: (event: DropshipLogEvent) => logs.push(event),
    };
    service = new DropshipShippingQuoteService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      cartonization,
      pricingProvider: new CutoverDropshipShippingPricingProvider({
        cutoverPolicy: {
          mode: "test",
          storeConnectionIds: new Set([22]),
        },
        legacyRateProvider: rateProvider,
        sharedQuoteProvider: sharedProvider,
        logger,
      }),
      shadowComparison,
      clock: { now: () => now },
      logger,
    });
    const input = {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", region: "PA", postalCode: "16066" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-shared-cutover",
    };

    const first = await service.quoteForMember("member-1", input);

    expect(first).toMatchObject({
      totalShippingCents: 897,
      currency: "USD",
      carrierServices: [],
      internalBreakdown: {
        baseRateCents: 800,
        markupCents: 80,
        insurancePoolCents: 17,
        rateTableId: 44,
      },
    });
    expect(repository.snapshots).toHaveLength(1);
    expect(repository.snapshots[0]?.quotePayload).toMatchObject({
      version: 3,
      providers: {
        cartonization: { name: "fake_cartonization" },
        rates: { name: "cardshellz-rates", version: "2.0.0" },
      },
      pricing: {
        scope: "shipment",
        source: "shared_engine",
        cutover: {
          mode: "test",
          source: "shared",
          reasonCode: "TEST_STORE_ALLOWED",
        },
        rateBookId: 12,
        rateTableId: 44,
        selectedRate: {
          totalCents: 800,
          serviceLevelCode: "standard",
        },
      },
      totals: {
        totalShippingCents: 897,
      },
    });
    expect(sharedProvider.requests).toHaveLength(1);
    expect(rateProvider.requests).toHaveLength(0);
    expect(shadowComparison.snapshots).toHaveLength(0);

    const rollbackService = new DropshipShippingQuoteService({
      vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
      repository,
      cartonization,
      pricingProvider: new CutoverDropshipShippingPricingProvider({
        cutoverPolicy: legacyCutoverPolicy(),
        legacyRateProvider: rateProvider,
        sharedQuoteProvider: sharedProvider,
        logger,
      }),
      shadowComparison,
      clock: { now: () => now },
      logger,
    });
    const replay = await rollbackService.quoteForMember("member-1", input);

    expect(replay).toMatchObject({
      quoteSnapshotId: first.quoteSnapshotId,
      idempotentReplay: true,
      totalShippingCents: 897,
    });
    expect(repository.snapshots).toHaveLength(1);
    expect(rateProvider.requests).toHaveLength(0);
    expect(sharedProvider.requests).toHaveLength(1);
    expect(shadowComparison.snapshots).toHaveLength(0);
  });

  it("returns the legacy quote when the shared shadow comparison fails", async () => {
    shadowComparison.error = new Error("shared rate book unavailable");

    const result = await service.quoteForMember("member-1", {
      storeConnectionId: 22,
      warehouseId: 3,
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 1 }],
      idempotencyKey: "quote-shadow-failure",
    });

    expect(result.totalShippingCents).toBe(1122);
    expect(repository.snapshots).toHaveLength(1);
    expect(logs).toContainEqual(expect.objectContaining({
      code: "DROPSHIP_SHIPPING_SHADOW_COMPARISON_FAILED",
      context: expect.objectContaining({
        legacyQuoteSnapshotId: result.quoteSnapshotId,
        error: "shared rate book unavailable",
      }),
    }));
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
      warnings: input.warnings,
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
    const result = cartonizeDropshipItems({
      items: input.items,
      packageProfiles: this.packageProfiles,
      boxes: this.boxes,
    });
    return {
      packages: result.packages,
      engine: {
        name: "fake_cartonization",
        version: "test",
      },
      warnings: result.warnings.map((warning) => warning.message),
      packagingWarnings: result.warnings,
    };
  }
}

class FakeRateProvider implements DropshipShippingRateProvider {
  zone: DropshipShippingZoneMatch = { zoneRuleId: 5, zone: "zone-1" };
  requests: DropshipShippingRateRequest[] = [];

  async quoteRates(input: DropshipShippingRateRequest): Promise<DropshipShippingRateResult> {
    this.requests.push(input);
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

class FakeShadowComparison implements DropshipShippingShadowComparator {
  snapshots: DropshipShippingQuoteSnapshotRecord[] = [];
  error: Error | null = null;

  async compare(snapshot: DropshipShippingQuoteSnapshotRecord): Promise<void> {
    this.snapshots.push(snapshot);
    if (this.error) throw this.error;
  }
}

class FakeSharedQuoteProvider implements DropshipSharedShippingQuoteProvider {
  requests: DropshipSharedShippingQuoteRequest[] = [];

  constructor(
    public result: DropshipSharedShippingQuoteResult | Error,
  ) {}

  async quote(
    input: DropshipSharedShippingQuoteRequest,
  ): Promise<DropshipSharedShippingQuoteResult> {
    this.requests.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function legacyCutoverPolicy(): DropshipShippingCutoverPolicy {
  return {
    mode: "legacy",
    storeConnectionIds: new Set(),
  };
}

function sharedQuote(
  baseRateCents: number,
): Extract<DropshipSharedShippingQuoteResult, { status: "quoted" }> {
  return {
    status: "quoted",
    baseRateCents,
    currency: "USD",
    serviceLevelCode: "standard",
    rateBookId: 12,
    rateBookCode: "dropship-vendor-default",
    rateTableId: 44,
    resolvedZone: "PA",
    ratedWeightGrams: 120,
    rateProvider: {
      name: "cardshellz-rates",
      version: "2.0.0",
    },
    selectedRate: {
      serviceLevelId: 1,
      serviceLevelCode: "standard",
      displayName: "Standard Shipping",
      description: null,
      fulfillmentMode: "parcel",
      pricingBasis: "shipment_weight",
      totalCents: baseRateCents,
      currency: "USD",
      promiseMinBusinessDays: 3,
      promiseMaxBusinessDays: 7,
      ratedMeasure: 120,
      maxShipmentWeightGrams: null,
      chargeModel: "fixed_band",
      perStartedPoundCents: null,
      billablePounds: null,
      rateTableId: 44,
      productPolicyApplied: false,
      calculationTrace: [],
    },
    warnings: [],
    routing: {
      source: "channel_policy",
      mode: "engine_quoted",
      rateBookId: 12,
    },
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
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePackageProfile(overrides: Partial<DropshipPackageProfile> = {}): DropshipPackageProfile {
  return {
    productVariantId: 101,
    sku: "SKU-101",
    weightGrams: 100,
    lengthMm: 100,
    widthMm: 75,
    heightMm: 20,
    shippingGroupCode: null,
    shipsInOwnContainer: false,
    maxUnitsPerPackage: null,
    defaultCarrier: null,
    defaultService: null,
    defaultBoxId: null,
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
