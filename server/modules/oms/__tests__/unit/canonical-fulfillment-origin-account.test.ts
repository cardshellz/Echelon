import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createFulfillmentPushService, type ChannelFulfillmentProviderCommandInput } from "../../fulfillment-push.service";
import { ChannelFulfillmentProviderError } from "../../../channels/channel-fulfillment-provider.error";
import type { ChannelFulfillmentProviderClients } from "../../../channels/channel-fulfillment-provider-clients.service";

const dialect = new PgDialect();
function command(id = 1): ChannelFulfillmentProviderCommandInput {
  return { commandId: id, omsOrderId: id, physicalShipmentId: id + 400,
    legacyWmsShipmentIds: [id + 100], trackingNumber: `TRACK${id}`, carrier: "UPS", trackingUrl: null,
    shippedAt: new Date("2026-09-01T12:00:00Z"), items: [{ legacyWmsShipmentId: id + 100,
      legacyWmsShipmentItemId: id + 200, omsOrderLineId: id + 500, channelOrderLineId: "601", quantity: 2 }] };
}

function database(options: { provider?: string; channelMismatch?: boolean; externalMismatch?: boolean; missingOrder?: boolean; cancelledLine?: boolean; warehouseLocation?: string | null; storedPathA?: boolean } = {}) {
  const events: unknown[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    const id = Number(params[0]) % 100;
    const provider = options.provider ?? "shopify";
    if (/^\s*(INSERT|UPDATE)/.test(text)) { events.push({ text, params }); return { rows: [], rowCount: 1 }; }
    if (text.includes("FROM oms.oms_orders oms_order")) return { rows: options.missingOrder ? [] : [{ oms_order_id: id,
      channel_id: id + 10, external_order_id: "10001", channel_provider: provider,
      ordered_at: "2026-08-01T12:00:00Z", oms_created_at: "2026-08-01T12:00:00Z" }] };
    if (text.includes("SUM(item.quantity_pushed)")) return { rows: [] };
    if (text.includes("AS fulfillment_order_line_item_id")) return { rows: options.storedPathA ? [{ shipment_item_id: id + 200,
      quantity: 2, oms_order_line_id: id + 500, fulfillment_order_id: `gid://shopify/FulfillmentOrder/${id}`,
      fulfillment_order_line_item_id: `gid://shopify/FulfillmentOrderLineItem/${id}` }] : [] };
    if (text.includes("FROM wms.outbound_shipment_items")) return { rows: options.cancelledLine ? [] : [{ shipment_id: id + 100,
      shipment_item_id: id + 200, order_item_id: id + 700, oms_order_line_id: id + 500, oms_order_id: id,
      external_line_item_id: "601", fulfillment_provider: provider, sku: "NOT-AN-IDENTITY", qty: 2 }] };
    if (text.includes("FROM wms.outbound_shipments")) return { rows: [{ id: id + 100, order_id: id + 300,
      channel_id: id + 10, status: "labeled", shopify_fulfillment_id: null }] };
    if (text.includes("FROM wms.orders w")) return { rows: [{ id: id + 300, channel_id: options.channelMismatch ? 99 : id + 10,
      source: "shopify", external_order_id: options.externalMismatch ? "20002" : "gid://shopify/Order/10001",
      oms_fulfillment_order_id: String(id), ship_from_location_id: options.warehouseLocation === undefined ? String(id + 10) : options.warehouseLocation }] };
    if (text.includes("SELECT provider FROM channels.channels")) return { rows: [{ provider }] };
    throw new Error(`Unexpected database query: ${text}`);
  });
  return { execute, insert: vi.fn(() => ({ values: vi.fn(async (event: unknown) => { events.push(event); }) })), events };
}

function shopifyAccount(channelId: number, settings: { existing?: boolean; error?: Error; afterRead?: () => Promise<void> } = {}) {
  const id = channelId - 10;
  const client = { request: vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    expect(variables?.id ?? "gid://shopify/Order/10001").toBe("gid://shopify/Order/10001");
    if (settings.error) throw settings.error;
    if (query.includes("exactFulfillmentPackageForOrder")) {
      await settings.afterRead?.();
      return { order: { fulfillmentsCount: { count: settings.existing ? 1 : 0 }, fulfillments: settings.existing ? [{
        id: `gid://shopify/Fulfillment/${id}`, status: "SUCCESS", trackingInfo: [{ number: `TRACK${id}` }],
        fulfillmentLineItems: { nodes: [{ quantity: 2, lineItem: { id: "gid://shopify/LineItem/601" } }], pageInfo: { hasNextPage: false } },
      }] : [] } };
    }
    if (query.includes("fulfillmentCreateV2")) return { fulfillmentCreateV2: { fulfillment: { id: `gid://shopify/Fulfillment/${id}` }, userErrors: [] } };
    return { order: { fulfillmentOrders: { edges: [{ node: { id: `gid://shopify/FulfillmentOrder/${id}`,
      status: "OPEN", assignedLocation: { location: { id: `gid://shopify/Location/${channelId}` } },
      lineItems: { edges: [{ node: { id: `gid://shopify/FulfillmentOrderLineItem/${id}`, sku: "NOT-AN-IDENTITY",
        lineItem: { id: "gid://shopify/LineItem/601" }, remainingQuantity: 2 } }] } } }] } } };
  }) };
  return { channelId, connectionId: channelId + 1000, externalAccountId: `store-${channelId}.myshopify.com`, client };
}

describe("canonical fulfillment originating account", () => {
  it("uses separate request-local stores for simultaneous orders with the same external order ID", async () => {
    const db = database();
    const first = shopifyAccount(11);
    const second = shopifyAccount(12);
    const providers = { shopify: vi.fn(async (channelId: number) => channelId === 11 ? first : second), ebay: vi.fn() };
    const legacy = { request: vi.fn(async () => { throw new Error("Legacy client must not execute"); }) };
    const service = createFulfillmentPushService(db, null, { providerClients: providers });
    service.setShopifyClient(legacy);
    const results = await Promise.all([service.pushShopifyFulfillmentForCommand(command(1)), service.pushShopifyFulfillmentForCommand(command(2))]);
    expect(results.map((result) => result.shopifyFulfillmentId)).toEqual(["gid://shopify/Fulfillment/1", "gid://shopify/Fulfillment/2"]);
    expect(providers.shopify.mock.calls).toEqual([[11], [12]]);
    for (const account of [first, second]) {
      const mutation = account.client.request.mock.calls.find(([query]) => query.includes("fulfillmentCreateV2"));
      expect(mutation?.[1]).toMatchObject({ fulfillment: { lineItemsByFulfillmentOrder: [{
        fulfillmentOrderId: `gid://shopify/FulfillmentOrder/${account.channelId - 10}`,
        fulfillmentOrderLineItems: [{ quantity: 2 }],
      }] } });
    }
    expect(legacy.request).not.toHaveBeenCalled();
  });

  it("reconciles an existing exact package through its originating client without a second mutation", async () => {
    const account = shopifyAccount(11, { existing: true });
    const service = createFulfillmentPushService(database(), null, { providerClients: { shopify: async () => account, ebay: vi.fn() } });
    await expect(service.pushShopifyFulfillmentForCommand(command())).resolves.toMatchObject({ alreadyPushed: true, writebackComplete: true });
    expect(account.client.request).toHaveBeenCalledTimes(1);
  });

  it.each([{ channelMismatch: true }, { externalMismatch: true }, { cancelledLine: true }, { missingOrder: true }, { provider: "ebay" }])("rejects invalid OMS/WMS command lineage before provider I/O: %j", async (options) => {
    const account = shopifyAccount(11);
    const db = database(options);
    const service = createFulfillmentPushService(db, null, { providerClients: { shopify: async () => account, ebay: vi.fn() } });
    await expect(service.pushShopifyFulfillmentForCommand(command())).rejects.toMatchObject({ code: "channel_fulfillment_lineage_mismatch" });
    expect(account.client.request).not.toHaveBeenCalled();
    expect(db.events).toEqual([]);
  });

  it("never falls back to a configured singleton when canonical account resolution is missing", async () => {
    const account = shopifyAccount(11);
    const service = createFulfillmentPushService(database(), null);
    service.setShopifyClient(account.client);
    await expect(service.pushShopifyFulfillmentForCommand(command())).rejects.toMatchObject({ code: "FULFILLMENT_ACCOUNT_RESOLVER_UNAVAILABLE" });
    expect(account.client.request).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a foreign warehouse location on both live and stored-FO paths (stored=%s)", async (storedPathA) => {
    const account = shopifyAccount(11);
    const service = createFulfillmentPushService(database({ warehouseLocation: "999999", storedPathA }), null,
      { providerClients: { shopify: async () => account, ebay: vi.fn() } });
    await expect(service.pushShopifyFulfillmentForCommand(command())).rejects.toMatchObject({ code: "SHOPIFY_FULFILLMENT_LOCATION_MISMATCH", failureClass: "permanent" });
    expect(account.client.request.mock.calls.some(([query]) => query.includes("fulfillmentCreateV2"))).toBe(false);
  });

  it("does not substitute the connection primary location for a missing warehouse mapping", async () => {
    const account = shopifyAccount(11);
    const service = createFulfillmentPushService(database({ warehouseLocation: null }), null,
      { providerClients: { shopify: async () => account, ebay: vi.fn() } });
    await expect(service.pushShopifyFulfillmentForCommand(command())).rejects.toMatchObject({ code: "SHOPIFY_FULFILLMENT_LOCATION_UNRESOLVED" });
    expect(account.client.request).not.toHaveBeenCalled();
  });

  it("preserves permanent account failure classification through exact-package readback", async () => {
    const error = new ChannelFulfillmentProviderError("ACCOUNT_REJECTED", "Account rejected");
    const account = shopifyAccount(11, { error });
    const service = createFulfillmentPushService(database(), null, { providerClients: { shopify: async () => account, ebay: vi.fn() } });
    await expect(service.pushShopifyFulfillmentForCommand(command())).rejects.toBe(error);
  });

  it("uses the OMS eBay channel instead of the injected legacy account and records exact account evidence", async () => {
    const legacy = { createShippingFulfillment: vi.fn() };
    const client = { createShippingFulfillment: vi.fn().mockResolvedValue({ fulfillmentId: "verified" }) };
    const providers: ChannelFulfillmentProviderClients = { shopify: vi.fn(), ebay: vi.fn(async (channelId) => ({ channelId, externalAccountId: "seller-11", client })) };
    const db = database({ provider: "ebay" });
    const service = createFulfillmentPushService(db, legacy as never, { providerClients: providers });
    await expect(service.pushTrackingForShipmentCommand(command())).resolves.toBe(true);
    expect(providers.ebay).toHaveBeenCalledWith(11);
    expect(client.createShippingFulfillment).toHaveBeenCalledWith("10001", expect.objectContaining({ lineItems: [{ lineItemId: "601", quantity: 2 }] }));
    expect(legacy.createShippingFulfillment).not.toHaveBeenCalled();
    expect(db.events).toContainEqual(expect.objectContaining({ details: expect.objectContaining({ channelId: 11, externalAccountId: "seller-11" }) }));
  });
});
