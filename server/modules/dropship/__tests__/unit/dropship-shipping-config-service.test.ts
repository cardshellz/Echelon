import { describe, expect, it } from "vitest";
import { DropshipShippingConfigService, hashDropshipShippingConfigCommand, type DropshipBoxConfigRecord, type DropshipInsurancePoolPolicyRecord, type DropshipPackageProfileConfigRecord, type DropshipRateTableConfigRecord, type DropshipShippingConfigMutationResult, type DropshipShippingConfigOverview, type DropshipShippingConfigRepository, type DropshipShippingMarkupPolicyRecord, type DropshipZoneRuleConfigRecord } from "../../application/dropship-shipping-config-service";

const now = new Date("2026-05-03T14:00:00.000Z");

describe("DropshipShippingConfigService", () => {
  it("normalizes box input and passes idempotency context to the repository", async () => {
    const repository = new FakeShippingConfigRepository();
    const service = new DropshipShippingConfigService({
      repository,
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const result = await service.upsertBox({
      code: " small mailer ",
      name: "Small Mailer",
      lengthMm: 230,
      widthMm: 160,
      heightMm: 10,
      tareWeightGrams: 12,
      maxWeightGrams: null,
      isActive: true,
      idempotencyKey: "shipping-box-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.record.code).toBe("SMALL_MAILER");
    expect(repository.lastBoxInput).toMatchObject({
      code: "SMALL_MAILER",
      idempotencyKey: "shipping-box-001",
      requestHash: expect.any(String),
      now,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
  });

  it("hashes semantically equivalent command payloads deterministically", () => {
    const first = hashDropshipShippingConfigCommand("shipping_rate_table_created", {
      carrier: "USPS",
      service: "Ground Advantage",
      metadata: { b: 2, a: 1 },
      rows: [{ destinationZone: "2", minWeightGrams: 0, maxWeightGrams: 450, rateCents: 525 }],
    });
    const second = hashDropshipShippingConfigCommand("shipping_rate_table_created", {
      carrier: "USPS",
      service: "Ground Advantage",
      metadata: { a: 1, b: 2 },
      rows: [{ destinationZone: "2", minWeightGrams: 0, maxWeightGrams: 450, rateCents: 525 }],
    });

    expect(first).toBe(second);
  });

  it("rejects invalid rate bands before repository writes", async () => {
    const repository = new FakeShippingConfigRepository();
    const service = new DropshipShippingConfigService({
      repository,
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(service.createRateTable({
      carrier: "USPS",
      service: "Ground Advantage",
      rows: [{ destinationZone: "2", minWeightGrams: 500, maxWeightGrams: 100, rateCents: 525 }],
      idempotencyKey: "rate-table-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toThrow();
    expect(repository.lastRateTableInput).toBeNull();
  });

  it("rejects invalid policy min/max bounds before repository writes", async () => {
    const repository = new FakeShippingConfigRepository();
    const service = new DropshipShippingConfigService({
      repository,
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    await expect(service.createInsurancePolicy({
      name: "Carrier pool",
      feeBps: 200,
      minFeeCents: 500,
      maxFeeCents: 100,
      idempotencyKey: "insurance-policy-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toThrow();
    expect(repository.lastInsuranceInput).toBeNull();
  });
});

class FakeShippingConfigRepository implements DropshipShippingConfigRepository {
  lastBoxInput: Parameters<DropshipShippingConfigRepository["upsertBox"]>[0] | null = null;
  lastRateTableInput: Parameters<DropshipShippingConfigRepository["createRateTable"]>[0] | null = null;
  lastInsuranceInput: Parameters<DropshipShippingConfigRepository["createInsurancePolicy"]>[0] | null = null;

  async getOverview(input: Parameters<DropshipShippingConfigRepository["getOverview"]>[0]): Promise<DropshipShippingConfigOverview> {
    return {
      boxes: [],
      packageProfiles: [],
      zoneRules: [],
      rateTables: [],
      activeMarkupPolicy: null,
      activeInsurancePolicy: null,
      generatedAt: input.generatedAt,
    };
  }

  async upsertBox(input: Parameters<DropshipShippingConfigRepository["upsertBox"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipBoxConfigRecord>> {
    this.lastBoxInput = input;
    return {
      record: {
        boxId: input.boxId ?? 1,
        code: input.code,
        name: input.name,
        lengthMm: input.lengthMm,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        tareWeightGrams: input.tareWeightGrams,
        maxWeightGrams: input.maxWeightGrams,
        isActive: input.isActive,
        createdAt: input.now,
        updatedAt: input.now,
      },
      idempotentReplay: false,
    };
  }

  async upsertPackageProfile(input: Parameters<DropshipShippingConfigRepository["upsertPackageProfile"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipPackageProfileConfigRecord>> {
    return {
      record: {
        packageProfileId: 1,
        productVariantId: input.productVariantId,
        productSku: "P",
        productName: "Product",
        variantSku: "V",
        variantName: "Variant",
        weightGrams: input.weightGrams,
        lengthMm: input.lengthMm,
        widthMm: input.widthMm,
        heightMm: input.heightMm,
        shipAlone: input.shipAlone,
        defaultCarrier: input.defaultCarrier,
        defaultService: input.defaultService,
        defaultBoxId: input.defaultBoxId,
        maxUnitsPerPackage: input.maxUnitsPerPackage,
        isActive: input.isActive,
        createdAt: input.now,
        updatedAt: input.now,
      },
      idempotentReplay: false,
    };
  }

  async upsertZoneRule(input: Parameters<DropshipShippingConfigRepository["upsertZoneRule"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipZoneRuleConfigRecord>> {
    return {
      record: {
        zoneRuleId: input.zoneRuleId ?? 1,
        originWarehouseId: input.originWarehouseId,
        destinationCountry: input.destinationCountry,
        destinationRegion: input.destinationRegion,
        postalPrefix: input.postalPrefix,
        zone: input.zone,
        priority: input.priority,
        isActive: input.isActive,
        createdAt: input.now,
        updatedAt: input.now,
      },
      idempotentReplay: false,
    };
  }

  async createRateTable(input: Parameters<DropshipShippingConfigRepository["createRateTable"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipRateTableConfigRecord>> {
    this.lastRateTableInput = input;
    return {
      record: {
        rateTableId: 1,
        carrier: input.carrier,
        service: input.service,
        currency: input.currency,
        status: input.status,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        metadata: input.metadata,
        createdAt: input.now,
        rows: input.rows.map((row, index) => ({
          rateTableRowId: index + 1,
          rateTableId: 1,
          warehouseId: row.warehouseId,
          destinationZone: row.destinationZone,
          minWeightGrams: row.minWeightGrams,
          maxWeightGrams: row.maxWeightGrams,
          rateCents: row.rateCents,
          createdAt: input.now,
        })),
      },
      idempotentReplay: false,
    };
  }

  async createMarkupPolicy(input: Parameters<DropshipShippingConfigRepository["createMarkupPolicy"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipShippingMarkupPolicyRecord>> {
    return {
      record: {
        policyId: 1,
        name: input.name,
        markupBps: input.markupBps,
        fixedMarkupCents: input.fixedMarkupCents,
        minMarkupCents: input.minMarkupCents,
        maxMarkupCents: input.maxMarkupCents,
        isActive: input.isActive,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        createdAt: input.now,
      },
      idempotentReplay: false,
    };
  }

  async createInsurancePolicy(input: Parameters<DropshipShippingConfigRepository["createInsurancePolicy"]>[0]): Promise<DropshipShippingConfigMutationResult<DropshipInsurancePoolPolicyRecord>> {
    this.lastInsuranceInput = input;
    return {
      record: {
        policyId: 1,
        name: input.name,
        feeBps: input.feeBps,
        minFeeCents: input.minFeeCents,
        maxFeeCents: input.maxFeeCents,
        isActive: input.isActive,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        createdAt: input.now,
      },
      idempotentReplay: false,
    };
  }
}
