import { describe, expect, it } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import {
  deriveManualReturnLifecycle,
  deriveShopifyRefundReturnLifecycle,
  ReturnCaseDomainError,
  snapshotReturnPolicy,
} from "../../domain/return-case";

function policy(overrides: Partial<ReturnPolicy> = {}): ReturnPolicy {
  return {
    id: 41,
    name: "Shopify retail returns",
    scopeKind: "channel_context",
    scopeKey: "context:retail:channel:36",
    businessContext: "retail",
    channelId: 36,
    vendorId: null,
    storeConnectionId: null,
    version: 3,
    status: "active",
    returnWindowDays: 30,
    returnDestination: "card_shellz",
    approvalAuthority: "card_shellz",
    labelProvider: "shipstation",
    returnShippingPayer: "customer",
    inspectionRequirement: "required",
    inspectionOwner: "card_shellz",
    customerRefundAuthority: "card_shellz",
    vendorSettlementTrigger: "none",
    returnlessRefundAllowed: false,
    notes: null,
    supersedesPolicyId: null,
    createdBy: "admin:test",
    retiredBy: null,
    retiredAt: null,
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

describe("Shopify refund Return Case lifecycle", () => {
  it("records completed customer refund while keeping physical return and inspection open", () => {
    expect(deriveShopifyRefundReturnLifecycle(policy())).toEqual({
      caseStatus: "open",
      approvalStatus: "approved",
      logisticsStatus: "awaiting_return",
      inspectionStatus: "pending",
      customerRefundStatus: "completed",
      vendorSettlementStatus: "not_applicable",
    });
  });

  it("skips inspection only when the winning policy explicitly requires none", () => {
    expect(deriveShopifyRefundReturnLifecycle(policy({ inspectionRequirement: "none" })))
      .toMatchObject({ inspectionStatus: "not_required" });
  });

  it("rejects an invalid policy identity", () => {
    expect(() => deriveShopifyRefundReturnLifecycle(policy({ id: 0 })))
      .toThrowError(expect.objectContaining({ code: "RETURN_CASE_POLICY_INVALID" }));
    expect(() => deriveShopifyRefundReturnLifecycle(policy({ version: 0 })))
      .toThrowError(ReturnCaseDomainError);
  });
});

describe("manual Return Case lifecycle", () => {
  it("keeps customer refund pending only when Card Shellz owns the retail customer", () => {
    expect(deriveManualReturnLifecycle(policy(), "retail")).toMatchObject({
      customerRefundStatus: "pending",
      vendorSettlementStatus: "not_applicable",
    });
  });

  it("uses vendor settlement rather than customer refund for dropship returns", () => {
    expect(deriveManualReturnLifecycle(policy({
      businessContext: "dropship",
      channelId: null,
      vendorId: 22,
      storeConnectionId: 9,
      customerRefundAuthority: "marketplace",
      vendorSettlementTrigger: "inspection_approved",
    }), "dropship")).toMatchObject({
      customerRefundStatus: "not_required",
      vendorSettlementStatus: "pending",
    });
  });

  it("does not create a vendor settlement obligation when the policy trigger is none", () => {
    expect(deriveManualReturnLifecycle(policy({
      businessContext: "dropship",
      channelId: null,
      vendorId: 22,
      storeConnectionId: 9,
      customerRefundAuthority: "marketplace",
      vendorSettlementTrigger: "none",
    }), "dropship")).toMatchObject({
      customerRefundStatus: "not_required",
      vendorSettlementStatus: "not_applicable",
    });
  });
});

describe("Return Case policy snapshot", () => {
  it("copies the exact operational decisions without mutable policy metadata", () => {
    const source = policy();
    const snapshot = snapshotReturnPolicy(source);

    expect(snapshot).toEqual({
      id: 41,
      name: "Shopify retail returns",
      version: 3,
      scopeKind: "channel_context",
      scopeKey: "context:retail:channel:36",
      returnWindowDays: 30,
      returnDestination: "card_shellz",
      approvalAuthority: "card_shellz",
      labelProvider: "shipstation",
      returnShippingPayer: "customer",
      inspectionRequirement: "required",
      inspectionOwner: "card_shellz",
      customerRefundAuthority: "card_shellz",
      vendorSettlementTrigger: "none",
      returnlessRefundAllowed: false,
    });
    expect(snapshot).not.toHaveProperty("notes");
    expect(snapshot).not.toHaveProperty("createdBy");
  });
});
