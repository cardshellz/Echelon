import { describe, expect, it } from "vitest";
import {
  isSameReturnPolicyResolutionInput,
  snapshotReturnPolicyResolutionInput,
} from "../return-policy-resolution";

describe("return policy resolution input", () => {
  it("treats a store-scoped result as stale after vendor and store are cleared", () => {
    expect(isSameReturnPolicyResolutionInput(
      { channelId: 103, vendorId: 1, storeConnectionId: 1 },
      { channelId: 103, vendorId: null, storeConnectionId: null },
    )).toBe(false);
  });

  it("matches identical channel-only inputs", () => {
    expect(isSameReturnPolicyResolutionInput(
      { channelId: 103, vendorId: null, storeConnectionId: null },
      { channelId: 103, vendorId: null, storeConnectionId: null },
    )).toBe(true);
  });

  it("creates an immutable request snapshot", () => {
    const input = { channelId: 103, vendorId: 1, storeConnectionId: 1 };
    const snapshot = snapshotReturnPolicyResolutionInput(input);

    input.vendorId = null;
    input.storeConnectionId = null;

    expect(snapshot).toEqual({ channelId: 103, vendorId: 1, storeConnectionId: 1 });
  });
});
