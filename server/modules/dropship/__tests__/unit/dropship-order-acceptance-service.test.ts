import { describe, expect, it } from "vitest";
import { DropshipError } from "../../domain/errors";
import {
  DropshipOrderAcceptanceService,
  DROPSHIP_PRICING_SNAPSHOT_VERSION,
  buildDropshipOrderAcceptancePlan,
  hashDropshipOrderAcceptanceRequest,
  type DropshipNotificationSenderInput,
  type DropshipCanonicalAcceptanceFulfillment,
  type DropshipAcceptancePlanningInput,
  type DropshipInventoryRuntimeAuthority,
  type DropshipInventoryRuntimeAuthorityGate,
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
      inventoryAuthority: new FakeInventoryAuthority("legacy"),
      canonicalFulfillment: new FakeCanonicalFulfillment(),
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
      inventoryAuthority: new FakeInventoryAuthority("legacy"),
      canonicalFulfillment: new FakeCanonicalFulfillment(),
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
      inventoryAuthority: new FakeInventoryAuthority("legacy"),
      canonicalFulfillment: new FakeCanonicalFulfillment(),
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

  it("tells a paused vendor the order waits for the wallet minimum, not for the order amount", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      omsOrderId: null,
      walletLedgerEntryId: null,
      economicsSnapshotId: null,
      totalDebitCents: 7500,
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      paymentHoldReason: "vendor_paused",
    });
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderAcceptanceService({
      repository,
      inventoryAuthority: new FakeInventoryAuthority("legacy"),
      canonicalFulfillment: new FakeCanonicalFulfillment(),
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

    expect(result).toMatchObject({ outcome: "payment_hold", paymentHoldReason: "vendor_paused" });
    expect(notificationSender.sent[0]).toMatchObject({
      eventType: "dropship_order_payment_hold",
      critical: true,
      payload: expect.objectContaining({ paymentHoldReason: "vendor_paused" }),
    });
    expect(notificationSender.sent[0].message).toBe(
      "Order intake 1 is waiting because selling is paused. Fund your wallet back to its minimum before 2026-05-03T12:00:00.000Z and it will be accepted for USD $75.00.",
    );
  });

  it("stays silent when asked to, and says the pass's one outcome later with what the top-up came to", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      omsOrderId: null,
      walletLedgerEntryId: null,
      economicsSnapshotId: null,
      totalDebitCents: 7500,
      paymentHoldExpiresAt: new Date("2026-05-03T12:00:00.000Z"),
      paymentHoldReason: "insufficient_balance",
    });
    const notificationSender = new FakeNotificationSender();
    const service = new DropshipOrderAcceptanceService({
      repository,
      inventoryAuthority: new FakeInventoryAuthority("legacy"),
      canonicalFulfillment: new FakeCanonicalFulfillment(),
      notificationSender,
      clock: { now: () => now },
      logger: noopLogger,
    });
    const input = { intakeId: 1, vendorId: 10, storeConnectionId: 22, shippingQuoteSnapshotId: 33, idempotencyKey: "accept-001", actor: { actorType: "system" as const } };

    const held = await service.acceptOrder(input, { notify: false });
    expect(held.outcome).toBe("payment_hold");
    expect(notificationSender.sent).toEqual([]);

    const base = "Order intake 1 is on payment hold and requires USD $75.00 before 2026-05-03T12:00:00.000Z.";
    const cases: Array<[Parameters<typeof service.notifyAcceptanceOutcome>[1], string]> = [
      [{}, base],
      [{ reload: null }, base],
      [{ reload: { kind: "pending", amountCents: 4000, currency: "USD" } }, `${base} A bank top-up of USD $40.00 is on its way; the order is accepted when it settles.`],
      [{ reload: { kind: "declined", detail: "insufficient_funds" } }, `${base} We tried to charge your card for the shortfall and it was declined (insufficient funds). Add funds or update your card in Wallet.`],
      [{ reload: { kind: "declined", detail: null } }, `${base} We tried to charge your card for the shortfall and it was declined. Add funds or update your card in Wallet.`],
      [{ reload: { kind: "failed", message: "Stripe unavailable" } }, `${base} We could not top up your wallet automatically (Stripe unavailable); add funds to accept it sooner.`],
      [{ reload: { kind: "skipped", reason: "amount_exceeds_max_single_reload" } }, `${base} Auto-reload could not top it up: the amount is over your single-reload limit. Add funds or check auto-reload in Wallet.`],
      [{ reload: { kind: "skipped", reason: "some_new_reason" } }, `${base} Auto-reload could not top it up: some new reason. Add funds or check auto-reload in Wallet.`],
    ];
    for (const [context, expected] of cases) {
      notificationSender.sent = [];
      await service.notifyAcceptanceOutcome(held, context);
      expect(notificationSender.sent).toHaveLength(1);
      expect(notificationSender.sent[0]).toMatchObject({
        eventType: "dropship_order_payment_hold",
        critical: true,
        idempotencyKey: "order-acceptance:1:payment_hold",
        payload: expect.objectContaining({ paymentHoldReason: "insufficient_balance", reload: context?.reload ?? null }),
      });
      expect(notificationSender.sent[0].message).toBe(expected);
    }

    // A replay never re-announces.
    notificationSender.sent = [];
    await service.notifyAcceptanceOutcome({ ...held, idempotentReplay: true }, { reload: { kind: "failed", message: "x" } });
    expect(notificationSender.sent).toEqual([]);

    // The default still tells the vendor right away (manual acceptance from the Orders page).
    await service.acceptOrder(input);
    expect(notificationSender.sent.map((sent) => sent.eventType)).toEqual(["dropship_order_payment_hold"]);
  });

  it("finalizes canonical acceptance only after the WMS whole-order claim succeeds", async () => {
    const repository = new FakeAcceptanceRepository();
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    const result = await service.acceptOrder(validAcceptanceInput());

    expect(result.outcome).toBe("accepted");
    expect(repository.events).toEqual([
      "prepare",
      "mark_inventory_claimed:1001:9001",
      "finalize",
    ]);
    expect(fulfillment.events).toEqual(["claim:1001:3"]);
    expect(repository.legacyCalls).toBe(0);
  });

  it.each([
    ["canonical safety-stock shortfall", "CANONICAL_CLAIM_SHORTFALL"],
    ["canonical claim execution failure", "CANONICAL_CLAIM_FAILED"],
    ["WMS staging failure", "WMS_STAGE_FAILED"],
  ])("does not finalize or debit after %s", async (_label, code) => {
    const repository = new FakeAcceptanceRepository();
    const fulfillment = new FakeCanonicalFulfillment(Object.assign(new Error(code), { code }));
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toMatchObject({ code });
    expect(repository.events).toEqual(["prepare"]);
    expect(repository.legacyCalls).toBe(0);
  });

  it("releases a successful claim if the wallet changes before finalization", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-02T18:00:00.000Z"),
    });
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    const result = await service.acceptOrder(validAcceptanceInput());

    expect(result.outcome).toBe("payment_hold");
    expect(fulfillment.events).toEqual(["claim:1001:3", "release:9001"]);
    expect(fulfillment.releasedClaimIds).toEqual(["7001"]);
    expect(repository.events).toEqual([
      "prepare",
      "mark_inventory_claimed:1001:9001",
      "finalize",
      "mark_inventory_released:1001:9001",
    ]);
  });

  it("creates a second claim attempt and finalizes exactly once after a released hold is funded", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-02T18:00:00.000Z"),
    });
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    const held = await service.acceptOrder(validAcceptanceInput());
    repository.fundWalletForRetry();
    const accepted = await service.acceptOrder(validAcceptanceInput());

    expect(held.outcome).toBe("payment_hold");
    expect(accepted.outcome).toBe("accepted");
    expect(repository.claimAttempts).toBe(2);
    expect(repository.acceptedFinalizations).toBe(1);
    expect(repository.events.filter((event) => event === "finalize")).toHaveLength(2);
    expect(fulfillment.events).toEqual([
      "claim:1001:3",
      "release:9001",
      "claim:1001:3",
    ]);
    expect(fulfillment.releasedClaimIds).toEqual(["7001"]);
  });

  it("releases an orphaned canonical claim before rejecting an expired payment hold", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-01T17:59:59.000Z"),
    });
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
    });

    expect(fulfillment.events).toEqual(["claim:1001:3", "release:9001"]);
    expect(repository.events).toEqual([
      "prepare",
      "mark_inventory_claimed:1001:9001",
      "finalize",
      "mark_inventory_released:1001:9001",
    ]);
  });

  it("retries an expired payment-hold release without re-claiming inventory or finalizing", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-01T17:59:59.000Z"),
    });
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
    });
    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
    });

    expect(repository.events.filter((event) => event === "finalize")).toHaveLength(1);
    expect(fulfillment.events).toEqual(["claim:1001:3", "release:9001", "release:9001"]);
  });

  it("replays a prepared canonical stage without creating a second financial acceptance", async () => {
    const repository = new FakeAcceptanceRepository({}, true);
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await service.acceptOrder(validAcceptanceInput());

    expect(repository.preparationReplayObserved).toBe(true);
    expect(repository.events.filter((event) => event === "finalize")).toHaveLength(1);
    expect(fulfillment.events).toEqual(["claim:1001:3"]);
  });

  it("fails closed when WMS staging reports a warehouse other than the frozen quote warehouse", async () => {
    const repository = new FakeAcceptanceRepository();
    const fulfillment = new FakeCanonicalFulfillment(undefined, 4);
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_CANONICAL_WAREHOUSE_MISMATCH",
      context: { expectedWarehouseId: 3, stagedWarehouseId: 4 },
    });
    expect(repository.events).toEqual(["prepare"]);
    expect(fulfillment.events).toEqual(["claim:1001:3"]);
  });

  it("resumes durable compensation when release fails after the payment-hold intent commits", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-02T18:00:00.000Z"),
    });
    const releaseFailure = Object.assign(new Error("release unavailable"), { code: "RELEASE_UNAVAILABLE" });
    const fulfillment = new FakeCanonicalFulfillment(undefined, 3, [releaseFailure]);
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toBe(releaseFailure);
    const retry = await service.acceptOrder(validAcceptanceInput());

    expect(retry.outcome).toBe("payment_hold");
    expect(repository.events.filter((event) => event === "finalize")).toHaveLength(1);
    expect(repository.events.filter((event) => event.startsWith("mark_inventory_released"))).toHaveLength(1);
    expect(fulfillment.events).toEqual(["claim:1001:3", "release:9001", "release:9001"]);
  });

  it("repeats the idempotent physical release when durable completion fails after release", async () => {
    const repository = new FakeAcceptanceRepository({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-05-02T18:00:00.000Z"),
    }, false, 1);
    const fulfillment = new FakeCanonicalFulfillment();
    const service = makeAcceptanceService(repository, fulfillment, "canonical");

    await expect(service.acceptOrder(validAcceptanceInput())).rejects.toThrow("release marker unavailable");
    const retry = await service.acceptOrder(validAcceptanceInput());

    expect(retry.outcome).toBe("payment_hold");
    expect(repository.events.filter((event) => event === "finalize")).toHaveLength(1);
    expect(repository.events.filter((event) => event.startsWith("mark_inventory_released"))).toHaveLength(2);
    expect(fulfillment.events).toEqual(["claim:1001:3", "release:9001", "release:9001"]);
  });
});

describe("buildDropshipOrderAcceptancePlan", () => {
  it("holds an order for a vendor paused for funding whatever the balance, under the normal hold window", () => {
    const plan = buildDropshipOrderAcceptancePlan(makePlanningInput({
      vendor: { ...makePlanningInput().vendor, vendorStatus: "paused", vendorStandingReason: "card_declined" },
    }));

    expect(plan.outcome).toBe("payment_hold");
    expect(plan.paymentHoldReason).toBe("vendor_paused");
    expect(plan.paymentHoldExpiresAt?.toISOString()).toBe("2026-05-03T18:00:00.000Z");
    expect(plan.totalDebitCents).toBe(2722);
  });

  it("keeps an existing hold deadline for a paused vendor, and names the reason on every hold", () => {
    const existingExpiresAt = new Date("2026-05-01T20:00:00.000Z");
    const paused = buildDropshipOrderAcceptancePlan(makePlanningInput({
      intake: { ...makePlanningInput().intake, status: "processing", paymentHoldExpiresAt: existingExpiresAt },
      vendor: { ...makePlanningInput().vendor, vendorStatus: "paused", vendorStandingReason: "funding_returned" },
    }));
    expect(paused).toMatchObject({ outcome: "payment_hold", paymentHoldReason: "vendor_paused", paymentHoldExpiresAt: existingExpiresAt });

    const short = buildDropshipOrderAcceptancePlan(makePlanningInput({
      wallet: { walletAccountId: 1, availableBalanceCents: 100, pendingBalanceCents: 0, currency: "USD", advance: null },
    }));
    expect(short).toMatchObject({ outcome: "payment_hold", paymentHoldReason: "insufficient_balance" });
    expect(buildDropshipOrderAcceptancePlan(makePlanningInput())).toMatchObject({ outcome: "accepted", paymentHoldReason: null });
  });

  it("still blocks an operator pause and every other non-active vendor", () => {
    for (const vendor of [
      { vendorStatus: "paused", vendorStandingReason: "operator" },
      { vendorStatus: "paused", vendorStandingReason: null },
      { vendorStatus: "lapsed", vendorStandingReason: null },
    ]) {
      expectDropshipError(
        () => buildDropshipOrderAcceptancePlan(makePlanningInput({ vendor: { ...makePlanningInput().vendor, ...vendor } })),
        "DROPSHIP_ORDER_VENDOR_BLOCKED",
      );
    }
  });

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
        advance: null,
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
        advance: null,
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
        advance: null,
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
  legacyCalls = 0;
  events: string[] = [];
  preparationReplayObserved = false;
  claimAttempts = 0;
  acceptedFinalizations = 0;

  constructor(
    private readonly resultOverrides: Partial<DropshipOrderAcceptanceResult> = {},
    private readonly preparationReplay = false,
    private releaseMarkerFailuresRemaining = 0,
  ) {}

  private compensationState: "none" | "pending" | "released" = "none";
  private fundedRetry = false;
  private currentInventoryClaimId: string | null = null;

  fundWalletForRetry(): void {
    this.fundedRetry = true;
  }

  async acceptOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    this.lastInput = input;
    this.legacyCalls += 1;
    return this.result(input);
  }

  async prepareCanonicalOrder(input: DropshipOrderAcceptanceInput) {
    this.lastInput = input;
    this.events.push("prepare");
    this.preparationReplayObserved = this.preparationReplay;
    if (this.compensationState === "pending") {
      return {
        outcome: "compensation_required" as const,
        result: { ...this.result(input), idempotentReplay: true },
        omsOrderId: 1001,
        wmsOrderId: 9001,
        warehouseId: 3,
        inventoryClaimId: this.currentInventoryClaimId,
      };
    }
    if (this.compensationState === "released") {
      const held = this.result(input);
      if (held.paymentHoldExpiresAt && held.paymentHoldExpiresAt <= input.acceptedAt) {
        return {
          outcome: "compensation_required" as const,
          result: { ...held, idempotentReplay: true },
          omsOrderId: 1001,
          wmsOrderId: 9001,
          warehouseId: 3,
          inventoryClaimId: this.currentInventoryClaimId,
        };
      }
      if (!this.fundedRetry) {
        return { ...held, idempotentReplay: true };
      }
      this.compensationState = "none";
    }
    return {
      outcome: "prepared" as const,
      intakeId: input.intakeId,
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      shippingQuoteSnapshotId: input.shippingQuoteSnapshotId,
      warehouseId: 3,
      omsOrderId: 1001,
      idempotentReplay: this.preparationReplay,
    };
  }

  async markCanonicalInventoryClaimed(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
  }): Promise<void> {
    this.events.push(`mark_inventory_claimed:${input.omsOrderId}:${input.wmsOrderId}`);
    this.claimAttempts += 1;
    this.currentInventoryClaimId = input.inventoryClaimId;
  }

  async finalizeCanonicalOrder(input: DropshipOrderAcceptanceInput): Promise<DropshipOrderAcceptanceResult> {
    this.events.push("finalize");
    const result = this.result(input);
    this.compensationState = result.outcome === "payment_hold" ? "pending" : "none";
    if (result.outcome === "accepted") this.acceptedFinalizations += 1;
    return result;
  }

  async markCanonicalInventoryClaimReleased(input: {
    acceptance: DropshipOrderAcceptanceInput;
    omsOrderId: number;
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  }): Promise<void> {
    this.events.push(`mark_inventory_released:${input.omsOrderId}:${input.wmsOrderId}`);
    if (this.releaseMarkerFailuresRemaining > 0) {
      this.releaseMarkerFailuresRemaining -= 1;
      throw new Error("release marker unavailable");
    }
    this.compensationState = "released";
  }

  private result(input: DropshipOrderAcceptanceInput): DropshipOrderAcceptanceResult {
    const result: DropshipOrderAcceptanceResult = {
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
      paymentHoldReason: null,
      advance: null,
      idempotentReplay: false,
      ...this.resultOverrides,
    };
    if (this.fundedRetry && result.outcome === "payment_hold") {
      return {
        ...result,
        outcome: "accepted",
        paymentHoldExpiresAt: null,
      };
    }
    return result;
  }
}

class FakeInventoryAuthority implements DropshipInventoryRuntimeAuthorityGate {
  constructor(private readonly authority: DropshipInventoryRuntimeAuthority) {}

  async execute<T>(work: (authority: DropshipInventoryRuntimeAuthority) => Promise<T>): Promise<T> {
    return work(this.authority);
  }
}

class FakeCanonicalFulfillment implements DropshipCanonicalAcceptanceFulfillment {
  events: string[] = [];
  releasedClaimIds: Array<string | null> = [];
  private claimCount = 0;

  constructor(
    private readonly failure?: Error & { code?: string },
    private readonly stagedWarehouseId = 3,
    private readonly releaseFailures: Error[] = [],
  ) {}

  async stageOmsOrderAndClaimInventory(input: {
    omsOrderId: number;
    expectedWarehouseId: number;
  }): Promise<{ wmsOrderId: number; warehouseId: number; inventoryClaimId: string | null }> {
    this.events.push(`claim:${input.omsOrderId}:${input.expectedWarehouseId}`);
    if (this.failure) throw this.failure;
    this.claimCount += 1;
    return {
      wmsOrderId: 9001,
      warehouseId: this.stagedWarehouseId,
      inventoryClaimId: String(7000 + this.claimCount),
    };
  }

  async releaseStagedInventoryClaim(input: {
    wmsOrderId: number;
    inventoryClaimId: string | null;
    reason: string;
  }): Promise<void> {
    this.events.push(`release:${input.wmsOrderId}`);
    this.releasedClaimIds.push(input.inventoryClaimId);
    const failure = this.releaseFailures.shift();
    if (failure) throw failure;
  }
}

function makeAcceptanceService(
  repository: FakeAcceptanceRepository,
  canonicalFulfillment: FakeCanonicalFulfillment,
  authority: DropshipInventoryRuntimeAuthority,
): DropshipOrderAcceptanceService {
  return new DropshipOrderAcceptanceService({
    repository,
    inventoryAuthority: new FakeInventoryAuthority(authority),
    canonicalFulfillment,
    clock: { now: () => now },
    logger: noopLogger,
  });
}

function validAcceptanceInput() {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    shippingQuoteSnapshotId: 33,
    idempotencyKey: "accept-001",
    actor: { actorType: "system" as const },
  };
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
      vendorStandingReason: null,
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
      advance: null,
    },
    paymentHoldTimeoutMinutes: 2880,
    requestHash: "request-hash",
    idempotencyKey: "accept-001",
    acceptedAt: now,
    inventoryValidation: "legacy_exact_sku",
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
