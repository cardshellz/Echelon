import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readShipmentCostRevisionEvidence, shipmentCostReadBatches } from "../../shipment-cost-revision-read.repository";
import { readShipmentSupplierCreditCostRows } from "../../supplier-credit-source.repository";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";

function fixture() {
  const sets = [
    [{ __shipment_id: 1, id: 11, qty_shipped: 3 }, { __shipment_id: 2, id: 21, qty_shipped: 7 }],
    [{ __shipment_id: 1, id: 31, actual_cents: 101 }, { __shipment_id: 2, id: 32, estimated_cents: 999 }],
    [{ __shipment_id: 1, id: 41, vendor_invoice_id: 5, document_lines_total_cents: "1100" }, { __shipment_id: 2, id: 41, vendor_invoice_id: 5, document_lines_total_cents: "1100" }],
    [{ __shipment_id: 1, id: 51, allocated_cents: 101 }, { __shipment_id: 2, id: 52, allocated_cents: 999 }],
    [{ __shipment_id: 2, __source_row: "1", id: 61, freight_cost_id: 32, amount_cents: 11 }],
    [{ __shipment_id: 1, inbound_shipment_line_id: 11, contract: { fingerprint: "a".repeat(64) } }],
  ];
  const execute = vi.fn(); for (const rows of sets) execute.mockResolvedValueOnce({ rows });
  return { sets, execute, tx: { execute } };
}
describe("bounded shipment economic evidence", () => {
  it("routes complete source rows without changing any fingerprint field or scalar type", async () => {
    const { sets, execute, tx } = fixture(); const before = structuredClone(sets);
    const result = await readShipmentCostRevisionEvidence(tx, [1, 2]);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(result.get(1)?.lines).toEqual([{ id: 11, qty_shipped: 3 }]);
    expect(result.get(2)?.charges).toEqual([{ id: 32, estimated_cents: 999 }]);
    const invoice = [{ id: 41, vendor_invoice_id: 5, document_lines_total_cents: "1100" }];
    expect(costFingerprint(result.get(1)?.invoiceRows)).toBe(costFingerprint(invoice));
    expect(result.get(2)?.invoiceRows).toEqual(invoice);
    expect(result.get(1)?.supplierCredits).toEqual([]);
    expect(result.get(2)?.supplierCredits).toEqual([{ id: 61, freight_cost_id: 32, amount_cents: 11 }]);
    expect(sets).toEqual(before);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[2][0]);
    expect(query.sql).toContain("PARTITION BY selected.shipment_id,invoice.id");
    expect(query.params.every(value => Array.isArray(value) && JSON.stringify(value) === "[1,2]")).toBe(true);
  });
  it("rejects a foreign routing identity instead of treating another shipment as current", async () => {
    const { tx, execute } = fixture(); execute.mockReset().mockResolvedValue({ rows: [{ __shipment_id: 99, id: 11 }] });
    await expect(readShipmentCostRevisionEvidence(tx, [1, 2])).rejects.toMatchObject({ code: "SHIPMENT_COST_READ_EVIDENCE_INCOMPLETE" });
  });
  it.each([[0], [1.5], Array.from({ length: 101 }, (_, i) => i + 1)])("rejects invalid direct pages before SQL", async ids => {
    const { tx, execute } = fixture(); await expect(readShipmentCostRevisionEvidence(tx, ids)).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  });
  it("validates every batch identity before returning bounded deduplicated pages", () => {
    const ids = Array.from({ length: 251 }, (_, i) => i + 1); const before = [...ids];
    expect(shipmentCostReadBatches([...ids, 1]).map(page => page.length)).toEqual([100, 100, 51]); expect(ids).toEqual(before);
    expect(() => shipmentCostReadBatches([...ids, 0])).toThrow();
  });
  it("does not query an empty page", async () => {
    const { tx, execute } = fixture(); expect(await readShipmentCostRevisionEvidence(tx, [])).toEqual(new Map()); expect(execute).not.toHaveBeenCalled();
  });
  it("preserves per-shipment credit limits when the combined batch is larger", async () => {
    const rows = [1, 2].flatMap(id => Array.from({ length: 6000 }, (_, i) => ({ __shipment_id: id, __source_row: String(i + 1), id: id * 10000 + i })));
    const execute = vi.fn().mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [{ __shipment_id: 1, __source_row: "10001", id: 1 }] });
    const tx = { execute }; const result = await readShipmentSupplierCreditCostRows(tx, [1, 2]);
    expect(result.get(1)).toHaveLength(6000); expect(result.get(2)).toHaveLength(6000);
    await expect(readShipmentSupplierCreditCostRows(tx, [1, 2])).rejects.toMatchObject({ code: "CREDIT_SOURCE_LIMIT" });
  });
});
