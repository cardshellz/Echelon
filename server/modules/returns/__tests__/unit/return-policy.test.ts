import { describe, expect, it } from "vitest";
import {
  normalizeReturnPolicyScope,
  resolveReturnPolicy,
  ReturnPolicyDomainError,
  type ReturnPolicyCandidate,
} from "../../domain/return-policy";

function candidate(overrides: Partial<ReturnPolicyCandidate> & Pick<ReturnPolicyCandidate, "id" | "scopeKind">): ReturnPolicyCandidate {
  return {
    id: overrides.id,
    name: overrides.name ?? `Policy ${overrides.id}`,
    version: overrides.version ?? 1,
    status: overrides.status ?? "active",
    scopeKind: overrides.scopeKind,
    businessContext: overrides.businessContext ?? null,
    channelId: overrides.channelId ?? null,
    vendorId: overrides.vendorId ?? null,
    storeConnectionId: overrides.storeConnectionId ?? null,
  };
}

describe("return policy scope normalization", () => {
  it.each([
    [{ scopeKind: "global", businessContext: null, channelId: null, vendorId: null, storeConnectionId: null }, "global"],
    [{ scopeKind: "business_context", businessContext: "retail", channelId: null, vendorId: null, storeConnectionId: null }, "context:retail"],
    [{ scopeKind: "channel_context", businessContext: "retail", channelId: 36, vendorId: null, storeConnectionId: null }, "context:retail:channel:36"],
    [{ scopeKind: "vendor_context", businessContext: "dropship", channelId: null, vendorId: 7, storeConnectionId: null }, "context:dropship:vendor:7"],
    [{ scopeKind: "vendor_channel_context", businessContext: "dropship", channelId: 67, vendorId: 7, storeConnectionId: null }, "context:dropship:vendor:7:channel:67"],
    [{ scopeKind: "store", businessContext: "dropship", channelId: 67, vendorId: 7, storeConnectionId: 11 }, "context:dropship:vendor:7:channel:67:store:11"],
  ] as const)("normalizes %s", (input, scopeKey) => {
    expect(normalizeReturnPolicyScope(input)).toMatchObject({ scopeKey });
  });

  it("rejects vendor scopes outside dropship", () => {
    expect(() => normalizeReturnPolicyScope({
      scopeKind: "vendor_context",
      businessContext: "retail",
      channelId: null,
      vendorId: 7,
      storeConnectionId: null,
    })).toThrowError(ReturnPolicyDomainError);
  });
});

describe("return policy resolution", () => {
  const stack = [
    candidate({ id: 1, scopeKind: "global" }),
    candidate({ id: 2, scopeKind: "business_context", businessContext: "dropship" }),
    candidate({ id: 3, scopeKind: "channel_context", businessContext: "dropship", channelId: 67 }),
    candidate({ id: 4, scopeKind: "vendor_context", businessContext: "dropship", vendorId: 7 }),
    candidate({ id: 5, scopeKind: "vendor_channel_context", businessContext: "dropship", channelId: 67, vendorId: 7 }),
    candidate({ id: 6, scopeKind: "store", businessContext: "dropship", channelId: 67, vendorId: 7, storeConnectionId: 11 }),
  ];

  it("returns the complete matching stack with the most specific policy first", () => {
    const result = resolveReturnPolicy(stack, {
      businessContext: "dropship",
      channelId: 67,
      vendorId: 7,
      storeConnectionId: 11,
    });

    expect(result?.winner.id).toBe(6);
    expect(result?.matched.map(({ policy, rank }) => [policy.id, rank])).toEqual([
      [6, 600], [5, 500], [4, 400], [3, 300], [2, 200], [1, 100],
    ]);
  });

  it("does not match inactive or dimensionally different policies", () => {
    const result = resolveReturnPolicy([
      candidate({ id: 1, scopeKind: "global" }),
      candidate({ id: 2, scopeKind: "channel_context", businessContext: "retail", channelId: 36, status: "retired" }),
      candidate({ id: 3, scopeKind: "channel_context", businessContext: "retail", channelId: 67 }),
    ], { businessContext: "retail", channelId: 36, vendorId: null, storeConnectionId: null });

    expect(result?.winner.id).toBe(1);
    expect(result?.matched).toHaveLength(1);
  });

  it("rejects equal-specificity ambiguity instead of silently choosing", () => {
    const duplicates = [
      candidate({ id: 10, scopeKind: "channel_context", businessContext: "retail", channelId: 36 }),
      candidate({ id: 11, scopeKind: "channel_context", businessContext: "retail", channelId: 36 }),
    ];
    expect(() => resolveReturnPolicy(duplicates, {
      businessContext: "retail",
      channelId: 36,
      vendorId: null,
      storeConnectionId: null,
    })).toThrowError(expect.objectContaining({ code: "RETURN_POLICY_AMBIGUOUS" }));
  });
});
