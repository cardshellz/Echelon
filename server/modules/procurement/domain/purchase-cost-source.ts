import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import {
  costFingerprint,
  costInteger,
} from "../../inventory/infrastructure/cost-evidence-values";
import type { CostRevisionInput } from "../../inventory/infrastructure/cost-evidence.repository";

/** The single product/packaging source decision, shared by posting and reads. */
export function resolvePurchaseCostSource(source: {
  purchaseOrderLine: Record<string, unknown>;
  approvedInvoices: Record<string, unknown>[];
}): CostRevisionInput[] {
  const { purchaseOrderLine: line, approvedInvoices } = source;
  const purchaseOrderLineId = costInteger(line.id, "purchaseOrderLineId", 1);
  const qty = costInteger(line.order_qty, "orderQty", 1);
  const coverageQty = ["received", "closed"].includes(String(line.status))
    ? costInteger(line.received_qty, "receivedQty")
    : qty;
  const approvedQty = approvedInvoices.reduce(
    (sum, row) => sum + BigInt(costInteger(row.qty_invoiced, "qtyInvoiced")),
    BigInt(0),
  );
  const parsed = approvedInvoices.map((row) =>
    invoiceCostComponentEvidenceSchema.safeParse(row.cost_component_evidence),
  );
  let issue: { code: string; message: string } | null = null;
  if (
    approvedInvoices.length > 0 &&
    (coverageQty === 0 ||
      approvedQty !== BigInt(coverageQty) ||
      parsed.some((result) => !result.success))
  ) {
    issue = {
      code: "INVOICE_COMPONENT_REVIEW_REQUIRED",
      message:
        "Approved invoices need complete quantity coverage and explicit product/packaging evidence before replacing the quoted inventory costs.",
    };
  }
  const actual = approvedInvoices.length > 0 && issue === null;
  let productMills = costInteger(
    (
      BigInt(costInteger(line.total_product_cost_cents, "productCostCents")) *
      BigInt(100)
    ).toString(),
    "productMills",
  );
  let packagingMills = costInteger(
    (
      BigInt(costInteger(line.packaging_cost_cents, "packagingCostCents")) *
      BigInt(100)
    ).toString(),
    "packagingMills",
  );
  let packagingTreatment: "separate" | "included_in_product" = "separate";
  if (actual) {
    let product = BigInt(0),
      packaging = BigInt(0);
    for (let index = 0; index < parsed.length; index++) {
      const evidence = parsed[index];
      if (!evidence.success)
        throw new Error("Validated invoice evidence changed in memory");
      const components = evidence.data;
      const total =
        BigInt(components.productMills) +
        BigInt(components.packagingMills) +
        BigInt(components.adjustmentMills);
      if (
        total !==
          BigInt(
            costInteger(
              approvedInvoices[index].line_total_cents,
              "invoice.lineTotalCents",
            ),
          ) *
            BigInt(100) ||
        components.adjustmentMills !== 0 ||
        (components.packagingTreatment === "included_in_product" &&
          components.packagingMills !== 0)
      ) {
        issue = {
          code: "INVOICE_COMPONENT_TOTAL_REVIEW",
          message:
            "The recorded invoice components do not have a supported, exact reconciliation to the document total.",
        };
      }
      product += BigInt(components.productMills);
      packaging += BigInt(components.packagingMills);
      if (components.packagingTreatment === "included_in_product")
        packagingTreatment = "included_in_product";
    }
    productMills = costInteger(product.toString(), "invoice.productMills");
    packagingMills = costInteger(
      packaging.toString(),
      "invoice.packagingMills",
    );
  } else if (
    costInteger(line.discount_cents ?? 0, "discountCents") !== 0 ||
    costInteger(line.tax_cents ?? 0, "taxCents") !== 0
  ) {
    issue ??= {
      code: "PURCHASE_ADJUSTMENT_REVIEW",
      message:
        "The purchase has a discount or tax requiring an explicit cost component disposition.",
    };
  }
  const currency = actual
    ? approvedInvoices.every((row) => row.currency === "USD")
      ? "USD"
      : null
    : line.currency === "USD"
      ? "USD"
      : null;
  const sources = actual
    ? approvedInvoices.map((row) => ({
        kind: "vendor_invoice_line" as const,
        documentId: costInteger(row.vendor_invoice_id, "invoiceId", 1),
        lineId: costInteger(row.id, "invoiceLineId", 1),
        version: costFingerprint(row),
      }))
    : [
        {
          kind: "purchase_order_line" as const,
          documentId: costInteger(line.purchase_order_id, "purchaseOrderId", 1),
          lineId: purchaseOrderLineId,
          version: costFingerprint(line),
        },
      ];
  return (
    [
      ["product", productMills],
      ["packaging", packagingMills],
    ] as const
  ).map(([component, amount]) => ({
    contractVersion: 1,
    component,
    scope: {
      kind: "purchase_order_line",
      purchaseOrderId: costInteger(
        line.purchase_order_id,
        "purchaseOrderId",
        1,
      ),
      purchaseOrderLineId,
    },
    sources,
    currency,
    totalMills: costInteger(amount, "amount"),
    basePieces: actual ? coverageQty : qty,
    evidence: issue ? "review_required" : actual ? "confirmed" : "estimated",
    packagingTreatment,
    issue,
    manualOverride: null,
  }));
}
