import { describe, expect, it } from "vitest";
import {
  allocateVendorShippingCharge,
  assertCarrierClaimOccurredAfterShipment,
  calculateAffectedWholesaleCost,
  determineInitialCarrierClaimState,
  DropshipCarrierClaimService,
  type CarrierClaimMutationResult,
  type CarrierClaimRecord,
  type CarrierClaimRepository,
} from "../../application/dropship-carrier-claim-service";

const now = new Date("2026-07-11T12:00:00.000Z");

describe("carrier claim shipping allocation", () => {
  it("uses the full order charge for a single shipment without requiring captured cost", () => {
    expect(allocateVendorShippingCharge({
      orderShippingChargeCents: 1200,
      shipments: [{ wmsShipmentId: 11, carrierCostCents: null, costCaptured: false }],
    })).toEqual({
      method: "single_shipment_full_charge_v1",
      totalCarrierCostCents: null,
      allocations: [{ wmsShipmentId: 11, carrierCostCents: null, allocatedShippingChargeCents: 1200 }],
    });
  });

  it("allocates split-order shipping by captured carrier-cost share", () => {
    expect(allocateVendorShippingCharge({
      orderShippingChargeCents: 1200,
      shipments: [
        { wmsShipmentId: 11, carrierCostCents: 500, costCaptured: true },
        { wmsShipmentId: 12, carrierCostCents: 1500, costCaptured: true },
      ],
    })).toEqual({
      method: "carrier_cost_proportional_largest_remainder_v1",
      totalCarrierCostCents: 2000,
      allocations: [
        { wmsShipmentId: 11, carrierCostCents: 500, allocatedShippingChargeCents: 300 },
        { wmsShipmentId: 12, carrierCostCents: 1500, allocatedShippingChargeCents: 900 },
      ],
    });
  });

  it("rejects combined carrier costs outside the safe integer range", () => {
    expect(() => allocateVendorShippingCharge({
      orderShippingChargeCents: 1200,
      shipments: [
        { wmsShipmentId: 11, carrierCostCents: Number.MAX_SAFE_INTEGER, costCaptured: true },
        { wmsShipmentId: 12, carrierCostCents: 1, costCaptured: true },
      ],
    })).toThrowError(expect.objectContaining({ code: "DROPSHIP_CARRIER_CLAIM_MONEY_OVERFLOW" }));
  });

  it("uses stable shipment-id tie breaking for indivisible cents", () => {
    const plan = allocateVendorShippingCharge({
      orderShippingChargeCents: 100,
      shipments: [
        { wmsShipmentId: 13, carrierCostCents: 100, costCaptured: true },
        { wmsShipmentId: 11, carrierCostCents: 100, costCaptured: true },
        { wmsShipmentId: 12, carrierCostCents: 100, costCaptured: true },
      ],
    });
    expect(plan.allocations).toEqual([
      { wmsShipmentId: 11, carrierCostCents: 100, allocatedShippingChargeCents: 34 },
      { wmsShipmentId: 12, carrierCostCents: 100, allocatedShippingChargeCents: 33 },
      { wmsShipmentId: 13, carrierCostCents: 100, allocatedShippingChargeCents: 33 },
    ]);
    expect(plan.allocations.reduce((sum, row) => sum + row.allocatedShippingChargeCents, 0)).toBe(100);
  });

  it("fails closed when any split shipment lacks captured positive cost", () => {
    expect(() => allocateVendorShippingCharge({
      orderShippingChargeCents: 1200,
      shipments: [
        { wmsShipmentId: 11, carrierCostCents: 500, costCaptured: true },
        { wmsShipmentId: 12, carrierCostCents: null, costCaptured: false },
      ],
    })).toThrowError(expect.objectContaining({ code: "DROPSHIP_CARRIER_CLAIM_SHIPMENT_COST_REQUIRED" }));
  });

  it("allocates zero shipping without requiring shipment costs", () => {
    const plan = allocateVendorShippingCharge({
      orderShippingChargeCents: 0,
      shipments: [
        { wmsShipmentId: 11, carrierCostCents: null, costCaptured: false },
        { wmsShipmentId: 12, carrierCostCents: null, costCaptured: false },
      ],
    });
    expect(plan.method).toBe("zero_shipping_charge_v1");
    expect(plan.allocations.every((row) => row.allocatedShippingChargeCents === 0)).toBe(true);
  });
});

describe("carrier claim wholesale snapshot", () => {
  it("calculates only affected shipment quantities from accepted wholesale costs", () => {
    expect(calculateAffectedWholesaleCost({
      pricingSnapshot: {
        wholesale: {
          lines: [
            { productVariantId: 101, quantity: 3, wholesaleUnitCostCents: 400 },
            { productVariantId: 102, quantity: 1, wholesaleUnitCostCents: 900 },
          ],
        },
      },
      shipmentItems: [{ productVariantId: 101, quantity: 1 }],
    })).toEqual({
      totalCents: 400,
      lines: [{ productVariantId: 101, quantity: 1, wholesaleUnitCostCents: 400, wholesaleLineTotalCents: 400 }],
    });
  });

  it("rejects shipment quantities exceeding the accepted snapshot", () => {
    expect(() => calculateAffectedWholesaleCost({
      pricingSnapshot: { wholesale: { lines: [{ productVariantId: 101, quantity: 1, wholesaleUnitCostCents: 400 }] } },
      shipmentItems: [{ productVariantId: 101, quantity: 2 }],
    })).toThrowError(expect.objectContaining({ code: "DROPSHIP_CARRIER_CLAIM_SHIPMENT_PRICING_MISMATCH" }));
  });
});

describe("carrier claim state", () => {
  const policy = {
    lossWaitDays: 7,
    misdeliveryWaitDays: 2,
    damageInspectionRequired: true,
    carrierClaimRequired: true,
  };

  it("keeps an early loss in its waiting period", () => {
    const state = determineInitialCarrierClaimState({
      eventType: "loss",
      policy,
      shippedAt: new Date("2026-07-10T12:00:00.000Z"),
      now,
      hasInspection: false,
      hasExternalCarrierClaim: false,
    });
    expect(state.status).toBe("waiting_period");
    expect(state.eligibleAt.toISOString()).toBe("2026-07-17T12:00:00.000Z");
  });

  it("routes eligible damage through inspection before carrier claim tracking", () => {
    expect(determineInitialCarrierClaimState({
      eventType: "damage",
      policy,
      shippedAt: new Date("2026-07-01T12:00:00.000Z"),
      now,
      hasInspection: false,
      hasExternalCarrierClaim: false,
    }).status).toBe("awaiting_inspection");
  });

  it("rejects a carrier event timestamp before the physical shipment", () => {
    expect(() => assertCarrierClaimOccurredAfterShipment({
      occurredAt: new Date("2026-07-01T11:59:59.999Z"),
      shippedAt: new Date("2026-07-01T12:00:00.000Z"),
    })).toThrowError(expect.objectContaining({
      code: "DROPSHIP_CARRIER_CLAIM_OCCURRED_BEFORE_SHIPMENT",
    }));
  });
});

describe("DropshipCarrierClaimService", () => {
  it("does not accept caller-supplied money", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.createClaim({
      wmsShipmentId: 11,
      eventType: "loss",
      calculatedCreditCents: 999999,
      idempotencyKey: "carrier-claim-001",
      actor: { actorType: "admin" },
    })).rejects.toThrow();
  });

  it("normalizes an idempotent claim command and injects the clock", async () => {
    const repository = new FakeRepository();
    const service = makeService(repository);
    await service.createClaim({
      wmsShipmentId: 11,
      eventType: "misdelivery",
      idempotencyKey: "carrier-claim-002",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(repository.input).toMatchObject({
      wmsShipmentId: 11,
      eventType: "misdelivery",
      occurredAt: now,
      now,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("requires an authenticated actor ID for admin commands", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.createClaim({
      wmsShipmentId: 11,
      eventType: "loss",
      idempotencyKey: "carrier-claim-003",
      actor: { actorType: "admin" },
    })).rejects.toThrow();
  });
});

function makeService(repository: CarrierClaimRepository): DropshipCarrierClaimService {
  return new DropshipCarrierClaimService({
    repository,
    clock: { now: () => now },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
}

class FakeRepository implements CarrierClaimRepository {
  input: Parameters<CarrierClaimRepository["createClaim"]>[0] | null = null;

  async createClaim(input: Parameters<CarrierClaimRepository["createClaim"]>[0]): Promise<CarrierClaimMutationResult> {
    this.input = input;
    return { record: claimRecord(), idempotentReplay: false };
  }

  async listClaims(): Promise<CarrierClaimRecord[]> { return []; }
}

function claimRecord(): CarrierClaimRecord {
  return {
    claimId: 1,
    intakeId: 2,
    wmsShipmentId: 11,
    eventType: "misdelivery",
    status: "waiting_period",
    policyId: 3,
    assignmentId: 4,
    shippingAllocationId: 5,
    currency: "USD",
    carrier: "UPS",
    trackingNumber: "1ZTEST",
    externalClaimId: null,
    wholesaleCostSnapshotCents: 400,
    shippingChargeSnapshotCents: 1200,
    calculatedCreditCents: 1600,
    approvedCreditCents: null,
    occurredAt: now,
    eligibleAt: now,
    createdAt: now,
  };
}
