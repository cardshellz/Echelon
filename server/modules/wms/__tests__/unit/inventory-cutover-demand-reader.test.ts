import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readWmsCutoverDemand, WMS_CUTOVER_CAPTURE_LIMITS } from "../../inventory-cutover-demand-reader";

const TIME = "2026-09-07T12:00:00.000Z";
function fixture() {
  const meta = { capturedAt: new Date(TIME), isolation: "repeatable read", readOnly: "on", excludedTerminalOrderCount: "17" };
  const orders = [{ id: 70, warehouseId: 1, status: "in_progress", onHold: 0, channelId: 36,
    source: "shopify", externalOrderId: "external-70", omsFulfillmentOrderId: "fulfillment-70", fulfillmentPartitionKey: "default" }];
  const items = [{ id: 71, orderId: 70, omsOrderLineId: "9007199254740993", sourceItemId: "line-71", sku: "P5", productId: 5,
    quantity: 4, pickedQuantity: 2, fulfilledQuantity: 1, status: "in_progress", onHold: false, requiresShipping: 1,
    location: "PICK-A", shortReason: null }];
  const sourceItems = [{ id: 101, shipmentId: 90, headerOrderId: 70, orderItemId: 71, replacementForOrderItemId: null,
    correctionForShipmentItemId: null, productVariantId: 105, quantity: 4, purpose: "customer_fulfillment",
    fromLocationId: 50, shipmentStatus: "queued", shipmentHeld: false }];
  const physicalItems = [{ id: "9007199254740994", physicalShipmentId: "9007199254740995", orderItemId: 71,
    replacementForOrderItemId: null, legacySourceShipmentItemId: 101, packageAllocationEntryId: null, productVariantId: 105,
    sku: "P5", originalQuantity: 2, adjustmentQuantity: -1, effectiveQuantity: "1", purpose: "customer_fulfillment", packageStatus: "shipped" }];
  const allRows: unknown[][] = [[meta], orders, items, sourceItems, physicalItems];
  let index = 0;
  const query = vi.fn(async (_statement: string, _params?: unknown[]) => ({ rows: allRows[index++]!, rowCount: 1 }));
  const client = { query } as unknown as PoolClient;
  return { meta, orders, items, sourceItems, physicalItems, allRows, query, client };
}

describe("readWmsCutoverDemand", () => {
  it("captures separate progress and shipment facts on one supplied read-only snapshot without deriving custody", async () => {
    const f = fixture(); const capture = await readWmsCutoverDemand(f.client);
    expect(capture).toEqual({ schemaVersion: "wms_inventory_cutover_demand_v1", scope: "nonterminal_wms_orders",
      capturedAt: TIME, excludedTerminalOrderCount: "17", orders: f.orders, items: f.items,
      sourceItems: f.sourceItems, physicalItems: f.physicalItems });
    expect(capture.items[0]).not.toHaveProperty("custodyQuantity");
    expect(capture.items[0].omsOrderLineId).toBe("9007199254740993");
    expect(capture.physicalItems[0].id).toBe("9007199254740994");
    expect(f.query).toHaveBeenCalledTimes(5);
    for (const [statement] of f.query.mock.calls) {
      expect(statement.trimStart().startsWith("SELECT")).toBe(true);
      expect(statement).not.toMatch(/FOR\s+(?:UPDATE|SHARE)|\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/);
      expect(statement).not.toMatch(/\b(?:inventory|oms|catalog|channels)\./);
    }
  });
  it("selects all nonterminal states including null and reports terminal exclusions separately", async () => {
    const f = fixture(); await readWmsCutoverDemand(f.client);
    expect(f.query.mock.calls[1][0]).toContain("warehouse_status IS NULL OR warehouse_status NOT IN ('shipped','cancelled')");
    expect(f.query.mock.calls[0][0]).toContain("warehouse_status IN ('shipped','cancelled')");
    expect(f.query.mock.calls[2][1]).toEqual([[70], 50_001]);
  });
  it("retains negative and zero quantities, holds, and unknown states as evidence instead of hiding them", async () => {
    const f = fixture(); f.orders[0].status = "unrecognized"; f.items[0].status = "short";
    f.items[0].quantity = -2; f.items[0].pickedQuantity = 0; f.items[0].fulfilledQuantity = 5;
    f.items[0].onHold = true; f.sourceItems[0].quantity = 0; f.sourceItems[0].shipmentHeld = true;
    f.physicalItems[0].adjustmentQuantity = -3; f.physicalItems[0].effectiveQuantity = "-1";
    const capture = await readWmsCutoverDemand(f.client);
    expect(capture.items[0]).toMatchObject({ quantity: -2, pickedQuantity: 0, fulfilledQuantity: 5, status: "short", onHold: true });
    expect(capture.sourceItems[0]).toMatchObject({ quantity: 0, shipmentHeld: true });
    expect(capture.physicalItems[0].effectiveQuantity).toBe("-1");
    expect(f.query.mock.calls[4][0]).not.toContain("effective_physical_shipment_items");
    expect(f.query.mock.calls[4][0]).not.toMatch(/quantity_shipped\s*>\s*0/);
  });
  it("preserves foreign source-header membership and separate package allocation provenance without inventing source identity", async () => {
    const f = fixture(); f.sourceItems[0].headerOrderId = 99;
    f.allRows[4] = [{ ...f.physicalItems[0], legacySourceShipmentItemId: null, packageAllocationEntryId: "400" }];
    const capture = await readWmsCutoverDemand(f.client);
    expect(capture.sourceItems[0].headerOrderId).toBe(99);
    expect(capture.physicalItems[0]).toMatchObject({ legacySourceShipmentItemId: null, packageAllocationEntryId: "400" });
    expect(f.query.mock.calls[3][1]).toEqual([[70], [71], 100_001]);
    expect(f.query.mock.calls[4][1]).toEqual([[71], [101], 100_001]);
  });
  it("preserves missing warehouse, unknown/null statuses, and noninventory lines", async () => {
    const f = fixture(); f.allRows[1] = [{ ...f.orders[0], warehouseId: null, status: null }];
    f.allRows[2] = [{ ...f.items[0], status: null, requiresShipping: 0, productId: null, location: null }];
    const capture = await readWmsCutoverDemand(f.client);
    expect(capture.orders[0]).toMatchObject({ warehouseId: null, status: null });
    expect(capture.items[0]).toMatchObject({ status: null, requiresShipping: 0, productId: null, location: null });
  });
  it("does not query other owners or pretend terminal custody is covered when no nonterminal orders exist", async () => {
    const f = fixture(); f.allRows[1] = [];
    const capture = await readWmsCutoverDemand(f.client);
    expect(capture).toMatchObject({ scope: "nonterminal_wms_orders", excludedTerminalOrderCount: "17", orders: [], items: [], sourceItems: [], physicalItems: [] });
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(["orders", "items", "sourceItems", "physicalItems"] as const)("fails closed rather than returning a truncated %s set", async (kind) => {
    const f = fixture(); const index = ["orders", "items", "sourceItems", "physicalItems"].indexOf(kind) + 1;
    f.allRows[index] = [f.allRows[index][0], f.allRows[index][0]];
    await expect(readWmsCutoverDemand(f.client, { [kind]: 1 })).rejects.toMatchObject({ code: "WMS_CUTOVER_CAPTURE_LIMIT_EXCEEDED", context: { kind, limit: 1 } });
    expect(f.query).toHaveBeenCalledTimes(index + 1);
  });
  it.each([0, -1, 1.5, WMS_CUTOVER_CAPTURE_LIMITS.orders + 1, Number.NaN])("rejects invalid capture limit %s before any query", async (orders) => {
    const f = fixture(); await expect(readWmsCutoverDemand(f.client, { orders })).rejects.toMatchObject({ code: "WMS_CUTOVER_CAPTURE_LIMIT_INVALID" });
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([{ isolation: "read committed", readOnly: "on" }, { isolation: "repeatable read", readOnly: "off" }])("rejects an unsafe caller transaction %j", async (settings) => {
    const f = fixture(); Object.assign(f.meta, settings);
    await expect(readWmsCutoverDemand(f.client)).rejects.toMatchObject({ code: "WMS_CUTOVER_SNAPSHOT_REQUIRED" });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("accepts a serializable READ ONLY caller snapshot", async () => {
    const f = fixture(); f.meta.isolation = "serializable";
    expect((await readWmsCutoverDemand(f.client)).items).toHaveLength(1);
  });
  it.each(["9223372036854775808", "malformed"])("rejects lossy or malformed database identity %s", async (omsOrderLineId) => {
    const f = fixture(); f.allRows[2] = [{ ...f.items[0], omsOrderLineId }];
    await expect(readWmsCutoverDemand(f.client)).rejects.toMatchObject({ code: "WMS_CUTOVER_CAPTURE_EVIDENCE_INVALID" });
  });
  it("propagates database failure and leaves rollback to the transaction owner", async () => {
    const f = fixture(); const failure = Object.assign(new Error("serialization failure"), { code: "40001" });
    f.query.mockRejectedValueOnce(failure);
    await expect(readWmsCutoverDemand(f.client)).rejects.toBe(failure);
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
