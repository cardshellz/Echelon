import { describe, expect, it } from "vitest";
import {
  projectPurchaseComponentStatus,
  type CurrentPurchaseComponentEvidence,
} from "../../domain/purchase-cost-status";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import {
  projectReceiptCostQueue,
  type ReceiptCostQueueRead,
} from "../../receipt-cost-queue-read.service";
import {
  purchaseCostNextAction,
  type PurchaseLineCostStatus,
} from "@shared/procurement/purchase-cost-status";
import { landedCostHealthHref } from "@shared/procurement/landed-cost-health";

function evidence(): CurrentPurchaseComponentEvidence {
  const input: CurrentPurchaseComponentEvidence["input"] = {
    contractVersion: 1,
    component: "product",
    scope: {
      kind: "purchase_order_line",
      purchaseOrderId: 17,
      purchaseOrderLineId: 171,
    },
    sources: [
      {
        kind: "vendor_invoice_line",
        documentId: 71,
        lineId: 711,
        version: "b".repeat(64),
      },
    ],
    currency: "USD",
    totalMills: 2000,
    basePieces: 10,
    evidence: "confirmed",
    packagingTreatment: "separate",
    issue: null,
    manualOverride: null,
  };
  return {
    input,
    currentFingerprint: "a".repeat(64),
    revision: {
      id: 11,
      contract: { ...input, revision: 1, fingerprint: "a".repeat(64) },
    },
    application: {
      id: 21,
      status: "applied",
      reportingVerified: true,
      evidence: {
        lotIds: [901],
        result: { status: "applied", lotsUpdated: 1, issues: [] },
      },
    },
    lotIds: [901],
    unprovenLotIds: [],
    changedLots: [{ lotId: 901, component: "product", amountMatches: true }],
  };
}
function line(): PurchaseLineCostStatus {
  const product = projectPurchaseComponentStatus(evidence());
  return {
    purchaseOrderId: 17,
    purchaseOrderLineId: 171,
    sku: "SKU",
    components: [product, { ...product, component: "packaging" }],
    invoices: [
      { invoiceId: 71, invoiceNumber: "INV-71", lineId: 711, lineNumber: 1 },
    ],
    receipts: [],
    lots: [],
  };
}
describe("current supplier and receipt cost authority", () => {
  it("requires current source, complete lot coverage, component balances and reporting evidence", () => {
    const input = evidence(),
      before = structuredClone(input);
    expect(projectPurchaseComponentStatus(input)).toMatchObject({
      status: "applied",
      sourceCurrent: true,
    });
    expect(input).toEqual(before);
  });
  it.each([
    "changed_source",
    "new_descendant",
    "missing_snapshot",
    "changed_amount",
    "missing_event",
    "unproven_origin",
    "invalid_result",
  ])("keeps %s actionable", (kind) => {
    const input = evidence();
    if (kind === "changed_source") input.currentFingerprint = "c".repeat(64);
    if (kind === "new_descendant") input.lotIds = [901, 902];
    if (kind === "missing_snapshot") input.changedLots = [];
    if (kind === "changed_amount") input.changedLots[0].amountMatches = false;
    if (kind === "missing_event") input.application!.reportingVerified = false;
    if (kind === "unproven_origin") input.unprovenLotIds = [1453];
    if (kind === "invalid_result") input.application!.evidence = {};
    expect(projectPurchaseComponentStatus(input).status).not.toBe("applied");
  });
  it("does not use a landed-cost success to prove product costs", () => {
    const input = evidence();
    input.changedLots[0].component = "landed";
    expect(projectPurchaseComponentStatus(input).status).toBe(
      "review_required",
    );
  });
  it("separates posted estimates from supplier confirmation", () => {
    const current = line();
    current.components = current.components.map((component) => ({
      ...component,
      sourceEvidence: "estimated",
    }));
    expect(purchaseCostNextAction(current)).toBe("invoice");
    expect(
      current.components.every((component) => component.status === "applied"),
    ).toBe(true);
  });
  it("keeps history issues actionable after supplier evidence is supplied", () => {
    const current = line();
    current.components[0] = projectPurchaseComponentStatus({
      ...evidence(),
      unprovenLotIds: [1453],
    });
    expect(purchaseCostNextAction(current)).toBe("history");
  });
  it("uses a later supplier application for current receipt status without rewriting its old attempt", () => {
    const queue: ReceiptCostQueueRead = {
      requests: [
        {
          id: 1,
          receiptId: 31,
          receiptStatus: "closed",
          purchaseOrderLineId: 171,
          requestedBy: "receiver",
          requestedAt: "2026-10-01T00:00:00Z",
        },
      ],
      attempts: [
        {
          id: 2,
          requestId: 1,
          state: "review_required",
          summary: {
            requestId: 1,
            purchaseOrderLineId: 171,
            state: "review_required",
            attemptRecorded: true,
            issues: [
              {
                code: "INVOICE_COMPONENT_REVIEW_REQUIRED",
                message: "Missing supplier amounts.",
              },
            ],
          },
          applications: [],
          recordedBy: "receiver",
          recordedAt: "2026-10-01T00:00:00Z",
        },
      ],
    };
    const before = structuredClone(queue);
    const current = line();
    expect(
      projectReceiptCostQueue(queue, new Map(), { lines: [current] })[0],
    ).toMatchObject({
      state: "applied",
      recordedState: "review_required",
      attempts: [
        {
          state: "review_required",
          issues: [{ code: "INVOICE_COMPONENT_REVIEW_REQUIRED" }],
        },
      ],
    });
    current.components[0].status = "review_required";
    expect(
      projectReceiptCostQueue(queue, new Map(), { lines: [current] })[0].state,
    ).toBe("review_required");
    expect(queue).toEqual(before);
    expect(() =>
      projectReceiptCostQueue(queue, new Map(), { lines: [] }),
    ).toThrow("Current supplier cost status is missing");
  });
  it("routes health warnings into the cost workspace", () => {
    expect(
      landedCostHealthHref({
        id: "x",
        shipmentId: 92,
        shipmentNumber: null,
        shipmentStatus: "closed",
        type: "provisional_other_costs",
        severity: "warning",
        detail: "Supplier amounts missing",
        action: "review_cost_evidence",
      }),
    ).toBe("/shipments/92?tab=allocation#supplier-cost-review");
  });
});

describe("shared supplier source decision", () => {
  const source = {
    purchaseOrderLine: {
      id: 171,
      purchase_order_id: 17,
      order_qty: 10,
      received_qty: 10,
      status: "received",
      total_product_cost_cents: 200,
      packaging_cost_cents: 10,
      currency: "USD",
      discount_cents: 0,
      tax_cents: 0,
    },
    approvedInvoices: [] as Record<string, unknown>[],
  };
  it("uses exact quote estimates when no approved invoice exists", () => {
    expect(resolvePurchaseCostSource(source)).toMatchObject([
      { component: "product", totalMills: 20000, evidence: "estimated" },
      { component: "packaging", totalMills: 1000, evidence: "estimated" },
    ]);
  });
  it("does not invent a component split from an approved invoice total", () => {
    const result = resolvePurchaseCostSource({
      ...source,
      approvedInvoices: [
        {
          id: 711,
          vendor_invoice_id: 71,
          qty_invoiced: 10,
          line_total_cents: 210,
          currency: "USD",
        },
      ],
    });
    expect(
      result.every(
        (component) =>
          component.evidence === "review_required" &&
          component.issue?.code === "INVOICE_COMPONENT_REVIEW_REQUIRED",
      ),
    ).toBe(true);
  });
});
