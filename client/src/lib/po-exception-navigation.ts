import type { PoException } from "@shared/schema/procurement.schema";

export type PoExceptionNavigationSource = Pick<PoException, "poId" | "kind" | "payload">;

export interface PoExceptionLinks {
  purchaseOrderHref: string;
  invoiceHref: string | null;
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Build internal links from stored record IDs, never from titles or invoice numbers. */
export function getPoExceptionLinks(
  exception: PoExceptionNavigationSource,
  purchaseOrderId: number | null,
): PoExceptionLinks | null {
  if (!isPositiveId(purchaseOrderId) || exception.poId !== purchaseOrderId) return null;

  const payload = exception.payload;
  const invoiceId = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).invoiceId
    : null;

  return {
    purchaseOrderHref: `/purchase-orders/${purchaseOrderId}?tab=lines`,
    // Legacy/manual exceptions can lack an invoice reference. Keep the PO link
    // available instead of guessing a record from the displayed invoice number.
    invoiceHref: exception.kind === "match_mismatch" && isPositiveId(invoiceId)
      ? `/ap-invoices/${invoiceId}?tab=lines`
      : null,
  };
}
