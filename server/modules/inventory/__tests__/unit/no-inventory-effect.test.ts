import { describe, expect, it, vi } from "vitest";
import {
  costInventoryEffectSchema, costSourceRevisionSchema, type CostSourceRevision,
} from "@shared/procurement/cost-source-contracts";
import { proveNoInventoryEffect, type NoInventoryEffectEvidence } from "../../domain/no-inventory-effect";
import { projectPurchaseComponentStatus } from "../../../procurement/domain/purchase-cost-status";
import { summarizeInvoiceCostReconciliation } from "../../../procurement/domain/invoice-cost-reconciliation-summary";
import { applyNoInventoryEffect } from "../../application/apply-no-inventory-effect";
import { readNoInventoryEffectEvidence } from "../../infrastructure/no-inventory-effect.repository";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../../infrastructure/no-inventory-effect.repository", () => ({ readNoInventoryEffectEvidence: vi.fn() }));
const version = "a".repeat(64);
const effect = {
  kind: "none" as const, reason: "full_quarantine_return" as const, returnedBasePieces: 100,
  returns: [{ supplierCreditLineId: 12, returnDispositionId: 14, observationId: 15, receivingLineId: 16, quantity: 2, unitsPerVariant: 50 }],
};
function source(): CostSourceRevision {
  return costSourceRevisionSchema.parse({
    contractVersion: 1, revision: 1, fingerprint: version, scope: { kind: "purchase_order_line", purchaseOrderId: 1, purchaseOrderLineId: 2 },
    sources: [{ kind: "vendor_invoice_line", documentId: 3, lineId: 4, version }, { kind: "supplier_credit_line", documentId: 11, lineId: 12, version }],
    component: "product", currency: "USD", totalMills: 0, basePieces: 0, inventoryEffect: effect,
    evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null,
  });
}
function evidence(): NoInventoryEffectEvidence {
  return {
    purchaseOrderLineId: 2, recognizedQuantity: false, inventoryHistory: false, costHistory: false, outstandingCustody: false,
    invoices: [{ documentId: 3, lineId: 4, version }],
    returns: [{ ...effect.returns[0], supplierCreditId: 11, creditVersion: version, purchaseOrderLineId: 2,
      dispositionQuantity: 2, returnedQuantity: 2, observedQuantity: 2, receivedQuantity: 0, pendingQuantity: 0,
      sourceMatches: true, receiptClosed: true }],
  };
}
function component(overrides: Record<string, unknown> = {}) {
  const contract = source();
  const { revision: _revision, fingerprint: _fingerprint, ...input } = contract;
  const live = evidence();
  const proof = proveNoInventoryEffect(contract, live).proof!;
  return { input, currentFingerprint: version, revision: { id: 1, contract },
    application: { id: 1, status: "applied", reportingVerified: true, evidence: { lotIds: [], result: {
      status: "applied", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, issues: [], inventoryEffectProof: proof,
    } } }, lotIds: [], unprovenLotIds: [], changedLots: [], noInventoryEffectEvidence: live, ...overrides };
}

describe("full quarantine returns require positive evidence of no inventory effect", () => {
  it("accepts the explicit zero amount/zero units disposition without a unit price", () => {
    const contract = source();
    expect(proveNoInventoryEffect(contract, evidence())).toMatchObject({ issues: [], proof: { inventoryEffect: effect } });
    const summary = summarizeInvoiceCostReconciliation({
      costSources: [{ id: 1, contract }, { id: 2, contract: { ...contract, component: "packaging" } }],
      costApplications: Array.from({ length: 2 }, () => ({ status: "applied" as const,
        lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, inventoryEffectProof: proveNoInventoryEffect(contract, evidence()).proof })),
    });
    expect(summary).toMatchObject({ state: "confirmed_invoice_cost", authoritativeUnitCostMills: null });
    expect(summarizeInvoiceCostReconciliation({
      costSources: [{ id: 1, contract }, { id: 2, contract: { ...contract, component: "packaging" } }],
      costApplications: [{ status: "applied" }, { status: "applied" }],
    })).toMatchObject({ state: "review_required", authoritativeUnitCostMills: null });
  });
  it.each(["recognizedQuantity", "inventoryHistory", "costHistory"] as const)("blocks existing %s even with no on-hand stock", flag => {
    expect(proveNoInventoryEffect(source(), { ...evidence(), [flag]: true })).toMatchObject({
      proof: null, issues: [{ code: "COST_NO_EFFECT_RECOGNIZED_HISTORY" }],
    });
  });
  it("blocks outstanding receiving or custody and missing proof", () => {
    expect(proveNoInventoryEffect(source(), { ...evidence(), outstandingCustody: true }).issues[0].code).toBe("COST_NO_EFFECT_CUSTODY_PENDING");
    expect(proveNoInventoryEffect(source(), undefined).issues[0].code).toBe("COST_NO_EFFECT_EVIDENCE_REQUIRED");
  });
  it.each([
    { sourceMatches: false }, { receivedQuantity: 1 }, { pendingQuantity: 1 }, { returnedQuantity: 1 },
    { purchaseOrderLineId: 3 }, { supplierCreditId: 30 }, { receivingLineId: 30 }, { returnDispositionId: 30 },
    { observationId: 30 }, { unitsPerVariant: 10 }, { quantity: 1 }, { creditVersion: "b".repeat(64) },
  ])("rejects changed return provenance %j", change => {
    const live = evidence(); Object.assign(live.returns[0], change);
    expect(proveNoInventoryEffect(source(), live)).toMatchObject({ proof: null, issues: [{ code: "COST_NO_EFFECT_RETURN_CHANGED" }] });
  });
  it("rejects missing, duplicated or additional active returned credit sources", () => {
    for (const returns of [[], [...evidence().returns, ...evidence().returns],
      [...evidence().returns, { ...evidence().returns[0], supplierCreditLineId: 13 }]]) {
      expect(proveNoInventoryEffect(source(), { ...evidence(), returns }).proof).toBeNull();
    }
  });
  it("requires the immutable returned quantity and a closed zero-accepted receipt", () => {
    const live = evidence(); live.returns[0].dispositionQuantity = 1;
    expect(proveNoInventoryEffect(source(), live).issues[0].code).toBe("COST_NO_EFFECT_RETURN_EXCEEDED");
    live.returns[0].dispositionQuantity = 2; live.returns[0].receiptClosed = false;
    expect(proveNoInventoryEffect(source(), live).issues[0].code).toBe("COST_NO_EFFECT_RECEIPT_OPEN");
  });
  it("requires the exact current invoice set, including newly approved evidence", () => {
    for (const invoices of [[], [{ ...evidence().invoices[0], version: "b".repeat(64) }],
      [...evidence().invoices, { documentId: 9, lineId: 10, version }]]) {
      expect(proveNoInventoryEffect(source(), { ...evidence(), invoices }).issues[0].code).toBe("COST_NO_EFFECT_SOURCE_CHANGED");
    }
  });
  it("does not permit zero-unit ordinary sources, nonzero value, landed costs, or fabricated return totals", () => {
    const ordinary = { ...source(), inventoryEffect: undefined };
    expect(costSourceRevisionSchema.safeParse(ordinary).success).toBe(false);
    for (const change of [{ totalMills: 1 }, { basePieces: 1 }, { evidence: "estimated" }, { component: "landed" },
      { inventoryEffect: { ...effect, returnedBasePieces: 99 } }]) {
      expect(costSourceRevisionSchema.safeParse({ ...source(), ...change }).success).toBe(false);
    }
    expect(() => costInventoryEffectSchema.safeParse({ ...effect, returns: [{ ...effect.returns[0], quantity: 1.5 }] })).not.toThrow();
    expect(costInventoryEffectSchema.safeParse({ ...effect, returns: [{ ...effect.returns[0], quantity: 1.5 }] }).success).toBe(false);
  });
  it("preserves ordinary positive source contracts without adding fields", () => {
    const { inventoryEffect: _effect, ...ordinary } = source();
    expect(costSourceRevisionSchema.parse({ ...ordinary, basePieces: 10, totalMills: 100 })).not.toHaveProperty("inventoryEffect");
  });
  it("only exposes a completed effect when current proof, result and reporting agree", () => {
    expect(projectPurchaseComponentStatus(component())).toMatchObject({ status: "applied", inventoryEffect: effect });
    for (const change of [
      { noInventoryEffectEvidence: { ...evidence(), inventoryHistory: true } },
      { noInventoryEffectEvidence: undefined }, { changedLots: [{ lotId: 20, component: "product", amountMatches: true }] },
      { application: { ...component().application, reportingVerified: false } },
    ]) {
      const result = projectPurchaseComponentStatus(component(change));
      expect(result.status).toBe("review_required"); expect(result).not.toHaveProperty("inventoryEffect");
    }
    const forged = component();
    delete (forged.application.evidence.result as { inventoryEffectProof?: unknown }).inventoryEffectProof;
    expect(projectPurchaseComponentStatus(forged).status).toBe("review_required");
  });
});

describe("no-effect application boundary", () => {
  it("requires transaction-scoped graph protection and audit identity", async () => {
    const tx = { execute: vi.fn() };
    await expect(applyNoInventoryEffect(tx, { id: 1, contract: source() }, "", new Date())).rejects.toMatchObject({ code: "COST_AUDIT_IDENTITY_REQUIRED" });
    await expect(applyNoInventoryEffect(tx, { id: 1, contract: source() }, "actor", new Date("invalid"))).rejects.toMatchObject({ code: "COST_AUDIT_IDENTITY_REQUIRED" });
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it("records only application/reporting evidence and returns the exact zero-effects result", async () => {
    vi.mocked(readNoInventoryEffectEvidence).mockResolvedValue(new Map([[2, evidence()]]));
    const statements: string[] = [];
    const tx = { execute: vi.fn(async (query: unknown) => {
      const text = new PgDialect().sqlToQuery(query as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
      statements.push(text);
      return { rows: text.includes("INSERT INTO inventory.cost_applications") ? [{ id: 10 }] : [] };
    }) };
    const result = await applyNoInventoryEffect(tx, { id: 1, contract: source() }, "actor", new Date("2026-10-20T00:00:00Z"));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(result).toMatchObject({ status: "applied", applicationId: 10, lotsUpdated: 0, cogsRowsUpdated: 0,
      totalCogsDeltaCents: 0, issues: [], inventoryEffectProof: { inventoryEffect: effect } });
    expect(statements.filter(statement => /INSERT|UPDATE|DELETE/.test(statement))).toHaveLength(2);
    expect(statements.at(-1)).toContain("INSERT INTO inventory.cost_reporting_events");
  });
});
