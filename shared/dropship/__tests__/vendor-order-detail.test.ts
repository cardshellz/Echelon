import { describe, expect, it } from "vitest";
import { pickVendorOrderAuditPayload, VENDOR_ORDER_AUDIT_PAYLOAD_KEYS } from "../vendor-order-detail";

describe("pickVendorOrderAuditPayload", () => {
  it("keeps the listed keys with plain values and drops everything else", () => {
    expect(pickVendorOrderAuditPayload({
      errorCode: "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
      availableBalanceCents: 0,
      paymentHoldExpiresAt: null,
      requestHash: "sha256:abc",
      shortfall: { cents: 900 },
    })).toEqual({
      errorCode: "DROPSHIP_WALLET_INSUFFICIENT_FUNDS",
      availableBalanceCents: 0,
      paymentHoldExpiresAt: null,
    });
  });

  it("drops a listed key whose value is an object, an array or not a finite number", () => {
    expect(pickVendorOrderAuditPayload({
      reason: { detail: "x" },
      errorMessage: ["a"],
      totalDebitCents: Number.NaN,
      omsOrderId: Number.POSITIVE_INFINITY,
    })).toEqual({});
  });

  it("yields an empty payload for anything that is not an object", () => {
    for (const payload of [null, undefined, "text", 7, ["errorCode"]]) {
      expect(pickVendorOrderAuditPayload(payload)).toEqual({});
    }
  });

  it("ignores inherited keys", () => {
    const payload = Object.create({ errorCode: "INHERITED" }) as Record<string, unknown>;
    payload.reason = "own";

    expect(pickVendorOrderAuditPayload(payload)).toEqual({ reason: "own" });
  });

  it("lists exactly the keys the vendor order page showed before the contract", () => {
    expect([...VENDOR_ORDER_AUDIT_PAYLOAD_KEYS]).toEqual([
      "errorCode",
      "errorMessage",
      "reason",
      "shippingQuoteSnapshotId",
      "omsOrderId",
      "walletLedgerEntryId",
      "totalDebitCents",
      "availableBalanceCents",
      "paymentHoldExpiresAt",
    ]);
    expect(Object.isFrozen(VENDOR_ORDER_AUDIT_PAYLOAD_KEYS)).toBe(true);
  });
});
