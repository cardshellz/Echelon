import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { visitPurchaseCostStatusScopes } from "../../purchase-cost-status-batch.repository";
import { createPurchaseCostStatusSnapshotReader } from "../../purchase-cost-status-snapshot.repository";

vi.mock("../../purchase-cost-status.repository", async original => ({
  ...await original<typeof import("../../purchase-cost-status.repository")>(), readPurchaseCostStatus: vi.fn(),
}));
const tx = { execute: vi.fn() };
function status(ids: readonly number[]): PurchaseCostStatus {
  return { lines: ids.map(id => ({ purchaseOrderId: 10, purchaseOrderLineId: id, sku: "SKU-" + id,
    components: (["product", "packaging"] as const).map(component => ({ component, status: "pending" as const,
      sourceEvidence: "estimated" as const, sourceCurrent: false, sourceRevisionId: null, applicationId: null, issues: [] })),
    invoices: [{ invoiceId: 20, invoiceNumber: "INV-20", lineId: id + 100, lineNumber: 1 }], receipts: [],
    lots: [{ id: id + 1000, lotNumber: "LOT-" + id, onHandUnits: 5, shipmentId: 30, provisional: true, origin: "receipt" as const }],
  })) };
}
beforeEach(() => { vi.mocked(readPurchaseCostStatus).mockReset().mockImplementation(async (_tx, ids) => status(ids)); });
describe("bounded supplier evidence across shipment scopes", () => {
  it("reads one union, preserves original scope order and complete nested evidence, and isolates projections", async () => {
    const scopes = new Map([[8, [2, 1, 2]], [3, [2]], [9, []]]), original = structuredClone(scopes);
    const result = new Map<number, PurchaseCostStatus>();
    await visitPurchaseCostStatusScopes(tx, scopes, (id, value) => {
      result.set(id, structuredClone(value)); value.lines[0]?.invoices.splice(0);
    });
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [1, 2]);
    expect([...result]).toEqual([[8, status([1, 2])], [3, status([2])], [9, status([])]]);
    expect(scopes).toEqual(original);
  });
  it("uses the supplied snapshot and retains its executor fence", async () => {
    const snapshot = createPurchaseCostStatusSnapshotReader(tx);
    const project = vi.fn();
    await visitPurchaseCostStatusScopes(tx, new Map([[1, [2]], [2, [1]]]), project, snapshot);
    await visitPurchaseCostStatusScopes(tx, new Map([[3, [1, 2]]]), project, snapshot);
    expect(readPurchaseCostStatus).toHaveBeenCalledOnce();
    await expect(visitPurchaseCostStatusScopes({ execute: vi.fn() }, new Map([[1, [1, 2]]]), project, snapshot))
      .rejects.toMatchObject({ code: "COST_STATUS_SNAPSHOT_MISMATCH" });
  });
  it("does no work for no scopes and projects an empty shipment without SQL", async () => {
    const project = vi.fn();
    await visitPurchaseCostStatusScopes(tx, new Map(), project);
    expect(project).not.toHaveBeenCalled();
    await visitPurchaseCostStatusScopes(tx, new Map([[1, []]]), project);
    expect(project).toHaveBeenCalledExactlyOnceWith(1, status([]));
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it.each([[0], [-1], [1.5], ["1"], [NaN], [Number.MAX_SAFE_INTEGER + 1], Array.from({ length: 501 }, (_, i) => i + 1)].map(input => ({ input })))(
    "validates every original line set before reading: $input", async ({ input }) => {
      const project = vi.fn();
      await expect(visitPurchaseCostStatusScopes(tx, new Map([[1, [1]], [2, input as number[]]]), project)).rejects.toThrow();
      expect(readPurchaseCostStatus).not.toHaveBeenCalled(); expect(project).not.toHaveBeenCalled();
    });
  it("validates the complete header page before SQL", async () => {
    await expect(visitPurchaseCostStatusScopes(tx, new Map([[0, [1]]]), vi.fn())).rejects.toThrow();
    await expect(visitPurchaseCostStatusScopes(tx, new Map(Array.from({ length: 101 }, (_, i) => [i + 1, []])), vi.fn())).rejects.toThrow();
    expect(readPurchaseCostStatus).not.toHaveBeenCalled();
  });
  it("splits a union exceeding 500 lines without rejecting either valid original scope", async () => {
    const first = Array.from({ length: 300 }, (_, i) => i + 1), second = first.map(id => id + 300);
    const project = vi.fn();
    await visitPurchaseCostStatusScopes(tx, new Map([[1, first], [2, second]]), project);
    expect(vi.mocked(readPurchaseCostStatus).mock.calls.map(call => call[1])).toEqual([first, second]);
    expect(project.mock.calls).toEqual([[1, status(first)], [2, status(second)]]);
  });
  it.each(["COST_REVIEW_LIMIT", "CREDIT_SOURCE_LIMIT"])("splits only aggregate %s and preserves a genuine per-shipment failure", async code => {
    vi.mocked(readPurchaseCostStatus).mockImplementation(async (_tx, ids) => {
      if (ids.length > 1) throw new CostEvidenceError(code, "Combined evidence is over its existing limit");
      return status(ids);
    });
    const project = vi.fn();
    await visitPurchaseCostStatusScopes(tx, new Map([[1, [1]], [2, [2]]]), project);
    expect(vi.mocked(readPurchaseCostStatus).mock.calls.map(call => call[1])).toEqual([[1, 2], [1], [2]]);
    expect(project.mock.calls).toEqual([[1, status([1])], [2, status([2])]]);
    vi.mocked(readPurchaseCostStatus).mockRejectedValue(new CostEvidenceError(code, "One original scope is over limit"));
    await expect(visitPurchaseCostStatusScopes(tx, new Map([[1, [1]]]), vi.fn())).rejects.toMatchObject({ code });
  });
  it.each(["COST_SOURCE_MISSING", "COST_RECONCILIATION_LIMIT", "COST_EVIDENCE_INVALID_INTEGER"])("does not split or suppress %s", async code => {
    vi.mocked(readPurchaseCostStatus).mockRejectedValue(new CostEvidenceError(code, "Evidence failed"));
    const project = vi.fn();
    await expect(visitPurchaseCostStatusScopes(tx, new Map([[1, [1]], [2, [2]]]), project)).rejects.toMatchObject({ code });
    expect(readPurchaseCostStatus).toHaveBeenCalledOnce(); expect(project).not.toHaveBeenCalled();
  });
  it("does not retry a projection that throws a similarly named scope error", async () => {
    const project = vi.fn(() => { throw new CostEvidenceError("COST_REVIEW_LIMIT", "Projection failed"); });
    await expect(visitPurchaseCostStatusScopes(tx, new Map([[1, [1]], [2, [2]]]), project)).rejects.toThrow("Projection failed");
    expect(project).toHaveBeenCalledOnce(); expect(readPurchaseCostStatus).toHaveBeenCalledOnce();
  });
  it.each([status([]), status([1, 1]), { lines: [{ invalid: true }] }])("rejects incomplete, duplicate or malformed canonical output", async output => {
    vi.mocked(readPurchaseCostStatus).mockResolvedValue(output as PurchaseCostStatus);
    const project = vi.fn();
    await expect(visitPurchaseCostStatusScopes(tx, new Map([[1, [1]]]), project)).rejects.toThrow();
    expect(project).not.toHaveBeenCalled();
  });
});
