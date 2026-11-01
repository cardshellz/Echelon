import { describe, expect, it } from "vitest";
import { costFingerprint } from "../../../inventory/domain/cost-fingerprint";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { retainEquivalentPurchaseCostSource } from "../../domain/purchase-cost-source-identity";
import type { CostSourceProposal } from "../../domain/cost-source-compatibility";
import type { PurchaseCostSource } from "../../purchase-cost-source.repository";

function source(): PurchaseCostSource {
  return {
    purchaseOrderLine: { id: 2, purchase_order_id: 1, line_type: "product", currency: "USD", status: "received",
      order_qty: 100, received_qty: 100, total_product_cost_cents: "90000", packaging_cost_cents: "10000", discount_cents: 0, tax_cents: 0 },
    approvedInvoices: [{ id: 8, vendor_invoice_id: 9, qty_invoiced: 100, line_total_cents: "120000", currency: "USD",
      cost_component_evidence: { contractVersion: 1, packagingTreatment: "separate", productMills: 11_000_000,
        packagingMills: 1_000_000, adjustmentMills: 0, source: "operator_review" } }],
  };
}
function proposal(evidence = source(), component: "product" | "packaging" = "product"): CostSourceProposal {
  return { input: resolvePurchaseCostSource(evidence).find(row => row.component === component)!, sourceEvidence: evidence };
}
function saved(value: CostSourceProposal) {
  const fingerprint = costFingerprint(value);
  return { contract: { ...value.input, revision: 7, fingerprint }, fingerprint, source_evidence: value.sourceEvidence };
}

describe("confirmed supplier source compatibility", () => {
  for (const component of ["product", "packaging"] as const) {
    it.each(["total_product_cost_cents", "packaging_cost_cents", "tax_cents", "discount_cents"])(
      `retains the original ${component} revision after changing an unused PO %s`, field => {
        const previous = proposal(source(), component), original = saved(previous), currentSource = source();
        currentSource.purchaseOrderLine[field] = "12345";
        const current = proposal(currentSource, component), before = structuredClone({ current, original });
        const retained = retainEquivalentPurchaseCostSource(current, original);
        expect(retained).toEqual(previous);
        expect(costFingerprint(retained)).toBe(original.fingerprint);
        expect({ current, original }).toEqual(before);
      },
    );
  }

  it("retains the invoice basis when only a received PO's unselected ordered quantity changes", () => {
    const currentSource = source(); currentSource.purchaseOrderLine.order_qty = 200;
    expect(retainEquivalentPurchaseCostSource(proposal(currentSource), saved(proposal()))).toEqual(proposal());
  });

  it("does not replace a changed received denominator with the old cost basis", () => {
    const currentSource = source(); currentSource.purchaseOrderLine.received_qty = 101;
    const current = proposal(currentSource);
    expect(current.input.evidence).toBe("review_required");
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it("does not ignore an ordered denominator that still determines invoice coverage", () => {
    const oldSource = source(); oldSource.purchaseOrderLine.status = "open";
    const currentSource = source(); currentSource.purchaseOrderLine.status = "open"; currentSource.purchaseOrderLine.order_qty = 101;
    const current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal(oldSource)))).toBe(current);
  });

  it.each(["approved", "partially_paid", "paid"])("preserves captured approval authority through %s", status => {
    const oldSource = source(), currentSource = source();
    oldSource.approvedInvoices[0].status = "approved"; currentSource.approvedInvoices[0].status = status;
    const previous = proposal(oldSource);
    expect(retainEquivalentPurchaseCostSource(proposal(currentSource), saved(previous))).toEqual(previous);
  });

  it.each(["draft", "received", "disputed", "voided", "unsupported"])("never normalizes %s into confirmed invoice authority", status => {
    const currentSource = source(); currentSource.approvedInvoices[0].status = status;
    const current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it("does not infer a new receipt allocation policy for existing multi-invoice postings", () => {
    const oldSource = source(); oldSource.approvedInvoices[0].qty_invoiced = 50;
    oldSource.approvedInvoices.push({ ...structuredClone(oldSource.approvedInvoices[0]), id: 10, vendor_invoice_id: 11, qty_invoiced: 50 });
    const currentSource = structuredClone(oldSource); currentSource.purchaseOrderLine.total_product_cost_cents = "999";
    const previous = proposal(oldSource), current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(previous))).toEqual(previous);
  });

  it("keeps a still-selected provisional quote authoritative when it changes", () => {
    const oldSource = source(); oldSource.approvedInvoices = [];
    const currentSource = structuredClone(oldSource); currentSource.purchaseOrderLine.total_product_cost_cents = "999";
    const current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal(oldSource)))).toBe(current);
  });

  it.each(["missing_split", "adjustment", "different_amount", "quantity", "invoice_source", "currency"])(
    "refuses changed or unsupported supplier %s evidence", kind => {
      const currentSource = source();
      const invoice = currentSource.approvedInvoices[0];
      if (kind === "missing_split") invoice.cost_component_evidence = null;
      if (kind === "adjustment") invoice.cost_component_evidence = { ...(invoice.cost_component_evidence as object), adjustmentMills: 100 };
      if (kind === "different_amount") {
        invoice.line_total_cents = "120001";
        invoice.cost_component_evidence = { ...(invoice.cost_component_evidence as object), productMills: 11_000_100 };
      }
      if (kind === "quantity") invoice.qty_invoiced = 99;
      if (kind === "invoice_source") invoice.id = 80;
      if (kind === "currency") invoice.currency = "CAD";
      const current = proposal(currentSource);
      expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
    },
  );

  it.each(["root", "line", "invoice"])("preserves unknown %s fields as significant evidence", place => {
    const currentSource = source();
    if (place === "root") Object.assign(currentSource, { new_evidence: null });
    if (place === "line") currentSource.purchaseOrderLine.new_evidence = null;
    if (place === "invoice") currentSource.approvedInvoices[0].new_evidence = null;
    const current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it.each(["root", "line"])("preserves unknown prototype-named %s evidence instead of dropping it during validation", place => {
    const currentSource = source();
    Object.defineProperty(place === "root" ? currentSource : currentSource.purchaseOrderLine, "__proto__", {
      enumerable: true, value: { unrecognized: true },
    });
    const current = proposal(currentSource);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it("treats an explicitly empty credit list as no credit without accepting real credit evidence", () => {
    const currentSource = source(); currentSource.supplierCredits = [];
    expect(retainEquivalentPurchaseCostSource(proposal(currentSource), saved(proposal()))).toEqual(proposal());
    const current = proposal(); (current.sourceEvidence as Record<string, unknown>).supplierCredits = [{ id: 1 }];
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it.each(["fingerprint", "contract", "evidence"])("refuses a damaged immutable %s", field => {
    const current = proposal(), original = saved(proposal());
    if (field === "fingerprint") original.fingerprint = "b".repeat(64);
    if (field === "contract") original.contract.totalMills = 1;
    if (field === "evidence") original.source_evidence = null;
    expect(retainEquivalentPurchaseCostSource(current, original)).toBe(current);
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, "bad", "9007199254740991"])(
    "refuses unprovable captured amounts %s without throwing a BigInt error", value => {
      const previous = proposal();
      (previous.sourceEvidence as PurchaseCostSource).purchaseOrderLine.total_product_cost_cents = value;
      const current = proposal();
      expect(retainEquivalentPurchaseCostSource(current, saved(previous))).toBe(current);
    },
  );

  it("requires source versions to describe the captured invoice", () => {
    const current = proposal(); current.input.sources[0].version = "b".repeat(64);
    expect(retainEquivalentPurchaseCostSource(current, saved(proposal()))).toBe(current);
  });

  it("keeps a new financial source when there is no previous revision", () => {
    const current = proposal(); expect(retainEquivalentPurchaseCostSource(current, undefined)).toBe(current);
  });

  it("preserves an explicit zero-cost approved invoice without falling back to the quote", () => {
    const oldSource = source(); oldSource.approvedInvoices[0].line_total_cents = "0";
    oldSource.approvedInvoices[0].cost_component_evidence = { contractVersion: 1, packagingTreatment: "separate",
      productMills: 0, packagingMills: 0, adjustmentMills: 0, source: "operator_review" };
    const previous = proposal(oldSource), currentSource = structuredClone(oldSource);
    currentSource.purchaseOrderLine.total_product_cost_cents = "99999";
    const retained = retainEquivalentPurchaseCostSource(proposal(currentSource), saved(previous));
    expect(retained).toEqual(previous);
    expect(retained.input.totalMills).toBe(0);
  });

  it.each([0, -1, 1.5, "bad"])("rejects invalid captured quantity %s without throwing during proof", value => {
    const previous = proposal(), current = proposal();
    (previous.sourceEvidence as PurchaseCostSource).purchaseOrderLine.order_qty = value;
    expect(retainEquivalentPurchaseCostSource(current, saved(previous))).toBe(current);
  });

  it("refuses a cyclic snapshot as proof of an immutable posting", () => {
    const current = proposal(), original = saved(proposal());
    const cycle: Record<string, unknown> = {}; cycle.nested = cycle;
    original.source_evidence = cycle;
    expect(retainEquivalentPurchaseCostSource(current, original)).toBe(current);
  });
});
