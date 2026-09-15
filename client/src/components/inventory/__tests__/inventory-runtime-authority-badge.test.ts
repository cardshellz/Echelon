import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH } from "@shared/types/inventory-runtime-authority";
import { describeInventoryRuntimeAuthority } from "../InventoryRuntimeAuthorityBadge";

const legacy = {
  contractVersion: "inventory_runtime_authority_readout_v1" as const,
  authority: "legacy" as const,
  liveAllocator: "channel_allocation_rules" as const,
  revision: "1",
  activationRunId: null,
  changedBy: "migration-0638",
  changeReason: "Initialize inactive inventory availability cutover authority.",
  changedAt: "2026-09-12T14:00:00.000Z",
};

describe("InventoryRuntimeAuthorityBadge contract", () => {
  it("names the allocator the server reported and carries full provenance in the detail", () => {
    expect(describeInventoryRuntimeAuthority(legacy)).toEqual({
      label: "Live allocator: Channel Allocation rules",
      detail: "legacy authority, revision 1, set by migration-0638 at 2026-09-12T14:00:00.000Z:"
        + " Initialize inactive inventory availability cutover authority.",
    });
    expect(describeInventoryRuntimeAuthority({
      ...legacy, authority: "canonical", liveAllocator: "inventory_exposure", revision: "7", activationRunId: "42",
    }).label).toBe("Live allocator: Channel Inventory");
  });

  it("reads the shared readout path and never renders an assumed authority while pending or failed", () => {
    const source = readFileSync("client/src/components/inventory/InventoryRuntimeAuthorityBadge.tsx", "utf8");
    expect(source).toContain("INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH");
    expect(INVENTORY_RUNTIME_AUTHORITY_READOUT_PATH).toBe("/api/inventory-planning/runtime-authority");
    expect(source).toContain("inventoryRuntimeAuthorityReadoutSchema.parse(body)");
    expect(source).toContain("Reading live allocator…");
    expect(source).toContain("Live allocator unknown");
    expect(source).not.toMatch(/Legacy runtime retained/);
  });

  it("gates legacy allocation and reserve controls with the same runtime readout", () => {
    const channelInventory = readFileSync("client/src/features/channel-inventory/ChannelInventoryPage.tsx", "utf8");
    const allocation = readFileSync("client/src/pages/ChannelAllocation.tsx", "utf8");
    const reserves = readFileSync("client/src/pages/Reserves.tsx", "utf8");
    expect(channelInventory).toContain("<InventoryRuntimeAuthorityBadge />");
    expect(channelInventory).not.toContain("Legacy runtime retained");
    expect(allocation).toContain("<InventoryRuntimeAuthorityBadge />");
    expect(allocation).toContain("useInventoryRuntimeAuthority()");
    expect(allocation).toContain("Legacy Channel Allocation is retired");
    expect(allocation).toContain('href="/channels/inventory"');
    expect(allocation).toContain("only while the live allocator is Channel Allocation rules");
    expect(reserves).toContain("useInventoryRuntimeAuthority()");
    expect(reserves).toContain("Legacy channel reserves are retired");
    expect(reserves).toContain("enabled: canView && legacyAuthority");
    expect(reserves).toContain('href="/channels/inventory"');
  });

  it("retires legacy publication controls on every operator page and keeps the canonical global stop", () => {
    const channels = readFileSync("client/src/pages/Channels.tsx", "utf8");
    const warehouse = readFileSync("client/src/pages/WarehouseSettingsPage.tsx", "utf8");
    const product = readFileSync("client/src/pages/ProductDetail.tsx", "utf8");
    const shopify = readFileSync("client/src/pages/ShopifyChannelPage.tsx", "utf8");
    const warehouses = readFileSync("client/src/pages/Warehouses.tsx", "utf8");
    const channelInventory = readFileSync("client/src/features/channel-inventory/ChannelInventoryPage.tsx", "utf8");
    for (const source of [channels, warehouse, product, shopify, warehouses]) {
      expect(source).toContain("useInventoryRuntimeAuthority()");
      expect(source).toContain("InventoryRuntimeAuthorityBadge");
    }
    expect(shopify).toContain("isConfirmedLegacyInventoryAuthority");
    expect(shopify).toContain("JSON.stringify({ channelId: shopifyChannel.id })");
    expect(warehouses).toContain('runtimeAuthority !== "legacy"');
    expect(warehouses).toContain("Channel Inventory");
    expect(warehouses).toContain("Authority unknown");
    expect(channelInventory).toContain("<GlobalPublishingControl canActivate={canActivate}");
    expect(channelInventory).not.toContain("SyncControlPanel");
  });
});
