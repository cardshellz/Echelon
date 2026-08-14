import { describe, expect, it } from "vitest";
import {
  deriveReturnPolicyResolutionInput,
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

  it("clears a stale store when the visible store selection is cleared", () => {
    expect(deriveReturnPolicyResolutionInput({
      channelId: 103,
      dropshipOmsChannelId: 103,
      selectedVendorId: 1,
      selectedStoreConnectionId: null,
    })).toEqual({ channelId: 103, vendorId: 1, storeConnectionId: null });
  });

  it("clears the store when the visible vendor selection is cleared", () => {
    expect(deriveReturnPolicyResolutionInput({
      channelId: 103,
      dropshipOmsChannelId: 103,
      selectedVendorId: null,
      selectedStoreConnectionId: 1,
    })).toEqual({ channelId: 103, vendorId: null, storeConnectionId: null });
  });

  it("removes dropship selections for a non-dropship channel", () => {
    expect(deriveReturnPolicyResolutionInput({
      channelId: 36,
      dropshipOmsChannelId: 103,
      selectedVendorId: 1,
      selectedStoreConnectionId: 1,
    })).toEqual({ channelId: 36, vendorId: null, storeConnectionId: null });
  });

  it("creates an immutable request snapshot", () => {
    const input = { channelId: 103, vendorId: 1, storeConnectionId: 1 };
    const snapshot = snapshotReturnPolicyResolutionInput(input);

    input.vendorId = null;
    input.storeConnectionId = null;

    expect(snapshot).toEqual({ channelId: 103, vendorId: 1, storeConnectionId: 1 });
  });
});
