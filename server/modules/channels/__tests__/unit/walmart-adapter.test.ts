import { describe, expect, it, vi } from "vitest";
import { WalmartAdapter } from "../../adapters/walmart/walmart.adapter";
import { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { ChannelInventoryPublicationTransportAdapter } from "../../channel-inventory-publication-transport.adapter";
import { deriveChannelDestinations } from "../../../inventory-planning/domain/inventory-channel-exposure";
import type { InventoryPublicationSourceWarehouse } from "../../../inventory-planning/application/inventory-publication-supply-read.port";

function setup() {
  const api = { setInventory: vi.fn(), inventory: vi.fn(async () => 5) };
  const row = { connection_id: 2, ship_node_id: "NODE", environment: "production", channel_id: 1, warehouse_id: 4 };
  const service = { connection: vi.fn(async () => row), requireRuntime: vi.fn(), api: () => api,
    repository: { withLock: vi.fn(async (_id, action) => action()), assertWarehouse: vi.fn(),
      mappings: vi.fn(async () => [{ product_variant_id: 3, channel_sku: "SKU" }]) } };
  const supply = { getSourceWarehouses: vi.fn(async (): Promise<ReadonlyArray<InventoryPublicationSourceWarehouse>> => [{ warehouseId: 4, isActive: true }]) };
  const adapter = new WalmartAdapter(service as unknown as WalmartChannelService, supply);
  return { api, service, supply, adapter, transport: new ChannelInventoryPublicationTransportAdapter(adapter) };
}
describe("Walmart exact inventory destination", () => {
  const request = { channelId: 1, productVariantId: 3, externalSku: "SKU", externalInventoryItemId: "SKU", desiredQuantity: 0,
    destination: { kind: "channel_connection" as const, channelConnectionId: 2, dropshipStoreConnectionId: null }, providerScopeType: "location" as const, externalScopeId: "NODE" };
  it("works through the real canonical transport, including zero stock", async () => {
    const s = setup();
    expect((await s.transport.publishAbsolute(request)).publishedQuantity).toBe(0);
    expect(s.api.setInventory).toHaveBeenCalledWith("SKU", "NODE", 0);
    expect(s.supply.getSourceWarehouses).not.toHaveBeenCalled();
    await s.transport.publishAbsolute({ ...request, desiredQuantity: 5 });
    expect(s.supply.getSourceWarehouses).toHaveBeenCalledWith({ channelId: 1, channelConnectionId: 2, providerScopeType: "location", externalScopeId: "NODE" });
    expect(s.service.connection).toHaveBeenCalledWith(1, 2);
    expect((await s.transport.readAbsolute(request)).observedQuantity).toBe(5);
  });
  it("rejects arbitrary location and SKU substitutions before provider calls", async () => {
    const s = setup();
    await expect(s.transport.publishAbsolute({ ...request, externalScopeId: "WRONG" })).rejects.toMatchObject({ code: "WALMART_INVENTORY_SCOPE_MISMATCH" });
    await expect(s.transport.publishAbsolute({ ...request, externalInventoryItemId: "WRONG" })).rejects.toMatchObject({ code: "WALMART_INVENTORY_MAPPING_MISMATCH" });
    expect(s.api.setInventory).not.toHaveBeenCalled();
  });
  it("refuses legacy direct quantity writes", async () => {
    const s = setup();
    await expect(s.adapter.pushInventory(1, [])).rejects.toMatchObject({ code: "WALMART_PUBLICATION_AUTHORITY_REQUIRED" });
    expect(s.api.setInventory).not.toHaveBeenCalled();
  });
  it.each([
    [], [{ warehouseId: 5, isActive: true }], [{ warehouseId: null, isActive: true }],
    [{ warehouseId: 4, isActive: false }], [{ warehouseId: 4, isActive: true }, { warehouseId: 5, isActive: false }],
  ])("rejects incomplete or conflicting planning supply before publishing: %j", async (...sources) => {
    const s = setup();
    s.supply.getSourceWarehouses.mockResolvedValue(sources);
    await expect(s.transport.publishAbsolute({ ...request, desiredQuantity: 5 })).rejects.toMatchObject({ code: "WALMART_INVENTORY_SUPPLY_MISMATCH" });
    expect(s.api.setInventory).not.toHaveBeenCalled();
    // A conservative zero does not depend on an active stock source.
    await expect(s.transport.publishAbsolute(request)).resolves.toMatchObject({ publishedQuantity: 0 });
  });
  it("derives the verified Walmart node without borrowing a Shopify location", () => {
    const base = { id: 2, provider: "walmart", shopifyLocationId: "UNRELATED", verifiedAccountId: null, label: "Walmart" };
    const result = deriveChannelDestinations({ connections: [{ ...base, providerLocationId: "NODE" }], dropshipStores: [], registered: [] });
    expect(result.create[0]).toMatchObject({ providerScopeType: "location", externalScopeId: "NODE" });
    expect(deriveChannelDestinations({ connections: [base], dropshipStores: [], registered: [] }).skipped[0].reason).toBe("no_provider_location");
  });
});

describe("Walmart production activation boundary", () => {
  it("blocks production without the runtime opt-in and sandbox on a production server", () => {
    const service = new WalmartChannelService({} as never, null, { liveEnabled: false, productionServer: true });
    expect(() => service.requireRuntime({ environment: "production" } as never)).toThrow(/not been enabled/);
    expect(() => service.requireRuntime({ environment: "sandbox" } as never)).toThrow(/production warehouse/);
  });
  it("requires a credential vault before verification sends anything", async () => {
    const createApi = vi.fn();
    const service = new WalmartChannelService({} as never, null, { liveEnabled: false, productionServer: false }, () => new Date(), createApi);
    await expect(service.preview({ clientId: "client", clientSecret: "secret", environment: "production" })).rejects.toMatchObject({ code: "WALMART_VAULT_UNCONFIGURED" });
    expect(createApi).not.toHaveBeenCalled();
  });
});
