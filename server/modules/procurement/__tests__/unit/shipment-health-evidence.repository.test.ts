import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { inboundShipmentLines, inboundFreightCosts, inboundFreightAllocations, inventoryLots,
  landedCostSnapshots, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { readShipmentHealthEvidence } from "../../shipment-health-evidence.repository";

type Row = Record<string, unknown>;
function fixture() {
  const rows = new Map<object, Row[]>([
    [inboundShipmentLines, [
      { id: 11, inboundShipmentId: 1, purchaseOrderId: 101, purchaseOrderLineId: 111, qtyShipped: 3 },
      { id: 21, inboundShipmentId: 2, purchaseOrderId: 201, purchaseOrderLineId: 211, qtyShipped: 7 },
      { id: 12, inboundShipmentId: 1, purchaseOrderId: null, purchaseOrderLineId: null, qtyShipped: 1 },
    ]],
    [inboundFreightCosts, [{ id: 31, inboundShipmentId: 1, actualCents: 101 }, { id: 32, inboundShipmentId: 2, estimatedCents: 999 }]],
    [inboundFreightAllocations, [{ id: 41, shipmentCostId: 31, inboundShipmentLineId: 11, allocatedCents: 101 },
      // Stale allocations are deliberately retained for the existing owner to classify.
      { id: 42, shipmentCostId: 32, inboundShipmentLineId: 999, allocatedCents: 999 }]],
    [inventoryLots, [{ id: 51, inboundShipmentId: 2, costProvisional: 1 }]],
    [landedCostSnapshots, [{ id: 61, inboundShipmentLineId: 11, landedUnitCostCents: 34 }]],
    [purchaseOrderLines, [{ id: 111, purchaseOrderId: 101, totalProductCostCents: 300 }, { id: 211, purchaseOrderId: 201, totalProductCostCents: 700 }]],
    [purchaseOrders, [{ id: 101, currency: "USD" }, { id: 201, currency: "CAD" }]],
  ]);
  const queries: { table: object; where: SQL }[] = [];
  const select = vi.fn(() => ({ from(table: object) {
    const result = Promise.resolve(rows.get(table) ?? []);
    return { where(where: SQL) {
      queries.push({ table, where });
      return { then: result.then.bind(result), orderBy: () => result };
    } };
  } }));
  const tx = { select } as unknown as Parameters<typeof readShipmentHealthEvidence>[0];
  return { tx, rows, queries, select };
}

describe("bounded shipment health raw evidence", () => {
  it("reads seven batches for two shipments, preserving distinct sources, exact values, order and stale allocation evidence", async () => {
    const { tx, rows, queries, select } = fixture();
    const before = JSON.stringify([...rows.values()]);
    const result = await readShipmentHealthEvidence(tx, [1, 2]);
    expect(select).toHaveBeenCalledTimes(7);
    expect(result.get(1)?.lines.map(line => line.id)).toEqual([11, 12]);
    expect(result.get(2)?.lines.map(line => line.id)).toEqual([21]);
    expect(result.get(1)?.costs).toEqual([{ id: 31, inboundShipmentId: 1, actualCents: 101 }]);
    expect(result.get(1)?.provisionalLots).toEqual([]);
    expect(result.get(2)?.provisionalLots.map(lot => lot.id)).toEqual([51]);
    expect(result.get(1)?.snapshotsByLineId.get(11)?.landedUnitCostCents).toBe(34);
    expect(result.get(2)?.snapshotsByLineId.has(21)).toBe(false);
    expect(result.get(2)?.allocationsByCostId.get(32)?.[0].inboundShipmentLineId).toBe(999);
    expect(result.get(1)?.purchaseLinesById.get(111)?.totalProductCostCents).toBe(300);
    expect(result.get(2)?.purchaseOrdersById.get(201)?.currency).toBe("CAD");
    expect(JSON.stringify([...rows.values()])).toBe(before);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(queries.find(query => query.table === purchaseOrderLines)!.where).params).toEqual([[111, 211]]);
    expect(dialect.sqlToQuery(queries.find(query => query.table === purchaseOrders)!.where).params).toEqual([[101, 201]]);
  });
  it("retains missing PO sources as missing for the domain owner, without substituting another shipment's source", async () => {
    const { tx, rows } = fixture();
    rows.set(purchaseOrderLines, [{ id: 211, purchaseOrderId: 201 }]);
    rows.set(purchaseOrders, [{ id: 201, currency: "USD" }]);
    const evidence = (await readShipmentHealthEvidence(tx, [1, 2])).get(1)!;
    expect(evidence.purchaseLinesById.get(111)).toBeUndefined();
    expect(evidence.purchaseOrdersById.get(101)).toBeUndefined();
  });
  it("keeps every line above the wire bind-count limit without per-line queries or expanded ID parameters", async () => {
    const { tx, rows, queries, select } = fixture();
    const extra = Array.from({ length: 70_000 }, (_, index) => ({ id: 1000 + index, inboundShipmentId: 1,
      purchaseOrderId: 101, purchaseOrderLineId: 111, qtyShipped: 1 }));
    rows.get(inboundShipmentLines)!.push(...extra);
    const evidence = (await readShipmentHealthEvidence(tx, [1, 2])).get(1)!;
    expect(evidence.lines).toHaveLength(70_002);
    expect(evidence.lines.at(-1)?.id).toBe(70_999);
    expect(select).toHaveBeenCalledTimes(7);
    const query = new PgDialect().sqlToQuery(queries.find(query => query.table === landedCostSnapshots)!.where);
    expect(query.params).toHaveLength(1);
    expect(query.params[0]).toHaveLength(70_003);
    expect(query.sql).toContain("ANY($1::int[])");
  });
  it.each([inboundShipmentLines, inboundFreightCosts, inboundFreightAllocations, inventoryLots,
    landedCostSnapshots, purchaseOrderLines, purchaseOrders])("rejects duplicate raw identities", async table => {
    const { tx, rows } = fixture();
    rows.get(table)!.push({ ...rows.get(table)![0] });
    await expect(readShipmentHealthEvidence(tx, [1, 2])).rejects.toMatchObject({ code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" });
  });
  it("rejects multiple current snapshots even when their row IDs differ", async () => {
    const { tx, rows } = fixture();
    rows.get(landedCostSnapshots)!.push({ id: 62, inboundShipmentLineId: 11, landedUnitCostCents: 99 });
    await expect(readShipmentHealthEvidence(tx, [1, 2])).rejects.toMatchObject({ code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" });
  });
  it.each([
    [inboundShipmentLines, "inboundShipmentId"], [inboundFreightCosts, "inboundShipmentId"],
    [inboundFreightAllocations, "shipmentCostId"], [inventoryLots, "inboundShipmentId"],
    [landedCostSnapshots, "inboundShipmentLineId"], [purchaseOrderLines, "id"], [purchaseOrders, "id"],
  ] as const)("rejects unexpected source identities", async (table, column) => {
    const { tx, rows } = fixture();
    rows.get(table)![0][column] = 9999;
    await expect(readShipmentHealthEvidence(tx, [1, 2])).rejects.toMatchObject({ code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" });
  });
  it.each([[1, 1], [0], [-1], [1.5], Array.from({ length: 101 }, (_, index) => index + 1)].map(ids => ({ ids })))("rejects invalid header pages before SQL", async ({ ids }) => {
    const { tx, select } = fixture();
    await expect(readShipmentHealthEvidence(tx, ids)).rejects.toThrow();
    expect(select).not.toHaveBeenCalled();
  });
  it("does not query an empty page", async () => {
    const { tx, select } = fixture();
    expect(await readShipmentHealthEvidence(tx, [])).toEqual(new Map());
    expect(select).not.toHaveBeenCalled();
  });
});
