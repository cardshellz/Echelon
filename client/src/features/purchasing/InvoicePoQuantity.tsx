import { invoicePoQuantitiesSchema } from "@shared/procurement/invoice-po-quantities";
import React from "react";

function isPieceCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function InvoicePoQuantity({ comparison, recordedQuantity, quantity }: {
  comparison: unknown;
  recordedQuantity: number | null | undefined;
  quantity: "ordered" | "received";
}) {
  if (comparison === undefined) {
    // A cached response from an older server contains only the saved comparison.
    // Keep it visible, but never present that value as verified current PO data.
    return <>
      <span>{isPieceCount(recordedQuantity) ? recordedQuantity.toLocaleString("en-US") : "—"}</span>
      <span className="block text-xs font-normal">Saved on invoice</span>
    </>;
  }
  const parsed = invoicePoQuantitiesSchema.safeParse(comparison);
  if (!parsed.success || parsed.data.status === "unavailable") {
    return <span className="text-xs font-normal">PO comparison unavailable</span>;
  }
  if (parsed.data.status === "unlinked") return <span>—</span>;

  const current = quantity === "ordered" ? parsed.data.orderedQty : parsed.data.receivedQty;
  return <span>{current.toLocaleString("en-US")}</span>;
}
