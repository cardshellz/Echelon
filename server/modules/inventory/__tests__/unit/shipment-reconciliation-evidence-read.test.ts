import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { CostIssue, CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { visitShipmentReconciliationEvidence, type ShipmentReconciliationReadRequest } from "../../infrastructure/cost-reconciliation.repository";

const source = (lineId: number): CostSourceRevision => ({ contractVersion: 1, revision: 1,
  fingerprint: "a".repeat(64), component: "landed", scope: { kind: "shipment_line", purchaseOrderId: 1,
    purchaseOrderLineId: 20 + lineId, inboundShipmentId: lineId, inboundShipmentLineId: lineId },
  sources: [{ kind: "shipment_cost", documentId: lineId, lineId, version: "b".repeat(64) }],
  currency: "USD", totalMills: 1000, basePieces: 10, evidence: "estimated",
  packagingTreatment: "not_applicable", issue: null, manualOverride: null });
const missing: CostIssue = { code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Review the original receipt history." };
const request = (lineId: number): ShipmentReconciliationReadRequest => ({ source: source(lineId), issues: [missing] });
const approval = (scope: number) => ({ scope_line_id: scope, id: "7", destination: "inventory_variance",
  evidence_fingerprint: "c".repeat(64), actor_name: "Reviewer", reason: "Original stock history reviewed." });
const posting = (scope: number) => ({ scope_line_id: scope, id: "9", destination: "inventory_variance", after_mills: "1000" });
const record = (scope: number, id = scope) => ({ scope_line_id: scope, id, lot_number: `LOT-${id}`, qty_received: 10,
  qty_on_hand: 0, receiving_order_id: null, receipt_line_id: null, has_cogs: false, has_legacy_cogs: false,
  has_physical_commitments: false, has_contribution: false, existing_landed_mills: "1000" });
function fixture() {
  const rows: Record<string, unknown>[][] = [[], [], []];
  const queries: ReturnType<PgDialect["sqlToQuery"]>[] = [];
  const execute = vi.fn(async (query: unknown) => {
    queries.push(new PgDialect().sqlToQuery(query as SQL));
    return { rows: rows[(queries.length - 1) % 3] };
  });
  return { rows, queries, execute, tx: { execute } };
}

describe("bounded shipment reconciliation evidence projection", () => {
  it("preserves exact approvals, independent destination balances, record flags and input order", async () => {
    const { tx, rows, queries } = fixture();
    rows[0].push(approval(2));
    rows[1].push(posting(2), { ...posting(2), id: "8", destination: "historical_cogs", after_mills: "0" });
    rows[2].push({ ...record(2), has_cogs: true, has_legacy_cogs: true, has_contribution: true, has_physical_commitments: true });
    const inputs = [request(2), request(1)], before = structuredClone(inputs);
    const projected = new Map<number, unknown>();
    await visitShipmentReconciliationEvidence(tx, inputs, (id, evidence) => { projected.set(id, evidence); });
    expect([...projected.keys()]).toEqual([2, 1]);
    expect(projected.get(2)).toMatchObject({ ledger: { approval: { id: 7, destination: "inventory_variance" },
      balances: { historical_cogs: 0, inventory_variance: 1000 }, lastIds: { historical_cogs: 8, inventory_variance: 9 } },
      records: [{ record: { lotId: 2, originalQuantity: 10, onHandQuantity: 0 },
        hasCogs: true, hasLegacyCogs: true, hasContribution: true, hasPhysicalCommitments: true, existingLandedMills: 1000 }] });
    expect(projected.get(1)).toEqual({ ledger: { approval: null, balances: { historical_cogs: 0, inventory_variance: 0 }, lastIds: {} }, records: [] });
    expect(inputs).toEqual(before);
    expect(queries).toHaveLength(3);
    expect(queries[0].params).toEqual([[2, 1]]);
    expect(queries[1].params).toEqual([[2, 1]]);
    expect(queries[2].sql).toContain("CROSS JOIN LATERAL");
    expect(queries[2].sql).toContain("LIMIT 1001");
  });

  it("retains 1000 records for each scope without imposing the per-line limit on their union", async () => {
    const { tx, rows } = fixture();
    rows[2].push(...Array.from({ length: 1000 }, (_, index) => record(1, index + 1)),
      ...Array.from({ length: 1000 }, (_, index) => record(2, index + 1001)));
    const lengths: number[] = [];
    await visitShipmentReconciliationEvidence(tx, [request(1), request(2)], (_id, evidence) => { lengths.push(evidence.records.length); });
    expect(lengths).toEqual([1000, 1000]);
  });

  it("rejects an individual 1001-record scope without truncating or subdividing it", async () => {
    const { tx, rows } = fixture();
    rows[2].push(...Array.from({ length: 1001 }, (_, index) => record(1, index + 1)));
    await expect(visitShipmentReconciliationEvidence(tx, [request(1)], () => undefined)).rejects.toMatchObject({ code: "COST_RECONCILIATION_LIMIT" });
  });

  it("binds retained quantity identities and keeps the first issue's original quantity", async () => {
    const { tx, rows, queries } = fixture();
    const input = request(1);
    input.issues = [{ code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "A historical outflow remains unassigned.",
      unresolvedQuantity: { inventoryLotId: 17, allocationId: 9, lotNumber: "LOT-17", originalQuantity: 10,
        onHandQuantityAtReview: 0, recordedOutflowQuantityAtReview: 8, quantity: 2, component: "landed", amountMills: 200 } }];
    rows[2].push(record(1, 17));
    const project = vi.fn();
    await visitShipmentReconciliationEvidence(tx, [input], project);
    expect(project.mock.calls[0][1].records[0].record.quantityWithoutHistory).toBe(2);
    const scopes = JSON.parse(queries[2].params[0] as string);
    expect(scopes).toEqual([{ line_id: 1, po_line_id: 21, shipment_id: 1, missing_origin: false, lot_ids: [17] }]);
  });

  it("reads three independently bounded pages for 201 scopes with no skipped identities", async () => {
    const { tx, execute, queries } = fixture();
    const projected: number[] = [];
    await visitShipmentReconciliationEvidence(tx, Array.from({ length: 201 }, (_, index) => request(index + 1)), id => { projected.push(id); });
    expect(execute).toHaveBeenCalledTimes(9);
    expect(projected).toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
    expect([queries[0].params[0], queries[3].params[0], queries[6].params[0]].map(ids => (ids as number[]).length)).toEqual([100, 100, 1]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, "1", null])("rejects invalid identity %s before SQL", async id => {
    const { tx, execute } = fixture(), input = request(1);
    Reflect.set(input.source.scope, "inboundShipmentLineId", id);
    await expect(visitShipmentReconciliationEvidence(tx, [input], () => undefined)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("validates all requests before SQL and refuses duplicate or non-shipment scopes", async () => {
    const { tx, execute } = fixture();
    await expect(visitShipmentReconciliationEvidence(tx, [request(1), request(1)], () => undefined)).rejects.toMatchObject({ code: "COST_RECONCILIATION_SCOPE" });
    const invalid = request(2); invalid.source.component = "product";
    await expect(visitShipmentReconciliationEvidence(tx, [request(1), invalid], () => undefined)).rejects.toMatchObject({ code: "COST_RECONCILIATION_SCOPE" });
    const po = request(1); po.source.scope = { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 21 };
    await expect(visitShipmentReconciliationEvidence(tx, [po], () => undefined)).rejects.toMatchObject({ code: "COST_RECONCILIATION_SCOPE" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2])("rejects evidence from an unrequested scope in query %i", async index => {
    const { tx, rows } = fixture(); rows[index].push(index === 0 ? approval(99) : index === 1 ? posting(99) : record(99));
    await expect(visitShipmentReconciliationEvidence(tx, [request(1)], () => undefined)).rejects.toMatchObject({ code: "COST_RECONCILIATION_SCOPE" });
  });

  it.each(["approval", "posting", "record", "duplicate approval", "duplicate balance"])("fails closed on malformed %s", async kind => {
    const { tx, rows } = fixture();
    if (kind === "approval") rows[0].push({ ...approval(1), evidence_fingerprint: "invalid" });
    if (kind === "posting") rows[1].push({ ...posting(1), after_mills: "9007199254740992" });
    if (kind === "record") rows[2].push({ ...record(1), qty_received: -1 });
    if (kind === "duplicate approval") rows[0].push(approval(1), approval(1));
    if (kind === "duplicate balance") rows[1].push(posting(1), posting(1));
    await expect(visitShipmentReconciliationEvidence(tx, [request(1)], () => undefined)).rejects.toThrow();
  });

  it.each([1, 2, 3])("propagates query %i failure without retrying a projection", async failedQuery => {
    const { tx, execute } = fixture(), project = vi.fn();
    for (let index = 1; index < failedQuery; index++) execute.mockResolvedValueOnce({ rows: [] });
    execute.mockRejectedValueOnce(new Error("reconciliation unavailable"));
    await expect(visitShipmentReconciliationEvidence(tx, [request(1)], project)).rejects.toThrow("reconciliation unavailable");
    expect(execute).toHaveBeenCalledTimes(failedQuery); expect(project).not.toHaveBeenCalled();
  });

  it("does not retry failed projections or retain their mutated evidence", async () => {
    const { tx, execute } = fixture(); const project = vi.fn(() => { throw new Error("projection failed"); });
    await expect(visitShipmentReconciliationEvidence(tx, [request(1)], project)).rejects.toThrow("projection failed");
    expect(project).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(3);
    await visitShipmentReconciliationEvidence(tx, [request(1), request(2)], (_id, evidence) => {
      expect(evidence.ledger.balances.inventory_variance).toBe(0); evidence.ledger.balances.inventory_variance = 123;
    });
  });

  it("does not query an empty scope", async () => {
    const { tx, execute } = fixture(); await visitShipmentReconciliationEvidence(tx, [], () => undefined);
    expect(execute).not.toHaveBeenCalled();
  });
});
