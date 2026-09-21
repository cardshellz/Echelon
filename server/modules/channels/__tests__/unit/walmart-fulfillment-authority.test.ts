import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createFulfillmentPushService, type ChannelFulfillmentProviderCommandInput } from "../../../oms/fulfillment-push.service";

const command: ChannelFulfillmentProviderCommandInput = { commandId: 1, omsOrderId: 2, physicalShipmentId: 3, legacyWmsShipmentIds: [4],
  trackingNumber: "TRACK", carrier: "UPS", trackingUrl: null, shippedAt: new Date("2026-09-21T12:00:00Z"),
  items: [{ legacyWmsShipmentId: 4, legacyWmsShipmentItemId: 5, omsOrderLineId: 6, channelOrderLineId: "7", quantity: 1 }] };
function setup({ provider = "walmart", lineProvider = "walmart", revoked = false, quantity = 1 } = {}) {
  const dialect = new PgDialect();
  return createFulfillmentPushService({ execute: vi.fn(async (statement: SQL) => {
    const text = dialect.sqlToQuery(statement).sql;
    if (text.includes("FROM oms.oms_orders oms_order")) return { rows: [{ oms_order_id: 2, channel_id: 8, external_order_id: "PO-123", channel_provider: provider }] };
    if (text.includes("FROM wms.outbound_shipment_items shipment_item")) return { rows: [{ shipment_id: 4, shipment_item_id: 5, order_item_id: 9,
      oms_order_line_id: 6, oms_order_id: 2, fulfillment_provider: lineProvider, external_line_item_id: "7", qty: quantity }] };
    if (text.includes("FROM oms.channel_fulfillment_pushes AS push")) return { rows: [] };
    if (text.includes("SELECT line.id FROM oms.oms_order_lines line")) return { rows: revoked ? [{ id: 6 }] : [] };
    throw new Error("Unexpected authority query");
  }) }, null);
}
describe("Walmart canonical shipment authority", () => {
  it("resolves only the exact originating Walmart order", async () => {
    await expect(setup().prepareWalmartFulfillmentCommand(command)).resolves.toMatchObject({ channelId: 8, externalOrderId: "PO-123" });
  });
  it.each([{ provider: "ebay" }, { lineProvider: "shopify" }, { quantity: 2 }])("rejects mismatched persisted lineage %j", async options => {
    await expect(setup(options).prepareWalmartFulfillmentCommand(command)).rejects.toMatchObject({ code: "channel_fulfillment_lineage_mismatch" });
  });
  it("blocks revoked financial or label authority", async () => {
    await expect(setup({ revoked: true }).prepareWalmartFulfillmentCommand(command)).rejects.toMatchObject({ code: "WALMART_FULFILLMENT_REVOKED" });
  });
});
