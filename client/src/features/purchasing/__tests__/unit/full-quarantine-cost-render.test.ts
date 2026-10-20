import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { purchaseCostComponentStatusSchema, purchaseLineCostStatusSchema, purchaseLineInventoryEffect,
  purchaseCostNextAction, purchaseLineNeedsCostReview } from "@shared/procurement/purchase-cost-status";
import { supplierCreditDetailSchema, supplierCreditLineSchema } from "@shared/procurement/supplier-credit";
import { useProcurementNavigation, type ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { PurchaseSupplierCostReview } from "../../PurchaseSupplierCostReview";
import { PurchaseCostApplications, PurchaseReceiptCostQueue } from "../../PurchaseCostApplications";
import { noInventoryEffectLabel } from "../../cost-inventory-effect-presentation";
import { supplierCreditCostSummary } from "../../supplier-credit-presentation";
import { fullQuarantineInventoryEffect, fullQuarantineCostStatus, fullQuarantineWorkspace } from "../../../../../../test/fixtures/full-quarantine-cost";
import { supplierCreditFixture } from "../../../../../../test/fixtures/supplier-credit";

function render(content: (navigation: ProcurementNavigation) => ReactElement): string {
  function Document() { return content(useProcurementNavigation()); }
  return renderToStaticMarkup(createElement(Router, { ssrPath: "/purchase-orders/17", ssrSearch: "?tab=lifecycle",
    children: createElement(Document) }));
}
function creditLine() {
  return { id: 91, invoiceLineId: 711, label: "Returned cases", amountCents: 10000,
    disposition: { kind: "quarantine_return" as const, returnDispositionId: 41, quantity: 15, evidenceReference: "RMA-41" },
    sourceEvidence: {}, costState: "posted" as const, costIssues: [], inventoryEffect: fullQuarantineInventoryEffect() };
}

describe("full quarantine cost projection boundary", () => {
  it("requires matching product and packaging outcomes for a completed whole line", () => {
    const line = fullQuarantineCostStatus().lines[0];
    expect(purchaseLineInventoryEffect(line)).toEqual(fullQuarantineInventoryEffect());
    expect(purchaseCostNextAction(line)).toBe("none");
    expect(purchaseLineNeedsCostReview(line)).toBe(false);
    delete line.components[1].inventoryEffect;
    expect(purchaseLineInventoryEffect(line)).toBeNull();
  });
  it("does not combine different component return evidence into a complete return", () => {
    const line = fullQuarantineCostStatus().lines[0];
    line.components[1].inventoryEffect!.returns[0].observationId = 99;
    expect(purchaseLineInventoryEffect(line)).toBeNull();
    expect(purchaseLineCostStatusSchema.safeParse(line).success).toBe(false);
  });
  it.each([
    { status: "pending" }, { status: "review_required" }, { sourceEvidence: "estimated" },
    { sourceCurrent: false }, { sourceRevisionId: null }, { applicationId: null },
    { issues: [{ code: "COST_REVIEW", message: "Reporting proof requires review." }] },
    { historicalPosting: { destination: "historical_cogs", amountMills: 100 } },
  ])("rejects no-inventory completion with conflicting component evidence %j", override => {
    const component = fullQuarantineCostStatus().lines[0].components[0];
    expect(purchaseCostComponentStatusSchema.safeParse({ ...component, ...override }).success).toBe(false);
  });
  it("retains a valid posted supplier-credit return with its exact line identity", () => {
    expect(supplierCreditLineSchema.parse(creditLine()).inventoryEffect).toEqual(fullQuarantineInventoryEffect());
  });
  it.each([
    { id: 92 }, { costState: "pending" }, { costIssues: [{ code: "COST_REVIEW", message: "Review evidence." }] },
    { disposition: { kind: "price_reduction", component: "product" } },
    { disposition: { kind: "quarantine_return", returnDispositionId: 42, quantity: 15, evidenceReference: "RMA-42" } },
    { disposition: { kind: "quarantine_return", returnDispositionId: 41, quantity: 14, evidenceReference: "RMA-41" } },
  ])("rejects a credit no-inventory claim with mismatched evidence %j", override => {
    expect(supplierCreditLineSchema.safeParse({ ...creditLine(), ...override }).success).toBe(false);
  });
  it("never gives a draft or voided credit a current no-inventory completion", () => {
    for (const status of ["draft", "voided"]) {
      expect(supplierCreditDetailSchema.safeParse(supplierCreditFixture({ status: status as "draft" | "voided",
        balanceState: status as "draft" | "voided", unappliedAmountCents: 0, lines: [creditLine()] })).success).toBe(false);
    }
  });
  it("keeps ordinary posted or mixed credit lines distinct from an all-return outcome", () => {
    const credit = supplierCreditFixture({ lines: [creditLine()] });
    expect(supplierCreditCostSummary(credit)).toBe(noInventoryEffectLabel);
    credit.lines.push({ ...supplierCreditFixture().lines[0], id: 92 });
    expect(supplierCreditCostSummary(credit)).toBe("posted");
    expect(supplierCreditCostSummary(supplierCreditFixture())).toBe("posted");
  });
});

describe("full quarantine real cost rendering", () => {
  it("shows the verified zero effect and a view-only invoice link in the reusable supplier review", () => {
    const markup = render(navigation => createElement(PurchaseSupplierCostReview, { status: fullQuarantineCostStatus(), navigation }));
    expect(markup).toContain(noInventoryEffectLabel);
    expect(markup).toContain("All 150 base pieces were returned before acceptance.");
    expect(markup).toContain("Return and receipt evidence");
    expect(markup).toContain("No inventory change");
    expect(markup).not.toContain("costLine=");
    expect(markup).not.toContain("current source and lot history");
    expect(markup).not.toContain("automatic cost retry");
  });
  it("keeps missing proof explicitly in review without a completion label", () => {
    const line = fullQuarantineCostStatus().lines[0];
    for (const component of line.components) {
      delete component.inventoryEffect; component.status = "review_required";
      component.issues = [{ code: "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW", message: "Return reporting proof is missing." }];
    }
    const markup = render(navigation => createElement(PurchaseSupplierCostReview, { status: { lines: [purchaseLineCostStatusSchema.parse(line)] }, navigation }));
    expect(markup).toContain("Return reporting proof is missing.");
    expect(markup).toContain("no automatic cost retry");
    expect(markup).not.toContain(noInventoryEffectLabel);
  });
  it("renders recorded return quantity and verified application without unknown-denominator or lot-posting claims", () => {
    const data = fullQuarantineWorkspace();
    const markup = render(navigation => createElement(PurchaseCostApplications, { history: data.costTrace!.applicationHistory!, data, navigation }));
    expect(markup).toContain(noInventoryEffectLabel);
    expect(markup).toContain("All 150 base pieces returned before acceptance; zero remaining source quantity");
    expect(markup).toContain("The verified return disposition required no inventory or sold-cost changes.");
    expect(markup).toContain("Internal reporting event #41");
    expect(markup).not.toContain("Quantity basis unknown");
    expect(markup).not.toContain("Applied to captured lots");
    expect(markup).toContain("/supplier-credits/9");
  });
  it("source-only return evidence never certifies an unverified application", () => {
    const data = fullQuarantineWorkspace();
    const application = data.costTrace!.applicationHistory!.revisions[0].applications[0];
    delete application.inventoryEffect; application.status = "review_required"; application.evidenceState = "review_required";
    application.issues = [{ code: "COST_APPLICATION_REVIEW", message: "Saved result is not verified." }];
    const markup = render(navigation => createElement(PurchaseCostApplications, { history: data.costTrace!.applicationHistory!, data, navigation }));
    expect(markup).toContain("zero remaining source quantity");
    expect(markup).toContain("Review required");
    expect(markup).not.toContain(noInventoryEffectLabel);
  });
  it("preserves an earlier failed receipt attempt after verified return completion without offering another apply", () => {
    const data = fullQuarantineWorkspace();
    const markup = render(navigation => createElement(PurchaseReceiptCostQueue, { requests: data.costTrace!.receiptCostRequests!, data, navigation,
      actions: { canRetry: true, pendingReceiptId: null, message: null, error: null, onRetry: () => { throw Error("No write during rendering."); } } }));
    expect(markup).toContain("Return cost review completed");
    expect(markup).toContain("Original return evidence required review.");
    expect(markup).toContain("without changing inventory or sold costs");
    expect(markup).not.toContain("Apply current supplier costs");
    expect(markup).not.toContain("Current supplier costs posted");
  });
});

describe("whole-line return evidence consistency", () => {
  it("rejects a no-inventory completion carrying an inventory lot", () => {
    const line = fullQuarantineCostStatus().lines[0];
    line.lots.push({ id: 901, lotNumber: "LOT-901", onHandUnits: 1, shipmentId: null, provisional: false, origin: "receipt" });
    expect(purchaseLineCostStatusSchema.safeParse(line).success).toBe(false);
  });
  it("allows a partial verified component without claiming whole-line completion", () => {
    const line = fullQuarantineCostStatus().lines[0];
    delete line.components[1].inventoryEffect; line.components[1].status = "pending";
    line.components[1].applicationId = null;
    expect(purchaseLineCostStatusSchema.safeParse(line).success).toBe(true);
    expect(purchaseLineInventoryEffect(line)).toBeNull();
    expect(purchaseLineNeedsCostReview(line)).toBe(true);
  });
  it("reports malformed nested return quantities instead of throwing during validation", () => {
    const line = fullQuarantineCostStatus().lines[0]; line.components[0].inventoryEffect!.returns[0].quantity = NaN;
    expect(purchaseLineCostStatusSchema.safeParse(line).success).toBe(false);
  });
});
