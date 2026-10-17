import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "../../purchase-workspace-read";
import { readPurchaseCostApplications } from "../../purchase-cost-application-read.repository";

const readers = vi.hoisted(() => ({ exceptions: vi.fn(), ledger: vi.fn() }));
vi.mock("../../shipment-cost-exception.repository", () => ({ readShipmentCostExceptions: readers.exceptions }));
vi.mock("../../../inventory/infrastructure/cost-reconciliation.repository", () => ({ readReconciliationLedger: readers.ledger }));
const dialect = new PgDialect();
const at = "2026-10-16T12:00:00.000Z";
const issues = [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Historical stock destination remains unknown." }];
const review = { state: "open", fingerprint: "a".repeat(64), kind: "missing_receipt_history", currency: "USD",
  allocatedMills: 2000, amountMills: 2000, lotsUpdated: 0, cogsRowsUpdated: 0, issues, decision: null,
  reconciliation: { status: "posted", postedMills: 2000, unassignedMills: 0, destination: "inventory_variance" } };
function fixture(postedAmount: string = "2000") {
  const statements: string[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const text = dialect.sqlToQuery(query).sql;
    statements.push(text);
    if (text.includes("FROM procurement.cost_source_revisions revision")) return { rows: [
      { id: "11", purchaseOrderLineId: 171, shipmentLineId: 71, shipmentId: 7, component: "landed", revision: 1,
        fingerprint: "a".repeat(64), contract: {}, sourceEvidence: null, recordedBy: "operator", recordedAt: at },
    ] };
    if (text.includes("FROM inventory.cost_applications application")) return { rows: [
      { id: "22", sourceRevisionId: "11", status: "review_required", result: { issues }, recordedBy: "operator", recordedAt: at },
    ] };
    if (text.includes("FROM inventory.cost_reconciliation_postings posting")) return { rows: [
      { id: "51", approvalId: "61", applicationId: "22", sourceRevisionId: "11", destination: "inventory_variance",
        beforeMills: "0", afterMills: postedAmount, deltaMills: postedAmount, actorName: "Reviewer", reason: "Reviewed historical destination.", recordedAt: at },
    ] };
    return { rows: [] };
  });
  return { tx: { execute } as unknown as Transaction, statements };
}
beforeEach(() => {
  readers.exceptions.mockReset().mockResolvedValue(new Map([[71, review]]));
  readers.ledger.mockReset().mockResolvedValue({ approval: { id: 61, destination: "inventory_variance", fingerprint: "a".repeat(64) },
    balances: { inventory_variance: 2000, historical_cogs: 0 }, lastIds: { inventory_variance: 51 } });
});
describe("current purchase cost reconciliation repository", () => {
  it("binds current canonical reconciliation to its exact source, application and immutable posting", async () => {
    const { tx, statements } = fixture();
    const result = await readPurchaseCostApplications(tx, 17);
    expect(result.currentResolutions).toEqual([expect.objectContaining({ sourceRevisionId: 11, applicationId: 22,
      sourceFingerprint: "a".repeat(64), destination: "inventory_variance", postedMills: 2000,
      postings: [expect.objectContaining({ id: 51, approvalId: 61, actorName: "Reviewer" })] })]);
    expect(readers.exceptions).toHaveBeenCalledWith(tx, [71]);
    expect(statements.every((statement) => statement.trimStart().startsWith("SELECT"))).toBe(true);
  });
  it.each(["stale", "different_issue", "acceptance_only", "missing_posting"])("does not announce resolved costs for %s evidence", async (kind) => {
    if (kind === "stale") readers.exceptions.mockResolvedValue(new Map([[71, { ...review, reconciliation: { ...review.reconciliation, status: "review_required" } }]]));
    if (kind === "different_issue") readers.exceptions.mockResolvedValue(new Map([[71, { ...review, issues: [{ ...issues[0], message: "Different historical gap." }] }]]));
    if (kind === "acceptance_only") readers.exceptions.mockResolvedValue(new Map([[71, { ...review, state: "accepted", reconciliation: undefined }]]));
    if (kind === "missing_posting") readers.ledger.mockResolvedValue({ lastIds: { inventory_variance: 52 } });
    expect((await readPurchaseCostApplications(fixture().tx, 17)).currentResolutions).toEqual([]);
  });
  it("propagates unavailable current evidence rather than silently returning an unresolved or resolved empty state", async () => {
    readers.exceptions.mockRejectedValue(new Error("Current source unavailable"));
    await expect(readPurchaseCostApplications(fixture().tx, 17)).rejects.toThrow("Current source unavailable");
  });
  it("rejects unsafe posting amounts before number conversion", async () => {
    await expect(readPurchaseCostApplications(fixture("9007199254740992").tx, 17)).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_MONEY_INVALID" });
  });
});
