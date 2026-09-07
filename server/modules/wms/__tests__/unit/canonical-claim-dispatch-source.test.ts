import { describe, expect, it, vi } from "vitest";
import type { CanonicalClaimDispatchCommand } from "@shared/types/inventory-availability-dispatch";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../canonical-claim-dispatch-source";

function fixture(physical = false) {
  const command: CanonicalClaimDispatchCommand = { claimId: "10", orderId: 70, orderItemId: 71, warehouseId: 1,
    warehouseLocationId: 50, productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101,
    physicalShipmentId: physical ? "700" : null, physicalShipmentItemId: physical ? "701" : null,
    quantity: "3", idempotencyKey: "dispatch:90:101", actor: "test", reason: "Exact dispatch" };
  const rows: Record<string, any[]> = {
    settings: [{ isolation: "serializable", read_only: "off" }],
    order: [{ id: 70, warehouse_id: 1, warehouse_status: "ready_to_ship", on_hold: 0, cancelled: false }],
    item: [{ id: 71, order_id: 70, product_id: 105, status: "completed", on_hold: false, requires_shipping: 1 }],
    header: [{ id: 90, order_id: 70, status: "shipped", held: false, requires_review: false,
      shipment_purpose: "customer_fulfillment", replaces_shipment_id: null, cancelled: false, voided: false }],
    source: [{ id: 101, shipment_id: 90, order_item_id: 71, product_variant_id: 105, qty: 3,
      from_location_id: 50, shipment_item_purpose: "customer_fulfillment", replacement_for_order_item_id: null,
      correction_for_shipment_item_id: null, provider_membership_state: "authoritative" }],
    physicalIdentity: physical ? [{ id: "701", physical_shipment_id: "700" }] : [],
    physicalHeader: [{ id: "700", status: "shipped" }],
    physicalItem: [{ id: "701", physical_shipment_id: "700", legacy_wms_shipment_item_id: 101,
      wms_order_item_id: 71, product_variant_id: 105, quantity_shipped: 3, shipment_item_purpose: "customer_fulfillment",
      replacement_for_order_item_id: null, correction_for_physical_shipment_item_id: null, package_allocation_entry_id: null }],
    adjustments: [],
  };
  const calls: { key: string; sql: string; values?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const key = sql.includes("current_setting") ? "settings"
      : sql.includes("FROM wms.orders ") ? "order"
        : sql.includes("FROM wms.order_items ") ? "item"
          : sql.includes("FROM wms.outbound_shipments ") ? "header"
            : sql.includes("FROM wms.outbound_shipment_items ") ? "source"
              : sql.includes("FROM wms.physical_shipments ") ? "physicalHeader"
                : sql.includes("FROM wms.physical_shipment_item_quantity_adjustments ") ? "adjustments"
                  : sql.includes("FROM wms.physical_shipment_items ") ? (sql.includes("FOR UPDATE") ? "physicalItem" : "physicalIdentity") : "unknown";
    calls.push({ key, sql, values });
    if (!rows[key]) throw new Error(`Unexpected query ${sql}`);
    return { rows: rows[key], rowCount: rows[key].length };
  });
  const run = () => new WmsCanonicalClaimDispatchSourceOwner().lockDispatchSource({ client: { query }, command });
  return { command, rows, query, calls, run };
}

describe("WMS canonical dispatch source owner", () => {
  it("locks the exact owner chain on the caller client without transactions, writes or other owner reads", async () => {
    const f = fixture(); const before = structuredClone({ command: f.command, rows: f.rows });
    expect(await f.run()).toEqual({ orderId: 70, orderItemId: 71, warehouseId: 1, warehouseLocationId: 50,
      productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101, physicalShipmentId: null,
      physicalShipmentItemId: null, physicalShipmentItemQuantity: null, quantity: "3", readiness: "authorized", orderStatus: "ready_to_ship" });
    expect(f.calls.map((call) => call.key)).toEqual(["settings", "order", "item", "header", "source", "physicalIdentity"]);
    for (const call of f.calls.slice(1, 5)) expect(call.sql).toContain("FOR UPDATE");
    for (const call of f.calls) {
      expect(call.sql).toMatch(/^SELECT /);
      expect(call.sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|DELETE|SET|advisory|inventory\.|warehouse\.|catalog\.|oms\.)/i);
    }
    expect({ command: f.command, rows: f.rows }).toEqual(before);
  });
  it("binds and locks exact immutable physical item identity when it exists", async () => {
    const f = fixture(true); expect(await f.run()).toMatchObject({ physicalShipmentId: "700", physicalShipmentItemId: "701", physicalShipmentItemQuantity: "3" });
    expect(f.calls.map((call) => call.key)).toEqual(["settings", "order", "item", "header", "source", "physicalIdentity", "physicalHeader", "physicalItem", "adjustments"]);
    expect(f.calls[6].sql).toContain("FOR UPDATE"); expect(f.calls[7].sql).toContain("FOR UPDATE");
  });
  it.each(["read committed", "repeatable read"])("rejects %s transaction isolation before any owner lock", async (isolation) => {
    const f = fixture(); f.rows.settings[0].isolation = isolation;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_TRANSACTION_REQUIRED" }); expect(f.calls).toHaveLength(1);
  });
  it("rejects READ ONLY transactions", async () => {
    const f = fixture(); f.rows.settings[0].read_only = "on";
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_TRANSACTION_REQUIRED" });
  });
  it("rejects request authorization injection before reading the database", async () => {
    const f = fixture(); Object.assign(f.command, { readiness: "authorized" });
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_EVIDENCE_INVALID" }); expect(f.calls).toHaveLength(0);
  });
  it.each(["order", "item", "header", "source"])("rejects missing %s ownership", async (key) => {
    const f = fixture(); f.rows[key] = [];
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_EVIDENCE_INVALID" });
  });
  it.each([
    ["order", "warehouse_id", null], ["order", "warehouse_id", 2], ["item", "order_id", 99],
    ["header", "order_id", 99], ["source", "shipment_id", 99],
    ["source", "order_item_id", 99], ["source", "product_variant_id", 99],
    ["source", "from_location_id", null], ["source", "from_location_id", 99],
  ])("rejects mismatched %s.%s=%s without guessing a bin or owner", async (key, field, value) => {
    const f = fixture(); f.rows[String(key)][0][String(field)] = value;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_IDENTITY_MISMATCH" });
  });
  it.each([99, null])("does not mistake legacy product_id=%s for the exact source variant identity", async (productId) => {
    const f = fixture(); f.rows.item[0].product_id = productId;
    expect(await f.run()).toMatchObject({ productVariantId: 105 });
    f.rows.source[0].product_variant_id = 99;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_IDENTITY_MISMATCH" });
  });
  it.each([["order", "on_hold", 1], ["order", "warehouse_status", "on_hold"], ["item", "on_hold", true], ["header", "held", true]])(
    "rejects held %s.%s", async (key, field, value) => {
      const f = fixture(); f.rows[String(key)][0][String(field)] = value;
      await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_HELD" });
    });
  it.each([["order", "cancelled", true], ["order", "warehouse_status", "cancelled"], ["item", "status", "cancelled"]])(
    "rejects cancelled %s.%s", async (key, field, value) => {
      const f = fixture(); f.rows[String(key)][0][String(field)] = value;
      await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_CANCELLED" });
    });
  it.each([
    ["order", "warehouse_status", "exception"], ["order", "warehouse_status", "awaiting_3pl"], ["item", "requires_shipping", 0],
    ["header", "status", "labeled"], ["header", "status", "returned"], ["header", "status", "lost"], ["header", "status", null],
    ["header", "cancelled", true], ["header", "voided", true], ["header", "requires_review", true],
    ["header", "shipment_purpose", "replacement"], ["header", "replaces_shipment_id", 99],
    ["source", "shipment_item_purpose", "concession"], ["source", "shipment_item_purpose", "omission_correction"],
    ["source", "replacement_for_order_item_id", 99], ["source", "correction_for_shipment_item_id", 99],
    ["source", "provider_membership_state", "pending_append"], ["source", "provider_membership_state", "unknown"],
  ])("rejects unauthorized %s.%s=%s", async (key, field, value) => {
    const f = fixture(); f.rows[String(key)][0][String(field)] = value;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_NOT_AUTHORIZED" });
  });
  it.each(["order", "item"])("rejects unknown %s state", async (key) => {
    const f = fixture(); f.rows[key][0][key === "order" ? "warehouse_status" : "status"] = "unknown";
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_EVIDENCE_INVALID" });
  });
  it.each([0, -1, 2, 4])("rejects source quantity %s without partial posting", async (qty) => {
    const f = fixture(); f.rows.source[0].qty = qty;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_QUANTITY_MISMATCH" });
  });
  it("requires actual physical lineage when command supplies physical IDs", async () => {
    const f = fixture(true); f.rows.physicalIdentity = [];
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CONFLICT" });
  });
  it("requires the command to bind an existing physical item, not omit it", async () => {
    const f = fixture(true); f.command.physicalShipmentId = null; f.command.physicalShipmentItemId = null;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CONFLICT" });
  });
  it.each([
    ["physicalHeader", "status", "voided"], ["physicalItem", "legacy_wms_shipment_item_id", 99],
    ["physicalItem", "wms_order_item_id", 99], ["physicalItem", "product_variant_id", 99],
    ["physicalItem", "quantity_shipped", 2], ["physicalItem", "shipment_item_purpose", "replacement"],
    ["physicalItem", "replacement_for_order_item_id", 99], ["physicalItem", "correction_for_physical_shipment_item_id", "999"],
    ["physicalItem", "package_allocation_entry_id", "999"],
  ])("rejects mismatched physical evidence %s.%s", async (key, field, value) => {
    const f = fixture(true); f.rows[String(key)][0][String(field)] = value;
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CONFLICT" });
  });
  it("does not hide quantity corrections through a positive-only effective view", async () => {
    const f = fixture(true); f.rows.adjustments = [{ physical_shipment_item_id: "701" }];
    await expect(f.run()).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CORRECTION" });
    expect(f.calls.at(-1)?.sql).not.toContain("effective_physical");
  });
  it("propagates database errors untouched for caller rollback/retry instead of treating them as missing evidence", async () => {
    const f = fixture(); const error = Object.assign(new Error("serialization failure"), { code: "40001" });
    f.query.mockRejectedValueOnce(error); await expect(f.run()).rejects.toBe(error);
  });
});
