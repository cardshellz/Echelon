import { describe, expect, it } from "vitest";
import type { ReturnPolicy } from "@shared/schema";
import { buildReturnPolicyArchivePreview } from "../../application/return-policy-archive";
import { normalizeReturnPolicyScope } from "../../domain/return-policy";

function policy(
  id: number,
  scope: Parameters<typeof normalizeReturnPolicyScope>[0],
): ReturnPolicy {
  return {
    id,
    name: `Policy ${id}`,
    ...normalizeReturnPolicyScope(scope),
    version: 1,
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
    createdBy: "admin",
    retiredBy: null,
    retiredAt: null,
    createdAt: new Date("2026-09-27T00:00:00Z"),
  };
}
const global = policy(1, {
  scopeKind: "global",
  businessContext: null,
  channelId: null,
  vendorId: null,
  storeConnectionId: null,
});
const retail = policy(2, {
  scopeKind: "business_context",
  businessContext: "retail",
  channelId: null,
  vendorId: null,
  storeConnectionId: null,
});
const shop = policy(3, {
  scopeKind: "channel_context",
  businessContext: "retail",
  channelId: 36,
  vendorId: null,
  storeConnectionId: null,
});
const vendor = policy(4, {
  scopeKind: "vendor_context",
  businessContext: "dropship",
  channelId: null,
  vendorId: 7,
  storeConnectionId: null,
});
const store = policy(5, {
  scopeKind: "store",
  businessContext: "dropship",
  channelId: 103,
  vendorId: 7,
  storeConnectionId: 11,
});
function preview(policies: ReturnPolicy[], id: number) {
  return buildReturnPolicyArchivePreview(
    { policies, historicalReferences: { returnCases: 3, portalIntakes: 1 } },
    id,
  );
}
describe("exact return policy archive impact", () => {
  it("shows channel fallback and preserves more-specific unaffected coverage when removing a broad policy", () => {
    const result = preview([global, retail, shop, vendor, store], 2);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      contextLabel: "Retail · Other channels (excluding 36)",
      after: { id: 1 },
    });
    expect(result.unaffectedMoreSpecificPolicies.map((row) => row.id)).toEqual([
      3,
    ]);
  });
  it("does not claim a global fallback applies to contexts still governed by more-specific policies", () => {
    const result = preview([global, retail, shop, vendor, store], 1);
    expect(
      result.effects.every(
        (effect) => effect.before.id === 1 && effect.after === null,
      ),
    ).toBe(true);
    expect(
      result.effects.every((effect) =>
        effect.contextLabel.startsWith("Dropship"),
      ),
    ).toBe(true);
    expect(result.unaffectedMoreSpecificPolicies.map((row) => row.id)).toEqual([
      2, 3, 4, 5,
    ]);
  });
  it("partitions vendor effects by exact channel/store and retains the store override", () => {
    const result = preview([global, vendor, store], 4);
    expect(result.effects).toHaveLength(2);
    expect(result.effects.every((effect) => effect.after?.id === 1)).toBe(true);
    expect(result.effects.map((effect) => effect.contextLabel)).toContain(
      "Dropship · Channel 103 · Vendor 7 · Other stores (excluding 11), including unassigned",
    );
    expect(result.unaffectedMoreSpecificPolicies.map((row) => row.id)).toEqual([
      5,
    ]);
  });
  it("shows explicit no-policy gaps and retains historical references", () => {
    const result = preview([shop], 3);
    expect(result.effects).toMatchObject([
      { contextLabel: "Retail · Channel 36", after: null },
    ]);
    expect(result.historicalReferences).toEqual({
      returnCases: 3,
      portalIntakes: 1,
    });
  });
  it("uses exact vendor/channel fallback while preserving its more-specific store override", () => {
    const channelVendor = policy(6, {
      scopeKind: "vendor_channel_context",
      businessContext: "dropship",
      channelId: 103,
      vendorId: 7,
      storeConnectionId: null,
    });
    const channel = policy(7, {
      scopeKind: "channel_context",
      businessContext: "dropship",
      channelId: 103,
      vendorId: null,
      storeConnectionId: null,
    });
    const result = preview([global, channel, vendor, channelVendor, store], 6);
    expect(result.effects).toMatchObject([
      {
        contextLabel:
          "Dropship · Channel 103 · Vendor 7 · Other stores (excluding 11), including unassigned",
        after: { id: 4 },
      },
    ]);
    expect(result.effects).toHaveLength(1);
    expect(result.unaffectedMoreSpecificPolicies.map((row) => row.id)).toEqual([
      5,
    ]);
    expect(
      preview([global, channel, channelVendor, store], 6).effects[0].after?.id,
    ).toBe(7);
  });
  it("is deterministic across database ordering and revises when fallback facts change", () => {
    expect(preview([global, shop], 3)).toEqual(preview([shop, global], 3));
    expect(
      preview([{ ...global, returnWindowDays: 60 }, shop], 3).revision,
    ).not.toBe(preview([global, shop], 3).revision);
  });
  it("rejects retired, ambiguous and invalid scope evidence", () => {
    expect(() => preview([{ ...shop, status: "retired" }], 3)).toThrow(
      "Only an active policy",
    );
    expect(() => preview([shop, { ...shop, id: 9 }], 3)).toThrow(
      "equal specificity",
    );
    expect(() => preview([{ ...shop, scopeKey: "global" }], 3)).toThrow(
      "scope could not be verified",
    );
  });
});
