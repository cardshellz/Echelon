import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderAcceptanceService,
  buildDropshipOrderAcceptancePlan,
  calculateDiscountedWholesaleUnitCostCents,
  hashDropshipOrderAcceptanceRequest,
  type DropshipAcceptancePlanningInput,
  type DropshipLogEvent,
  type DropshipOrderAcceptanceInput,
  type DropshipOrderAcceptanceRepository,
  type DropshipOrderAcceptanceResult,
} from "../../application";

const now = new Date("2026-05-01T18:00:00.000Z");

describe("DropshipOrderAcceptanceService", () => {
  it("sends a deterministic acceptance request to the repository", async () => {
    const repository = new FakeAcceptanceRepository();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderAcceptanceService({
      repository,
      clock: { now: () => now },
      logger: {
        info: (event) => logs.push(event),
        warn: (event) => logs.push(event),
        error: (event) => logs.push(event),
      },
    });

    const result = await service.acceptOrder({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      idempotencyKey: "accept-001",
      actor: { actorType: "system" },
    });

    expect(result.outcome).toBe("accepted");
    expect(repository.lastInput?.acceptedAt).toEqual(now);
    expect(repository.lastInput?.requestHash).toBe(hashDropshipOrderAcceptanceRequest({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      idempotencyKey: "different-key",
      actor: { actorType: "system" },
    }));
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_ORDER_ACCEPTED" });
  });

  it("rejects invalid acceptance input before repository calls", async () => {
    const repository = new FakeAcceptanceRepository();
    const service = new DropshipOrderAcceptanceService({
      repository,
      clock: { now: () => now },
      logger: noopLogger,
    });

    await expect(service.acceptOrder({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      idempotencyKey: "accept-001",
      actor: { actorType: "system" },
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_ACCEPTANCE_INVALID_INPUT" });
    expect(repository.lastInput).toBeNull();
  });
});

describe("buildDropshipOrderAcceptancePlan", () => {
  it("accepts when address, quote, inventory, and wallet all validate", () => {
    const plan = buildDropshipOrderAcceptancePlan(makePlanningInput());

    expect(plan).toMatchObject({
      outcome: "accepted",
      omsExternalOrderId: "dropship:22:EXT-1",
      retailSubtotalCents: 2000,
      wholesaleSubtotalCents: 1600,
      shippingCents: 1122,
      insurancePoolCents: 22,
      totalDebitCents: 2722,
      paymentHoldExpiresAt: null,
    });
    expect(plan.pricingSnapshot).toMatchObject({
      membership: { memberId: "member-1", planId: "ops", tier: "ops" },
      totals: { totalDebitCents: 2722 },
    });
  });

  it("places the intake on payment hold without accepting when wallet funds are insufficient", () => {
    const plan = buildDropshipOrderAcceptancePlan(makePlanningInput({
      wallet: {
        walletAccountId: 1,
        availableBalanceCents: 100,
        pendingBalanceCents: 10_000,
        currency: "USD",
      },
    }));

    expect(plan.outcome).toBe("payment_hold");
    expect(plan.paymentHoldExpiresAt?.toISOString()).toBe("2026-05-03T18:00:00.000Z");
    expect(plan.totalDebitCents).toBe(2722);
  });

  it("preserves an active payment hold expiration instead of extending the hold", () => {
    const existingExpiresAt = new Date("2026-05-01T20:00:00.000Z");
    const plan = buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "payment_hold",
        paymentHoldExpiresAt: existingExpiresAt,
      },
      wallet: {
        walletAccountId: 1,
        availableBalanceCents: 100,
        pendingBalanceCents: 10_000,
        currency: "USD",
      },
    }));

    expect(plan.outcome).toBe("payment_hold");
    expect(plan.paymentHoldExpiresAt).toEqual(existingExpiresAt);
  });

  it("blocks acceptance after a payment hold has expired", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "payment_hold",
        paymentHoldExpiresAt: new Date("2026-05-01T17:59:59.000Z"),
      },
    })), "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED");
  });

  it("blocks quote item mismatch before wallet or OMS effects", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      quote: {
        ...baseQuote(),
        quotePayload: {
          destination: { country: "US", postalCode: "10001" },
          items: [{ productVariantId: 101, quantity: 1 }],
        },
      },
    })), "DROPSHIP_ORDER_SHIPPING_QUOTE_ITEMS_MISMATCH");
  });

  it("blocks inventory shortfall before acceptance", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      inventory: [{ productVariantId: 101, availableQty: 1 }],
    })), "DROPSHIP_ORDER_INVENTORY_SHORTFALL");
  });

  it("honors block_order_acceptance pricing policies and ignores warn-only policies", () => {
    const warnOnly = buildDropshipOrderAcceptancePlan(makePlanningInput({
      pricingPolicies: [{
        id: 7,
        scopeType: "variant",
        productLineId: null,
        productId: null,
        productVariantId: 101,
        category: null,
        mode: "warn_only",
        floorPriceCents: 1200,
        ceilingPriceCents: null,
      }],
    }));
    expect(warnOnly.outcome).toBe("accepted");

    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      pricingPolicies: [{
        id: 8,
        scopeType: "variant",
        productLineId: null,
        productId: null,
        productVariantId: 101,
        category: null,
        mode: "block_order_acceptance",
        floorPriceCents: 1200,
        ceilingPriceCents: null,
      }],
    })), "DROPSHIP_ORDER_PRICING_POLICY_BLOCKED");
  });

  it("calculates wholesale with integer math", () => {
    expect(calculateDiscountedWholesaleUnitCostCents(999, 15)).toBe(850);
    expectDropshipError(
      () => calculateDiscountedWholesaleUnitCostCents(999.5, 15),
      "DROPSHIP_ORDER_MONEY_INVALID",
    );
    expectDropshipError(
      () => calculateDiscountedWholesaleUnitCostCents(999, 101),
      "DROPSHIP_WHOLESALE_DISCOUNT_INVALID",
    );
  });
});

function expectDropshipError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DropshipError);
  expect((thrown as DropshipError).code).toBe(code);
}

class FakeAcceptanceRepository implements DropshipOrderAcceptanceRepository {
  lastInput: DropshipOrderAcceptanceInput | null = null;

  async acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    return {
      outcome: "accepted",
      intakeId: input.intakeId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
      omsOrderId: 1001,
      walletLedgerEntryId: 2001,
      economicsSnapshotId: 3001,
      totalDebitCents: 2722,
      currency: "USD",
      paymentHoldExpiresAt: null,
      idempotentReplay: false,
    };
  }
}

function makePlanningInput(
  overrides: Partial<DropshipAcceptancePlanningInput> = {},
): DropshipAcceptancePlanningInput {
  return {
    intake: {
      intakeId: 1,
      channelId: 5,
      vendorId: 10,
      storeConnectionId: 22,
      platform: "shopify",
      externalOrderId: "EXT-1",
      externalOrderNumber: "1001",
      status: "received",
      rawPayload: { id: "EXT-1" },
      normalizedPayload: {
        orderedAt: "2026-05-01T17:00:00.000Z",
        lines: [{
          productVariantId: 101,
          quantity: 2,
          unitRetailPriceCents: 1000,
          externalLineItemId: "line-1",
          title: "Shell",
        }],
        shipTo: {
          name: "Buyer Name",
          address1: "1 Main St",
          city: "New York",
          region: "NY",
          postalCode: "10001",
          country: "US",
          email: "buyer@example.com",
        },
      },
      omsOrderId: null,
      paymentHoldExpiresAt: null,
    },
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      currentPlanId: "ops",
      membershipPlanId: "ops",
      membershipPlanTier: "ops",
      vendorStatus: "active",
      entitlementStatus: "active",
      storeConnectionId: 22,
      storeStatus: "connected",
      channelDiscountPercent: 20,
    },
    quote: baseQuote(),
    lines: [{
      lineIndex: 0,
      listingId: 501,
      productId: 201,
      productVariantId: 101,
      productLineIds: [301],
      sku: "SKU-101",
      title: "Shell",
      category: "cards",
      quantity: 2,
      catalogRetailPriceCents: 1000,
      observedRetailUnitPriceCents: 1000,
      wholesaleUnitCostCents: 800,
      externalLineItemId: "line-1",
    }],
    pricingPolicies: [],
    inventory: [{ productVariantId: 101, availableQty: 2 }],
    wallet: {
      walletAccountId: 1,
      availableBalanceCents: 5000,
      pendingBalanceCents: 0,
      currency: "USD",
    },
    paymentHoldTimeoutMinutes: 2880,
    requestHash: "request-hash",
    idempotencyKey: "accept-001",
    acceptedAt: now,
    ...overrides,
  };
}

function baseQuote() {
  return {
    quoteSnapshotId: 33,
    vendorId: 10,
    storeConnectionId: 22,
    warehouseId: 3,
    currency: "USD",
    destinationCountry: "US",
    destinationPostalCode: "10001",
    packageCount: 1,
    totalShippingCents: 1122,
    insurancePoolCents: 22,
    quotePayload: {
      destination: { country: "US", postalCode: "10001" },
      items: [{ productVariantId: 101, quantity: 2 }],
    },
  };
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
