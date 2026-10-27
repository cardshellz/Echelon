import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { reviewReceivingConfiguration } from "@shared/procurement/receiving-configuration";
import { shipmentReceivingSetupSchema } from "@shared/procurement/shipment-receiving-setup";
import { createShipmentTrackingService } from "../../shipment-tracking.service";
import { readShipmentReceivingSources } from "../../shipment-receiving-setup.repository";

const at = new Date("2026-10-20T12:00:00.000Z");
const configuration = { id: 30, productId: 10, sku: "CASE-100", name: "Case of 100", unitsPerVariant: 100, isActive: true };
const input = { pieces: 1000, variantId: 30, recordedUnits: 100, activeVariants: [configuration] };

describe("shared receiving configuration review", () => {
  it("uses the recorded configuration and an exact whole count", () => {
    expect(reviewReceivingConfiguration(input)).toEqual({ ready: true, count: 10, issue: null });
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid piece count %s", pieces => {
    expect(reviewReceivingConfiguration({ ...input, pieces }).issue?.code).toBe("INVALID_RECEIVING_UNIT_QUANTITY");
  });
  it.each([
    [{ variantId: null }, "RECEIVING_VARIANT_SELECTION_REQUIRED"],
    [{ activeVariants: [] }, "RECEIVING_VARIANT_REVIEW_REQUIRED"],
    [{ recordedUnits: null }, "RECEIVING_UNIT_SNAPSHOT_REQUIRED"],
    [{ recordedUnits: 50 }, "RECEIVING_UNIT_SOURCE_CHANGED"],
    [{ pieces: 1001 }, "RECEIVING_UNIT_SELECTION_INEXACT"],
  ] as const)("preserves missing or conflicting setup %j", (change, code) => {
    const result = reviewReceivingConfiguration({ ...input, ...change });
    expect(result).toMatchObject({ ready: false, count: null, issue: { code } });
  });
  it("accepts the supported maximum without rounding and never selects a divisor", () => {
    expect(reviewReceivingConfiguration({ pieces: 2_147_483_647, variantId: 1, recordedUnits: 1,
      activeVariants: [{ id: 1, unitsPerVariant: 1 }] }).count).toBe(2_147_483_647);
    expect(reviewReceivingConfiguration({ ...input, variantId: null }).ready).toBe(false);
  });
});

function harness() {
  const state = {
    shipment: { id: 1, status: "draft" } as any,
    lines: [{ id: 2, inboundShipmentId: 1, purchaseOrderId: 4, purchaseOrderLineId: 5, productVariantId: 30,
      unitsPerVariantSnapshot: 100, sku: "ITEM", qtyShipped: 1000 }] as any[],
    source: { id: 5, purchaseOrderId: 4, productId: 10, productVariantId: 30, expectedReceiveVariantId: 30,
      expectedReceiveUnitsPerVariant: 100, lineType: "product", productName: "Item" } as any,
    variants: [structuredClone(configuration)] as any[], history: [] as any[],
  };
  const sql: string[] = [];
  const database = { transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => {
    const tx = { state: structuredClone(state), execute: vi.fn(async (query: any) => {
      const text = new PgDialect().sqlToQuery(query).sql; sql.push(text);
      return { rows: text.includes("FROM catalog.product_variants") ? tx.state.variants
        : text.includes("FROM procurement.purchase_order_lines") ? [tx.state.source] : [{ id: 1 }] };
    }) };
    const result = await work(tx);
    Object.assign(state, tx.state);
    return result;
  }) };
  const storage = {
    getInboundShipmentById: vi.fn(async (_id: number, tx: any) => tx.state.shipment),
    getInboundShipmentLines: vi.fn(async (_id: number, tx: any) => tx.state.lines),
    getPurchaseOrderLineById: vi.fn(async (_id: number, tx: any) => tx.state.source),
    updateInboundShipment: vi.fn(async (_id: number, patch: any, tx: any) => Object.assign(tx.state.shipment, patch)),
    createInboundShipmentStatusHistory: vi.fn(async (entry: any, tx: any) => { tx.state.history.push(entry); return entry; }),
  };
  return { state, sql, storage, database, service: createShipmentTrackingService(database, storage as any, {} as any, () => at) };
}

describe("shipment booking and shipping receiving setup gate", () => {
  it("reports missing setup on a saved draft and rejects booking without changing its history", async () => {
    const h = harness(); h.state.lines[0].productVariantId = null; h.state.lines[0].unitsPerVariantSnapshot = null;
    h.state.source.expectedReceiveVariantId = null; h.state.source.productVariantId = null;
    const before = structuredClone(h.state);
    expect(await h.service.getReceivingSetup(1)).toMatchObject({ ready: false, issueCount: 1,
      lines: [{ issue: { code: "RECEIVING_VARIANT_SELECTION_REQUIRED" } }] });
    await expect(h.service.book(1, "operator")).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIVING_SETUP_REQUIRED" } });
    expect(h.state).toEqual(before); expect(h.storage.updateInboundShipment).not.toHaveBeenCalled();
  });
  it("books and departs with a recorded configuration, locking source and catalog before the status write", async () => {
    const h = harness();
    expect((await h.service.getReceivingSetup(1)).ready).toBe(true);
    await h.service.book(1, "operator");
    expect(h.state.shipment.status).toBe("booked");
    await h.service.markInTransit(1, "operator");
    expect(h.state.shipment.status).toBe("in_transit");
    expect(h.state.history.map(row => row.toStatus)).toEqual(["booked", "in_transit"]);
    expect(h.sql.some(query => query.includes("purchase_order_lines") && query.includes("FOR SHARE"))).toBe(true);
    expect(h.sql.some(query => query.includes("catalog.product_variants") && query.includes("FOR SHARE"))).toBe(true);
    expect(h.state.lines[0]).toMatchObject({ qtyShipped: 1000, unitsPerVariantSnapshot: 100 });
  });
  it.each(["inactive", "foreign", "changed", "inexact", "missing snapshot", "source conflict", "empty"])("rechecks %s setup at departure", async scenario => {
    const h = harness(); await h.service.book(1, "operator");
    if (scenario === "inactive") h.state.variants[0].isActive = false;
    if (scenario === "foreign") h.state.variants[0].productId = 99;
    if (scenario === "changed") h.state.variants[0].unitsPerVariant = 50;
    if (scenario === "inexact") h.state.lines[0].qtyShipped = 1001;
    if (scenario === "missing snapshot") { h.state.lines[0].unitsPerVariantSnapshot = null; h.state.source.expectedReceiveVariantId = null; }
    if (scenario === "source conflict") h.state.source.purchaseOrderId = 99;
    if (scenario === "empty") h.state.lines = [];
    const before = structuredClone(h.state);
    await expect(h.service.markInTransit(1, "operator")).rejects.toMatchObject({ details: { code: "SHIPMENT_RECEIVING_SETUP_REQUIRED" } });
    expect(h.state).toEqual(before);
  });
  it("allows a recorded PO default, but never fills a missing conversion from the current catalog", async () => {
    const h = harness(); h.state.lines[0].productVariantId = null; h.state.lines[0].unitsPerVariantSnapshot = null;
    await h.service.book(1, "operator");
    h.state.source.expectedReceiveUnitsPerVariant = null;
    await expect(h.service.markInTransit(1, "operator")).rejects.toMatchObject({ details: { code: "SHIPMENT_RECEIVING_SETUP_REQUIRED" } });
  });
  it("rejects an inconsistent outbound projection", () => {
    expect(shipmentReceivingSetupSchema.safeParse({ shipmentId: 1, ready: true, issueCount: 0, lines: [] }).success).toBe(false);
  });
  it("loads many source lines in one bounded query and rejects unrelated returned identities", async () => {
    const executor = { execute: vi.fn().mockResolvedValue({ rows: [{ id: 5 }, { id: 6 }] }) };
    expect((await readShipmentReceivingSources(executor, [6, 5, 6], true)).size).toBe(2);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    executor.execute.mockResolvedValue({ rows: [{ id: 99 }] });
    await expect(readShipmentReceivingSources(executor, [5], true)).rejects.toThrow(/identities/);
  });
});
