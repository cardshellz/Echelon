import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as dropshipApplication from "../../application";
import {
  creditWalletFundingInputSchema,
  generateVendorListingPreviewInputSchema,
  notifyExpiringPaymentHoldsInputSchema,
  processMarketplaceOrderCancellationsInputSchema,
  pushTrackingToVendorStoreInputSchema,
  recordMarketplaceOrderIntakeInputSchema,
  rejectDropshipOrderInputSchema,
} from "../../application/dropship-use-case-dtos";

describe("COM-07: Dropship use-case registry retirement & live DTO contracts", () => {
  it("retires the unreferenced dropship-use-cases.ts registry while preserving live use-case DTOs", () => {
    const retiredFile = path.resolve(
      __dirname,
      "../../application/dropship-use-cases.ts",
    );
    expect(fs.existsSync(retiredFile)).toBe(false);
    expect("createDropshipUseCaseRegistry" in dropshipApplication).toBe(false);
    expect("dropshipUseCaseDescriptors" in dropshipApplication).toBe(false);
  });

  it("rejects raw ATP leakage on listing preview input", () => {
    const result = generateVendorListingPreviewInputSchema.safeParse({
      vendorId: 1,
      storeConnectionId: 2,
      productVariantIds: [3],
      actor: { actorType: "vendor", actorId: "member-1" },
      rawAtpUnits: 500,
    });
    expect(result.success).toBe(false);
  });

  it("rejects fractional money and missing idempotency on wallet funding", () => {
    expect(
      creditWalletFundingInputSchema.safeParse({
        vendorId: 1,
        walletAccountId: 2,
        amountCents: 10.5,
        referenceType: "stripe_payment_intent",
        referenceId: "pi_123",
        idempotencyKey: "funding-123",
      }).success,
    ).toBe(false);

    expect(
      creditWalletFundingInputSchema.safeParse({
        vendorId: 1,
        walletAccountId: 2,
        amountCents: 1050,
        referenceType: "stripe_payment_intent",
        referenceId: "pi_123",
      }).success,
    ).toBe(false);
  });

  it("requires explicit Date timestamps for tracking pushes", () => {
    expect(
      pushTrackingToVendorStoreInputSchema.safeParse({
        vendorId: 1,
        storeConnectionId: 2,
        intakeId: 3,
        carrier: "usps",
        trackingNumber: "9400",
        shippedAt: "2026-04-29T00:00:00.000Z",
        idempotencyKey: "tracking-123",
      }).success,
    ).toBe(false);

    expect(
      pushTrackingToVendorStoreInputSchema.safeParse({
        vendorId: 1,
        storeConnectionId: 2,
        intakeId: 3,
        carrier: "usps",
        trackingNumber: "9400",
        shippedAt: new Date("2026-04-29T00:00:00.000Z"),
        idempotencyKey: "tracking-123",
      }).success,
    ).toBe(true);
  });

  it("validates marketplace intake idempotency coordinates", () => {
    const parsed = recordMarketplaceOrderIntakeInputSchema.parse({
      vendorId: 1,
      storeConnectionId: 2,
      platform: "ebay",
      externalOrderId: "ORDER-1",
      rawPayload: { orderId: "ORDER-1" },
      payloadHash: "0123456789abcdef",
      idempotencyKey: "intake-ORDER-1",
    });

    expect(parsed.storeConnectionId).toBe(2);
    expect(parsed.externalOrderId).toBe("ORDER-1");
  });

  it("validates order exception worker bounds", () => {
    expect(
      rejectDropshipOrderInputSchema.safeParse({
        intakeId: 1,
        vendorId: 1,
        reason: "no",
        idempotencyKey: "reject-order-123",
        actor: { actorType: "vendor", actorId: "member-1" },
      }).success,
    ).toBe(false);

    expect(
      processMarketplaceOrderCancellationsInputSchema.safeParse({
        workerId: "worker-1",
        limit: 501,
      }).success,
    ).toBe(false);

    expect(
      notifyExpiringPaymentHoldsInputSchema.safeParse({
        workerId: "worker-1",
        warningWindowMinutes: 60 * 24 * 8,
      }).success,
    ).toBe(false);
  });
});
