import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderAcceptanceService,
  DROPSHIP_PRICING_SNAPSHOT_VERSION,
  buildDropshipOrderAcceptancePlan,
  hashDropshipOrderAcceptanceRequest,
  type DropshipNotificationSenderInput,
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
    const notificationSender = new FakeNotificationSender();
    const logs: DropshipLogEvent[] = [];
    const service = new DropshipOrderAcceptanceService({
      repository,
      notificationSender,
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
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_order_accepted",
      critical: false,
      idempotencyKey: "order-acceptance:1:accepted",
      payload: {
        intakeId: 1,
        omsOrderId: 1001,
        totalDebitCents: 2722,
      },
    });
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

  it("sends a critical notification when acceptance enters payment hold", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      omsOrderId: null,
      walletLedgerEntryId: null,
      economicsSnapshotId: null,
      totalDebitCents: 7500,
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
    });
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderAcceptanceService({
      repository,
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });

    const result = await service.acceptOrder({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      shippingQuoteSnapshotId: 33,
      idempotencyKey: "accept-001",
      actor: { actorType: "system" },
    });

    expect(result.outcome).toBe("payment_hold");
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_payment_hold",
      critical: true,
      idempotencyKey: "order-acceptance:1:payment_hold",
    });
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

  it("blocks acceptance when the store connection is connected but not launch-ready", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      vendor: {
        ...makePlanningInput().vendor,
        storeLaunchReady: false,
      },
    })), "DROPSHIP_ORDER_STORE_BLOCKED");
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

  it("preserves an active payment hold expiration across repeated worker claims", () => {
    const existingExpiresAt = new Date("2026-05-01T20:00:00.000Z");
    const firstSweep = buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "processing",
        paymentHoldExpiresAt: existingExpiresAt,
      },
      wallet: {
        walletAccountId: 1,
        availableBalanceCents: 100,
        pendingBalanceCents: 10_000,
        currency: "USD",
      },
    }));
    const secondSweep = buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "processing",
        paymentHoldExpiresAt: firstSweep.paymentHoldExpiresAt,
      },
      wallet: {
        walletAccountId: 1,
        availableBalanceCents: 100,
        pendingBalanceCents: 10_000,
        currency: "USD",
      },
      acceptedAt: new Date("2026-05-01T18:10:00.000Z"),
    }));

    expect(firstSweep.outcome).toBe("payment_hold");
    expect(firstSweep.paymentHoldExpiresAt).toEqual(existingExpiresAt);
    expect(secondSweep.outcome).toBe("payment_hold");
    expect(secondSweep.paymentHoldExpiresAt).toEqual(existingExpiresAt);
  });

  it("blocks a worker-claimed payment hold after its original deadline", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "processing",
        paymentHoldExpiresAt: new Date("2026-05-01T17:59:59.000Z"),
      },
    })), "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED");
  });

  it("rejects a payment hold that has no expiration", () => {
    expectDropshipError(() => buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: {
        ...makePlanningInput().intake,
        status: "payment_hold",
        paymentHoldExpiresAt: null,
      },
    })), "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRY_REQUIRED");
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

  it("freezes the .ops cost authority, provenance, and evidence hash in pricing snapshot v2", () => {
    const plan = buildDropshipOrderAcceptancePlan(makePlanningInput());

    expect(plan.wholesaleSubtotalCents).toBe(1600);
    expect(plan.totalDebitCents).toBe(2722);
    expect(plan.costEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.pricingSnapshot).toMatchObject({
      version: DROPSHIP_PRICING_SNAPSHOT_VERSION,
      wholesale: {
        authority: "shellz_club_ops_product_cost",
        costResolvedAt: now.toISOString(),
        costEvidenceHash: plan.costEvidenceHash,
        lines: [{
          productVariantId: 101,
          quantity: 2,
          wholesaleUnitCostCents: 800,
          wholesaleLineTotalCents: 1600,
          costSource: "variant_fixed_price",
          costPlanId: "ops",
          costOverrideId: "override-1",
        }],
      },
    });
    expect(JSON.stringify(plan.pricingSnapshot)).not.toContain("channelDiscountPercent");
  });

  it("produces the same evidence hash for the same cost inputs regardless of line order", () => {
    const second = {
      lineIndex: 1,
      listingId: 502,
      productId: 202,
      productVariantId: 102,
      productLineIds: [301],
      sku: "SKU-102",
      title: "Sleeve",
      category: "cards",
      quantity: 1,
      catalogRetailPriceCents: 500,
      observedRetailUnitPriceCents: 500,
      wholesaleUnitCostCents: 400,
      productCostEvidence: { source: "plan_percent" as const, planId: "ops", overrideId: null },
      externalLineItemId: "line-2",
    };
    const quote = baseQuote();
    quote.quotePayload = {
      ...quote.quotePayload,
      items: [{ productVariantId: 101, quantity: 2 }, { productVariantId: 102, quantity: 1 }],
    };
    const first = makePlanningInput().lines[0];
    const inventory = [{ productVariantId: 101, availableQty: 2 }, { productVariantId: 102, availableQty: 1 }];

    const forward = buildDropshipOrderAcceptancePlan(makePlanningInput({ quote, inventory, lines: [first, second] }));
    const reversed = buildDropshipOrderAcceptancePlan(makePlanningInput({ quote, inventory, lines: [second, first] }));

    expect(forward.costEvidenceHash).toBe(reversed.costEvidenceHash);
    expect(forward.wholesaleSubtotalCents).toBe(2000);
  });

  it("refuses a line whose wholesale cost is not positive integer cents", () => {
    const line = makePlanningInput().lines[0];
    expectDropshipError(
      () => buildDropshipOrderAcceptancePlan(makePlanningInput({ lines: [{ ...line, wholesaleUnitCostCents: 0 }] })),
      "DROPSHIP_ORDER_MONEY_INVALID",
    );
    expectDropshipError(
      () => buildDropshipOrderAcceptancePlan(makePlanningInput({ lines: [{ ...line, wholesaleUnitCostCents: 8.09 }] })),
      "DROPSHIP_ORDER_MONEY_INVALID",
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

  constructor(private readonly resultOverrides: Partial<DropshipOrderAcceptanceResult> = {}) {}

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
      ...this.resultOverrides,
    };
  }
}

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
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
      storeLaunchReady: true,
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
      productCostEvidence: { source: "variant_fixed_price", planId: "ops", overrideId: "override-1" },
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
