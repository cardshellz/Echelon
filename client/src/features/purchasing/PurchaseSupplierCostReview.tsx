import { Link } from "wouter";
import type {
  PurchaseCostStatus,
  PurchaseLineCostStatus,
} from "@shared/procurement/purchase-cost-status";
import {
  purchaseCostNextAction,
  purchaseLineNeedsCostReview,
} from "@shared/procurement/purchase-cost-status";
import type { ProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Badge } from "@/components/ui/badge";

export function PurchaseSupplierCostLine({
  line,
  navigation,
}: {
  line: PurchaseLineCostStatus;
  navigation: ProcurementNavigation;
}) {
  const action = purchaseCostNextAction(line);
  const issues = [
    ...new Map(
      line.components
        .flatMap((component) => component.issues)
        .map((issue) => [issue.message, issue]),
    ).values(),
  ];
  return (
    <div
      className="space-y-2 rounded-md border p-3"
      data-testid={`supplier-cost-line-${line.purchaseOrderLineId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="break-all">
          {line.sku ?? `PO line #${line.purchaseOrderLineId}`}
        </strong>
        {line.components.map((component) => (
          <Badge key={component.component} variant="outline">
            {component.component === "product" ? "Product" : "Packaging"}:{" "}
            {component.status === "applied"
              ? component.sourceEvidence === "confirmed"
                ? "Posted"
                : "Estimate posted"
              : component.status === "pending"
                ? "Not posted"
                : "Needs review"}
          </Badge>
        ))}
      </div>
      {action === "invoice" && (
        <p>
          Confirm the product and packaging amounts on the supplier invoice.
          Saving that review applies the costs to linked stock and sold items.
          Freight and duty approvals do not supply these amounts.
        </p>
      )}
      {action === "history" && (
        <p>
          The supplier amounts are recorded, but some receipt or stock history
          is missing. Review the affected lots and receipts below before
          applying costs again. No shipment-charge approval can replace this
          product or packaging evidence.
        </p>
      )}
      {action === "apply" && (
        <p>
          The current supplier costs still need to be applied. Open the receipt
          cost processing section to retry and review its saved result.
        </p>
      )}
      {action === "none" && (
        <p className="text-green-700 dark:text-green-400">
          Product and packaging costs are posted for the current source and lot
          history.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {line.invoices.map((invoice) => {
          const href = navigation.childHref(
            `/ap-invoices/${invoice.invoiceId}?tab=lines`,
            { invoiceCostLineId: invoice.lineId },
          );
          return (
            <Link
              key={invoice.lineId}
              href={href}
              className="text-primary underline underline-offset-4"
            >
              {action === "none" ? "View" : "Review"} invoice{" "}
              {invoice.invoiceNumber} · line {invoice.lineNumber}
            </Link>
          );
        })}
        {line.invoices.length === 0 && (
          <Link
            className="text-primary underline underline-offset-4"
            href={navigation.childHref(
              `/purchase-orders/${line.purchaseOrderId}?tab=invoices`,
            )}
          >
            Record supplier invoice
          </Link>
        )}
        {action === "apply" && (
          <Link
            className="text-primary underline underline-offset-4"
            href={navigation.childHref(
              `/purchase-orders/${line.purchaseOrderId}?tab=lifecycle`,
            )}
          >
            Open receipt cost processing
          </Link>
        )}
      </div>
      {issues.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            Current reasons ({issues.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {issues.map((issue) => (
              <li key={issue.message}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
      <details open={action === "history"}>
        <summary className="cursor-pointer">
          Affected lot history ({line.lots.length})
        </summary>
        <ul className="mt-2 space-y-2">
          {line.lots.map((lot) => (
            <li key={lot.id}>
              <strong>{lot.lotNumber}</strong> · #{lot.id} ·{" "}
              {lot.onHandUnits.toLocaleString()} units on hand ·{" "}
              {lot.origin === "receipt"
                ? "Receipt source recorded"
                : lot.origin === "transformation"
                  ? "Transfer / conversion source recorded"
                  : "Receipt / conversion source missing"}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-3">
          {line.receipts.map((receipt) => (
            <Link
              key={receipt.receiptId}
              className="text-primary underline underline-offset-4"
              href={navigation.childHref(
                `/receiving?open=${receipt.receiptId}`,
              )}
            >
              Review receipt {receipt.receiptNumber}
            </Link>
          ))}
        </div>
      </details>
    </div>
  );
}

export function PurchaseSupplierCostReview({
  status,
  navigation,
}: {
  status: PurchaseCostStatus;
  navigation: ProcurementNavigation;
}) {
  const remaining = status.lines.filter(purchaseLineNeedsCostReview);
  return (
    <section
      id="supplier-cost-review"
      aria-label="Supplier product and packaging costs"
      className="space-y-3 text-sm"
    >
      <h4 className="font-semibold">Supplier product and packaging costs</h4>
      <p>
        {remaining.length
          ? `${remaining.length} PO lines need supplier cost review. Shipment charges have their own posting status.`
          : "Current supplier cost results. Original attempts remain in the audit history."}
      </p>
      {status.lines.map((line) => (
        <PurchaseSupplierCostLine
          key={line.purchaseOrderLineId}
          line={line}
          navigation={navigation}
        />
      ))}
    </section>
  );
}
