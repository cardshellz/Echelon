import React, { type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { procurementListChildHref } from "@/lib/procurement-navigation";

export interface SupplierCreditContext {
  sourceInvoiceId?: number;
  inboundShipmentId?: number;
  purchaseOrderId?: number;
  returnDispositionId?: number;
  create?: boolean;
  replacesCreditId?: number;
}
/** Source identifiers guide selection; the credit owner must verify every link. */
export function supplierCreditHref(context: SupplierCreditContext, path = "", search = ""): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(context)) {
    if (key === "create") { if (value) params.set("new", "1"); }
    else if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) params.set(key === "sourceInvoiceId" && !context.create ? "invoiceId" : key, String(value));
  }
  return procurementListChildHref(path, search, `/supplier-credits${params.size ? `?${params}` : ""}`);
}
export function SupplierCreditLink({ children = "Review supplier credits", ...context }: SupplierCreditContext & { children?: ReactNode }) {
  const [path] = useLocation();
  const search = useSearch();
  return <Link className="text-sm text-primary underline underline-offset-4" href={supplierCreditHref(context, path, search)}>{children}
  </Link>;
}
